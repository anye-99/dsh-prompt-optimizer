/**
 * channel — 注入通道的纯逻辑（零宿主依赖，可独立单测）。
 *
 * 与 index.js 分离的原因：index.js 需要 `@deepseek-ai/schemastery`（由 profile
 * 的 node_modules 在运行时提供），源码目录里并不存在——一旦把它和纯函数写在
 * 一起，单测就无法 import。宿主依赖与纯逻辑分家，测试才能跑。
 */

export const PLUGIN_ID = 'dsh-prompt-optimizer'

/**
 * 注入消息的 source.kind。
 *
 * ⚠️ **不能是 `'plugin'`**。session format v4 明确拒收这个值：
 *
 *   if (... || value["kind"] === "plugin")
 *     throw new SessionFormatError("format v4 message requires a producer-owned source kind")
 *
 * （依据：@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs，
 *   以及 dsh-session-format-v3-to-v4 —— `plugin` 是已退役的 V3 包装器语义，
 *   只有白名单里的历史插件名会被自动改写，**新插件用它就是持久化失败**。）
 *
 * 症状：注入的消息一旦进入持久化（不止是当轮 decision.messages），
 * 整轮就报 "本轮运行失败：format v4 message requires a producer-owned source kind"。
 *
 * 正确做法：用 producer-owned kind `'user'`（与官方构造 user 消息一致），
 * 自身来源改用**额外字段**标记（额外字段会被保留，见 L105-106 的过滤逻辑只删 `plugin`）。
 */
export const SOURCE_KIND = 'user'

/** 自身来源标记字段（替代已退役的 source.plugin）。 */
export const PRODUCER_FIELD = 'producer'

/**
 * 构造插件注入消息。
 *
 * source = { kind: 'user', producer: PLUGIN_ID }——
 * kind 满足 v4 的 producer-owned 要求；producer 用于跳过自身、防自我触发。
 */
export function pluginMsg(text) {
  return {
    id: 'po-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    role: 'user',
    source: { kind: SOURCE_KIND, [PRODUCER_FIELD]: PLUGIN_ID },
    content: [{ type: 'text', text }],
  }
}

/**
 * 复刻 session format v4 的 source 校验（worker.cjs / message-sources.ts）。
 *
 * 本地复刻一份，是为了**在注入前就能自证合法**——这个 bug 的代价太高
 * （整轮运行失败，用户看到的是一屏红色报错），宁可多一道自检。
 * 规则原文：
 *   !isObject(value) || typeof value.kind !== 'string' || value.kind.length === 0
 *   || value.kind === 'plugin'  →  throw
 *
 * @returns {string|null} 违规原因；null = 合法
 */
export function validateSource(msg) {
  const v = msg?.source
  if (!v || typeof v !== 'object') return 'source 缺失或非对象'
  if (typeof v.kind !== 'string') return 'source.kind 必须是字符串'
  if (v.kind.length === 0) return 'source.kind 不得为空'
  if (v.kind === 'plugin') return 'source.kind="plugin" 已被 format v4 拒收（需 producer-owned kind）'
  return null
}

/** 在 messages 里最后一条 user 消息之后插入（近距离位）；无 user 消息则追加到末尾。 */
export function spliceAfterLastUser(decision, msg) {
  if (!decision || !Array.isArray(decision.messages)) return false
  let at = decision.messages.length
  for (let i = decision.messages.length - 1; i >= 0; i--) {
    const m = decision.messages[i]
    if (m && m.role === 'user') { at = i + 1; break }
  }
  decision.messages.splice(at, 0, msg)
  return true
}

/** 提取消息文本。 */
export function textOf(m) {
  let t = ''
  for (const x of (m?.content || [])) {
    if (x && typeof x === 'object' && x.type === 'text') t += x.text || ''
  }
  return t
}

/**
 * 是否**本插件自己**的注入消息（跳过——绝不基于自己的引导再触发优化）。
 *
 * 注意：不能再靠 `source.kind === 'plugin'` 判断（该值已被 v4 拒收，见上）。
 * 改为认两个标记，任一命中即认为是自己的注入：
 *   ① source.producer === PLUGIN_ID  （本插件写入的标记）
 *   ② source.kind === 'plugin'       （兼容旧版已落盘的历史消息）
 * 绝不能写成"所有 user 消息都算注入"——那会让判定永远找不到真实输入。
 */
export function isPluginMsg(m) {
  const s = m?.source
  if (!s || typeof s !== 'object') return false
  if (s[PRODUCER_FIELD] === PLUGIN_ID) return true
  if (s.kind === 'plugin' && s.plugin === PLUGIN_ID) return true
  return false
}

/**
 * 取本轮的"真实用户输入"。
 *
 * 关键：pre-step 的 messages 含全部历史。只应针对**最后一条真实用户消息**判定——
 * 否则历史里的含糊话会被反复重新提示（唠叨 + 缓存抖动）。
 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    if (isPluginMsg(m)) continue
    const t = textOf(m).trim()
    if (t) return { text: t, index: i }
  }
  return null
}

/** 审计体（纯函数，可测）。 */
export function auditBody(st, settings, version) {
  const count = st?.count || 0
  const skipped = st?.skipped || 0
  const n = count + skipped
  return {
    ok: true,
    version,
    enabled: st?.enabled !== false,
    count,
    skipped,
    turn: st?.turn || 0,
    dedupeSize: (st?.asked || []).length,
    hitRate: n === 0 ? 0 : Number((count / n).toFixed(3)),
    settings,
  }
}
