/**
 * dsh-prompt-optimizer 浏览器半：提示词框里的「优化」按钮。
 *
 * 挂载位置：`conversation.input.right`（kind=list, scope=session）——
 * 提交按钮左侧的紧凑控件区，与模型选择器同一行。同 slot 的既有先例：
 * @linxin666/dsh-liangshen 的梁神拉杆（order=20）。
 *
 * 行为：读当前草稿 → 生成结构化提示词 → 写回草稿（用 inputActions.setDraft，
 * 这是官方提供的整稿替换原语）。**只改草稿，不自动发送**——用户看完、改完、
 * 自己按发送。乐观改写 + 用户确认，绝不替用户点发送。
 *
 * 安全：任何环节失败都不得把 GUI 带崩（slot 缺失、服务缺失、API 变化一律吞掉
 * 并降级为"不显示按钮"或"提示失败"）。
 */

import { optimizePrompt } from '../optimize-core.js'

// cordis 服务注入声明：apply 里要用 ctx.slots，必须声明 inject:['slots']，
// 否则 ctx.slots 触发 "cannot get property slots without inject"，本插件直接 return，
// 按钮永远挂不上（2026-09-26 实测：boot 成功但按钮不显示的根因）。
export const inject = ['slots']

const PLUGIN_ID = 'dsh-prompt-optimizer'
const SLOT = 'conversation.input.right'

/** 按钮样式（内联注入一次，带 data-plugin 标记便于排查）。 */
const CSS = `
.dsh-po-btn{align-items:center;gap:4px;display:inline-flex;font:inherit;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary,inherit);background:0 0;border:none;border-radius:999px;
  padding:3px 9px;margin:0;cursor:pointer;white-space:nowrap;
  transition:background-color .16s,color .16s,opacity .16s}
.dsh-po-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000f);color:var(--dsw-alias-label-primary,inherit)}
.dsh-po-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px}
.dsh-po-btn:disabled{cursor:default;opacity:.45}
.dsh-po-btn[data-busy="true"]{opacity:.7}
.dsh-po-btn[data-done="true"]{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dsh-po-ico{width:13px;height:13px;flex:none;display:block}
`

function injectCss() {
  try {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="' + PLUGIN_ID + '"]') !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = PLUGIN_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  } catch {
    // 非浏览器环境
  }
}

/** 从 slot 组件 props 里取标准注入面（不同版本可能挂在不同字段上，全部兜住）。 */
/**
 * 取 inputActions（官方草稿读写 face）。
 *
 * 它是**session 作用域的标准 prop**，由 `ctx.uiSession.provide({props:['inputActions']})`
 * 经 slot 作用域适配器下发——不是 owner props（渲染点是 renderSlot(name, {})，
 * 传的是空对象，所以**不能**只从 props 顶层找）。
 * 各版本/各渲染位置可能藏在不同层，故逐层找，全部兜住。
 */
function pickActions(props) {
  const p = props || {}
  const cands = [
    p.inputActions,
    p.runtime && p.runtime.inputActions,
    p.standard && p.standard.inputActions,
    p.props && p.props.inputActions,
  ]
  for (const c of cands) {
    if (c && typeof c.setDraft === 'function') return c
  }
  return undefined
}

/**
 * 读草稿。
 * 优先官方 store（inputState.draft），其次 DOM（contenteditable）——只读不改。
 */
function readDraft(props, actions) {
  const p = props || {}
  const stores = [p.inputState, p.input, p.runtime && p.runtime.inputState]
  for (const st of stores) {
    try {
      if (!st) continue
      const snap = typeof st.getSnapshot === 'function' ? st.getSnapshot() : st
      if (snap && typeof snap.draft === 'string') return snap.draft
    } catch { /* 换下一个来源 */ }
  }
  return readDraftFromDom()
}

/** 从 contenteditable 读当前草稿（降级路径）。 */
function readDraftFromDom() {
  try {
    if (typeof document === 'undefined') return ''
    const el = document.querySelector('[contenteditable="true"]')
    if (el && typeof el.innerText === 'string') return el.innerText
  } catch { /* 读不到就当空 */ }
  return ''
}

/**
 * 写草稿（降级路径）：把文本写进 contenteditable。
 *
 * 只在拿不到官方 inputActions 时使用。用 execCommand('insertText') 而非直接
 * 改 innerText——前者会触发 React/Lexical 的 input 事件，草稿状态能同步；
 * 后者会让编辑器状态与 DOM 脱节（下次输入就把内容冲掉）。
 */
function writeDraftToDom(text) {
  try {
    if (typeof document === 'undefined') return false
    const el = document.querySelector('[contenteditable="true"]')
    if (!el) return false
    el.focus()
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/** 统一的"写入草稿"：官方 API 优先，DOM 兜底。 */
function writeDraft(actions, text) {
  if (actions && typeof actions.setDraft === 'function') {
    actions.setDraft(text)
    return true
  }
  return writeDraftToDom(text)
}

/**
 * 挂载：注册 CSS，把按钮注册进 composer 右侧控件区。
 * @param {object} ctx 浏览器插件上下文
 */
export function apply(ctx) {
  injectCss()

  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return

  // 注意：inject() 本身也可能抛（宿主版本变化/slot 未声明）。守卫必须**包住调用**，
  // 只包住回调是不够的——早期版本只守了回调，inject 抛出会一路冒到插件加载，
  // 把 GUI 启动带崩（client bundle 自检抓到的真 bug）。
  try {
    // 回调**不返回值**：按官方契约，回调内的注册由宿主在 owner 声明收起时统一释放
    // （"The callback's registrations are disposed when the owning declaration
    // collapses and reinstalled when it returns"）。此前 return 一个 cleanup 函数
    // 是自造语义，与官方模板不一致。
    ctx.slots.inject(SLOT, () => {
      try {
        ctx.slots.register({
          name: SLOT,
          id: 'prompt-optimizer-button',
          // 排在梁神拉杆(20)之后，靠近提交按钮侧
          order: 30,
        }, OptimizeButton)
      } catch {
        // slot 不可用（宿主版本变了）→ 安静地不显示按钮，绝不让 GUI 崩
      }
    })
  } catch {
    // inject 阶段失败：整体放弃挂载按钮（功能缺失好过启动失败）
  }
}

/**
 * 插槽组件：一个「优化」按钮。
 *
 * props 由宿主经 slot 作用域注入（session 标准 kit）。**不假设一定拿到
 * inputActions**——拿不到就走 DOM 兜底，按钮始终可用，不因宿主版本差异变哑。
 */
export function OptimizeButton(props) {
  const React = OptimizeButton._react
  if (!React) return null
  const { useState, useCallback } = React

  const actions = pickActions(props)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')

  const onClick = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()
    setErr('')
    setDone(false)

    const draft = readDraft(props, actions)
    if (!draft || draft.trim() === '') { setErr('先写点什么再优化'); return }

    setBusy(true)
    try {
      const r = optimizePrompt(draft, { mode: 'structured' })
      if (!r.ok) { setBusy(false); setErr('内容为空'); return }
      if (!writeDraft(actions, r.text)) {
        setBusy(false)
        setErr('写入失败：拿不到输入框')
        return
      }
      setBusy(false)
      setDone(true)
      // 3 秒后恢复常态
      setTimeout(() => { try { setDone(false) } catch { /* 卸载后忽略 */ } }, 3000)
    } catch (e) {
      setBusy(false)
      setErr('优化失败')
    }
  }, [actions, props])

  const label = busy ? '优化中' : done ? '已优化' : '优化'
  const title = err !== '' ? err
    : done ? '已写入提示词框——检查后自行发送'
      : '把当前输入改写成结构化提示词（不会自动发送）'

  return React.createElement('button', {
    type: 'button',
    className: 'dsh-po-btn',
    title,
    'aria-label': '优化提示词',
    'data-dsh-plugin': PLUGIN_ID,
    'data-dsh-part': 'optimize-button',
    'data-busy': busy ? 'true' : undefined,
    'data-done': done ? 'true' : undefined,
    // 只有正在处理时才禁用；拿不到 actions 也可用（走 DOM 兜底）
    disabled: busy,
    onClick,
  }, [
    React.createElement('svg', {
      key: 'ico',
      className: 'dsh-po-ico',
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }, [
      // 一个"魔法棒"图标：斜杆 + 星芒
      React.createElement('path', { key: 'a', d: 'M9.5 3.5 12.5 6.5' }),
      React.createElement('path', { key: 'b', d: 'M3 13 10.5 5.5' }),
      React.createElement('path', { key: 'c', d: 'M12.5 2.2v1.6M11.7 3h1.6' }),
      React.createElement('path', { key: 'd', d: 'M14 6.4v1.2M13.4 7h1.2' }),
    ]),
    React.createElement('span', { key: 'lb' }, label),
  ])
}

// cordis 的 unwrapExports 是 `exports.default ?? exports`：default 存在就只用 default。
// 所以 default 必须同时带上 inject 与 apply，否则 plugin.inject 是 undefined，
// ctx.slots 拿不到，apply 首行 return，按钮永远挂不上（2026-09-26 实测根因）。
export default { apply, inject, OptimizeButton }
