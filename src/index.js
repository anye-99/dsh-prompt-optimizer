/**
 * dsh-prompt-optimizer — 会话内提示词实时优化器。
 *
 * 做什么：监听用户消息；判定为"含糊提示词"时，在**用户消息之后**近距离注入
 * 一段结构化自查引导，让模型动手前补齐【目的 / 边界 / 验收】三要素。
 *
 * 不做什么（边界即特性）：
 *   - **绝不改写用户原话**——原话原样送达模型；插件只在后面补引导层。
 *   - **不碰 system prompt**——静态引导进 system 才是最优，但"何时开口"是动态的；
 *     动态内容进 system 会让整个会话前缀缓存全量 miss（命中便宜约 10 倍）。
 *     所以：动态判定在前，注入内容恒定 → 注入文本零动态拼接。
 *   - **清晰提示词一律放行**——"看下 package.json""跑测试"不加戏。
 *   - 不注册任何工具（零工具目录开销；本插件是纯引导层）。
 *
 * 通道：`agent/pre-step` Waterfall —— 在 messages 上按角色位插入注入消息，
 * 与 graded 同构（生态验证过的近距离注入通道）。
 */

import { clarityVerdict, classify, buildGuidance, dedupeKey } from './optimize.js'
import { pluginMsg, spliceAfterLastUser, lastUserText, auditBody, validateSource } from './channel.js'
import {
  initState, loadState, saveState, latestSid, settingsFor,
  validPatch, writeGlobalSettings, writeSessionSettings,
} from './state.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-prompt-optimizer'
// 不声明 inject：commands/webServer 是 Host 专属服务，本插件是 Host+Client 双面包、
// 单一入口。Web 端 Loader 会读同一份 inject，但浏览器里没有这两个服务——声明了
// 会让 fiber 永远停在 pending/loading，把整个 web boot 卡死（真 bug，2026-09 实测）。
// 改为在 apply 内防御性取服务（拿不到就静默跳过对应能力），入口在任何端都能激活。
export const Config = z.object({})

// 与 package.json 的 version 保持一致（/optimize status 回执与审计端点都读它）。
// tests/apply.test.mjs 有一条断言盯住二者相等——升版本时别只改 package.json。
const VERSION = '0.2.0'

export function apply(ctx) {
  let activeSid = null

  function state(sid) { return loadState(sid) || initState() }
  function setState(sid, s) { saveState(sid, s) }

  /* ---------------- 设置 API（全局 + 会话覆盖） ---------------- */

  ctx.effect(() => {
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return () => {}
    const d = ctx.webServer.register({
      kind: 'prefix',
      path: '/prompt-optimizer/api/settings',
      handler: async (req, res) => {
        const q = new URL(req.url, 'http://x')
        const sid = q.searchParams.get('sid')
        const json = (o, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(o))
        }
        if (req.method === 'GET') return json({ ok: true, ...settingsFor(sid) })
        if (req.method === 'PUT') {
          let raw = ''
          try { for await (const c of req) raw += c } catch { /* 空体容错 */ }
          let patch
          try { patch = JSON.parse(raw || '{}') } catch { return json({ ok: false, error: 'body 非 JSON' }, 400) }
          const err = validPatch(patch)
          if (err) return json({ ok: false, error: err }, 400)
          try {
            if (patch.scope === 'session' && sid) {
              writeSessionSettings(sid, patch)
              return json({ ok: true, scope: 'session', ...settingsFor(sid) })
            }
            const g = writeGlobalSettings(patch)
            return json({ ok: true, scope: 'global', settings: g })
          } catch (e) {
            return json({ ok: false, error: '写盘失败: ' + (e?.message || e) }, 500)
          }
        }
        return json({ ok: false, error: 'method 仅 GET/PUT' }, 405)
      },
    }, 'prompt-optimizer: settings api')
    return () => d()
  })

  /* ---------------- 审计/状态端点 ---------------- */

  ctx.effect(() => {
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return () => {}
    const d = ctx.webServer.register({
      kind: 'prefix',
      path: '/prompt-optimizer/api',
      handler: async (req, res) => {
        const q = new URL(req.url, 'http://x').searchParams.get('sid')
        const sid = q || activeSid || latestSid()
        const st = sid ? state(sid) : initState()
        const body = JSON.stringify({ ...auditBody(st, settingsFor(sid), VERSION), sid })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      },
    }, 'prompt-optimizer: state api')
    return () => d()
  })

  /* ---------------- 命令：/optimize ---------------- */

  if (ctx.commands && typeof ctx.commands.register === 'function')
  ctx.commands.register({
    name: 'optimize',
    description: '提示词优化器开关与状态：/optimize [on|off|status|lite|full]',
    input: { hint: '[on|off|status|lite|full]' },
    handler: (invocation) => {
      const agent = invocation.agent
      if (!agent?.session?.id) return { kind: 'error', text: 'no agent session' }
      const sid = agent.session.id
      activeSid = sid
      const arg = String(invocation.rawInput || '').trim().toLowerCase().split(/\s+/)[0] || 'status'
      const st = state(sid)

      if (arg === 'on') { setState(sid, { ...st, enabled: true }); return { kind: 'success', text: '提示词优化器：已开启' } }
      if (arg === 'off') { setState(sid, { ...st, enabled: false }); return { kind: 'success', text: '提示词优化器：已关闭（本会话静默）' } }
      if (arg === 'lite' || arg === 'full') {
        const s = settingsFor(sid)
        try { writeSessionSettings(sid, { ...s.session, level: arg }) } catch { /* 写失败不阻断回执 */ }
        setState(sid, { ...st, enabled: true })
        return { kind: 'success', text: `提示词优化器：档位=${arg}（本会话）` }
      }
      const s = settingsFor(sid)
      return {
        kind: 'success',
        text: `提示词优化器 v${VERSION}\n· 本会话：${st.enabled ? '✅开启' : '⛔关闭'} | 档位=${s.level}（全局=${s.global.level}）\n· 已优化 ${st.count} 次 / 跳过 ${st.skipped} 次 / 去重表 ${st.asked.length} 条\n· 阈值 minLen=${s.minLen}，冷却=${s.cooldownTurns} 轮`,
      }
    },
  })

  ctx.on('dispose', () => { activeSid = null })

  /* ---------------- 核心：pre-step 判定 + 近距离注入 ---------------- */

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const sid = agent?.session?.id
    if (sid === undefined) return next()
    activeSid = sid
    const decision = await next()

    try {
      const s = settingsFor(sid)
      if (s.level === 'off') return decision
      let st = state(sid)
      if (!st.enabled) return decision

      st = { ...st, turn: (st.turn || 0) + 1 }

      const last = lastUserText(decision?.messages || messages)
      if (!last) { setState(sid, st); return decision }

      // 冷却：连续提示后强制静默（防唠叨）
      if (s.cooldownTurns > 0 && st.lastTurn >= 0 && (st.turn - st.lastTurn) <= s.cooldownTurns) {
        setState(sid, st)
        return decision
      }

      const verdict = clarityVerdict(last.text, { minLen: s.minLen })
      if (!verdict) {
        st = { ...st, skipped: (st.skipped || 0) + 1 }
        setState(sid, st)
        return decision
      }

      // 去重：同一文本只提示一次（重复粘贴同一句不再教育）
      const key = dedupeKey(last.text)
      if ((st.asked || []).includes(key)) {
        st = { ...st, skipped: (st.skipped || 0) + 1 }
        setState(sid, st)
        return decision
      }

      const kind = classify(last.text)
      const text = buildGuidance(kind, s.level)

      // 自检：注入前先自证 source 合法。session format v4 会拒收非法 source
      // （尤其 kind="plugin"），代价是**整轮运行失败**——宁可在此拦住，
      // 让优化器静默降级，也不能把用户的一轮对话搞挂。
      const msg = pluginMsg(text)
      const bad = validateSource(msg)
      if (bad) {
        console.error('[prompt-optimizer] 注入被自检拦下（不阻断本轮）:', bad)
        setState(sid, st)
        return decision
      }

      if (!spliceAfterLastUser(decision, msg)) { setState(sid, st); return decision }

      st = {
        ...st,
        asked: [...(st.asked || []), key].slice(-200),
        count: (st.count || 0) + 1,
        lastTurn: st.turn,
      }
      setState(sid, st)
      console.log(`[prompt-optimizer] injected (kind=${kind}, level=${s.level}, sid=${sid})`)
    } catch (e) {
      // 注入失败绝不阻断主流程——优化器是增益，不是依赖
      console.warn('[prompt-optimizer] pre-step failed:', e?.message || e)
    }
    return decision
  })
}

export default { apply, name, Config }
