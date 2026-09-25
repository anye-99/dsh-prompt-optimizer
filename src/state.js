/**
 * state — 会话级状态与设置的磁盘单轨存储（与 graded 同约定）。
 *
 * 磁盘单轨（无内存副本）：注入判定与命令写入读同一份快照，
 * 热重载/重启天然恢复，杜绝"内存说注过了、磁盘说没注"的双注根因。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_DSH_HOME = () => join(homedir(), '.dsh')

export function homeDir() {
  return process.env.DSH_HOME || DEFAULT_DSH_HOME()
}
export function stateDirFor() {
  return join(homeDir(), 'prompt-optimizer')
}
export function settingsFile() {
  return join(homeDir(), 'prompt-optimizer-settings.json')
}
function sidFile(sid) {
  return join(stateDirFor(), String(sid || '').replace(/[^a-zA-Z0-9-]/g, '_') + '.json')
}

/** 全局默认设置（会话可覆盖）。 */
export const DEFAULT_SETTINGS = {
  level: 'full',      // off | lite | full
  minLen: 12,         // 短于此长度不视为"含糊"（避免对短句加戏）
  cooldownTurns: 0,   // >0 时：连续提示后强制静默 N 轮，防唠叨
}

/** 会话状态（内存对象；level/minLen 由设置解析后注入）。 */
export function initState() {
  return {
    enabled: true,          // 本会话是否启用（/optimize off 关闭）
    asked: [],              // 已提示过的去重键（上限截断，见 noteAsked）
    count: 0,               // 本会话累计注入次数
    skipped: 0,             // 本会话累计跳过次数（清晰/trivial——审计用）
    lastTurn: -1,           // 最近一次提示所在轮次（冷却用）
    turn: 0,                // 本会话已观察轮次
  }
}

export function loadState(sid) {
  try {
    const f = sidFile(sid)
    if (!existsSync(f)) return null
    const o = JSON.parse(readFileSync(f, 'utf-8'))
    if (!o || typeof o !== 'object') return null
    return {
      ...initState(),
      enabled: o.enabled !== false,
      asked: Array.isArray(o.asked) ? o.asked.slice(-200) : [],
      count: Number(o.count) || 0,
      skipped: Number(o.skipped) || 0,
      lastTurn: Number.isInteger(o.lastTurn) ? o.lastTurn : -1,
      turn: Number(o.turn) || 0,
    }
  } catch {
    return null
  }
}

export function saveState(sid, s) {
  try {
    mkdirSync(stateDirFor(), { recursive: true })
    writeFileSync(sidFile(sid), JSON.stringify({
      enabled: s.enabled !== false,
      asked: (s.asked || []).slice(-200),
      count: s.count || 0,
      skipped: s.skipped || 0,
      lastTurn: s.lastTurn ?? -1,
      turn: s.turn || 0,
    }), 'utf-8')
    return true
  } catch (e) {
    console.warn('[prompt-optimizer] saveState failed:', sid, e?.message || e)
    return false
  }
}

/** 最近活跃的已启用会话（面板/审计端点用；mtime 降序，跳过已关闭会话）。 */
export function latestSid() {
  try {
    const dir = stateDirFor()
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, 200)
    let best = null, bestM = -1
    for (const f of files) {
      const id = f.replace(/\.json$/, '')
      const st = loadState(id)
      if (!st || !st.enabled) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (m > bestM) { bestM = m; best = id }
    }
    return best
  } catch { return null }
}

/* ---------------- 设置：全局 + 会话覆盖 ---------------- */

export function loadGlobalSettings() {
  try {
    const o = JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    return {
      level: ['off', 'lite', 'full'].includes(o?.level) ? o.level : DEFAULT_SETTINGS.level,
      minLen: Number.isInteger(o?.minLen) ? Math.max(4, Math.min(200, o.minLen)) : DEFAULT_SETTINGS.minLen,
      cooldownTurns: Number.isInteger(o?.cooldownTurns) ? Math.max(0, Math.min(20, o.cooldownTurns)) : DEFAULT_SETTINGS.cooldownTurns,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 会话级设置文件（与运行状态分开：状态高频写，设置低频写）。 */
function sessionSettingsFile(sid) {
  return join(stateDirFor(), String(sid || '').replace(/[^a-zA-Z0-9-]/g, '_') + '.settings.json')
}

export function loadSessionSettings(sid) {
  try {
    const o = JSON.parse(readFileSync(sessionSettingsFile(sid), 'utf-8'))
    return (o && typeof o === 'object') ? o : {}
  } catch { return {} }
}

/** 解析生效设置：会话覆盖 > 全局 > 默认。 */
export function settingsFor(sid) {
  const g = loadGlobalSettings()
  const s = loadSessionSettings(sid)
  return {
    global: g,
    session: s,
    level: ['off', 'lite', 'full'].includes(s.level) ? s.level : g.level,
    minLen: Number.isInteger(s.minLen) ? s.minLen : g.minLen,
    cooldownTurns: Number.isInteger(s.cooldownTurns) ? s.cooldownTurns : g.cooldownTurns,
  }
}

export function validPatch(patch) {
  if (!patch || typeof patch !== 'object') return 'body 须为对象'
  if (patch.level !== undefined && !['off', 'lite', 'full'].includes(patch.level)) return 'level 须为 off|lite|full'
  if (patch.minLen !== undefined && (!Number.isInteger(patch.minLen) || patch.minLen < 4 || patch.minLen > 200)) return 'minLen 须为 4-200 整数'
  if (patch.cooldownTurns !== undefined && (!Number.isInteger(patch.cooldownTurns) || patch.cooldownTurns < 0 || patch.cooldownTurns > 20)) return 'cooldownTurns 须为 0-20 整数'
  return null
}

export function writeGlobalSettings(patch) {
  const cur = loadGlobalSettings()
  if (patch.level !== undefined) cur.level = patch.level
  if (patch.minLen !== undefined) cur.minLen = patch.minLen
  if (patch.cooldownTurns !== undefined) cur.cooldownTurns = patch.cooldownTurns
  mkdirSync(stateDirFor(), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(cur, null, 2), 'utf-8')
  return cur
}

export function writeSessionSettings(sid, patch) {
  const cur = loadSessionSettings(sid)
  if (patch.level !== undefined) cur.level = patch.level
  if (patch.minLen !== undefined) cur.minLen = patch.minLen
  if (patch.cooldownTurns !== undefined) cur.cooldownTurns = patch.cooldownTurns
  mkdirSync(stateDirFor(), { recursive: true })
  writeFileSync(sessionSettingsFile(sid), JSON.stringify(cur, null, 2), 'utf-8')
  return cur
}
