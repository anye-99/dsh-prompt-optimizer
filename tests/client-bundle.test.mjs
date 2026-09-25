/**
 * client bundle 自检：在假浏览器里真跑一遍 bundle，验证：
 *   1. bundle 注册到 __ModuleLoader__（不是语法过、运行时挂）
 *   2. factory materialize 成功，导出 apply / OptimizeButton
 *   3. apply() 能注册进 conversation.input.right slot
 *   4. 点击按钮 → 读草稿 → 写回结构化提示词（用真实 setDraft）
 *   5. 空草稿 / 无 actions 时不崩、不误写
 *
 * 为什么必须做：client bundle 跑在浏览器里，Node 的 --check 只能验语法。
 * "require('react') 拿到的东西对不对""props 结构假设对不对""slot API 调用顺序
 * 对不对"——这些只有真跑才暴露。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf-8')

/* ---------- 极简 React 桩：够组件用（createElement 返回描述树） ---------- */
const React = {
  createElement(type, props, children) {
    return { type, props: props || {}, children }
  },
  useState(init) {
    let v = typeof init === 'function' ? init() : init
    return [v, (n) => { v = typeof n === 'function' ? n(v) : n }]
  },
  useCallback(fn) { return fn },
}

/* ---------- 极简 DOM 桩 ---------- */
const styleTags = []
let execCommandCalls = []
const editorEl = {
  innerText: '',
  focus() {},
}
const document = {
  head: { appendChild: (t) => styleTags.push(t) },
  querySelector(sel) {
    if (sel.includes('data-plugin-css')) {
      return styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === sel) || null
    }
    if (sel.includes('contenteditable')) return editorEl
    return null
  },
  createElement: () => ({ dataset: {}, textContent: '' }),
  createRange: () => ({ selectNodeContents() {} }),
  execCommand: (cmd, _ui, text) => {
    execCommandCalls.push({ cmd, text })
    if (cmd === 'insertText') { editorEl.innerText = text; return true }
    return false
  },
}
let currentDraft = ''

/* ---------- 极简 window / ModuleLoader ---------- */
const registry = new Map()
const window = {
  __ModuleLoader__: {
    load(spec) { registry.set(spec.id, spec) },
  },
}

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

function materialize(id) {
  const spec = registry.get(id)
  if (!spec) throw new Error('not registered: ' + id)
  return spec.factory(requireStub)
}

/* ---------- 跑 ---------- */
const results = []
const ok = (l, d = '') => results.push({ pass: true, l, d })
const bad = (l, d = '') => results.push({ pass: false, l, d })

// 1. 执行 bundle（模拟浏览器加载脚本）
try {
  // bundle 以 window.__ModuleLoader__.load(...) 开头，用 new Function 给它作用域
  const fn = new Function('window', 'document', bundle)
  fn(window, document)
  ok('bundle 执行并注册到 __ModuleLoader__')
} catch (e) {
  bad('bundle 执行', e.message)
}

// 2. materialize（bundle 以**完整包名**注册——与 @linxin666/dsh-liangshen 同约定）
const PKG_ID = '@dsh-external/dsh-prompt-optimizer'
let mod
try {
  mod = materialize(PKG_ID)
  ok('factory materialize 成功')
} catch (e) {
  bad('factory materialize', e.message)
}

if (mod) {
  /*
   * 【组件行"异常"回归·2026-09-26】
   *
   * 官方 decoration 模板的形态是：factory **直接返回插件对象** { inject, apply }。
   * 若退回成 `return module.exports`（带 default），宿主会走 unwrapExports
   * (`exports.default ?? exports`) 兜底——那样 plugin.inject 极易丢，ctx.slots 拿不到，
   * apply 首行 return：插件管理页该组件行显示「异常」，且按钮永不出现。
   * 这里同时钉住"直接返回"与"两条路都带 inject"。
   */
  if (!mod.inject || !Array.isArray(mod.inject) || !mod.inject.includes('slots')) {
    bad('factory 直接返回的对象必须带 inject:["slots"]', JSON.stringify(mod.inject))
  } else {
    ok('factory 直接返回的对象带 inject:["slots"]', JSON.stringify(mod.inject))
  }
  const viaUnwrap = mod.default ?? mod
  if (!viaUnwrap.inject || !viaUnwrap.inject.includes('slots')) {
    bad('经 unwrapExports（default ?? exports）后仍须带 inject', JSON.stringify(viaUnwrap.inject))
  } else {
    ok('经 unwrapExports 后仍带 inject')
  }

  if (typeof mod.apply !== 'function') bad('导出 apply')
  else ok('导出 apply')
  if (typeof mod.OptimizeButton !== 'function') bad('导出 OptimizeButton')
  else ok('导出 OptimizeButton')
  if (typeof mod.optimizePrompt !== 'function') bad('导出 optimizePrompt')
  else ok('导出 optimizePrompt')

  // 3. apply 注册 slot
  const registered = []
  const injections = []
  const ctx = {
    slots: {
      inject(name, fn) { injections.push(name); try { fn() } catch (e) { bad('slot.inject 回调', e.message) } },
      register(spec, comp) { registered.push({ spec, comp }); return () => {} },
    },
  }
  try {
    mod.apply(ctx)
    ok('apply() 无异常')
  } catch (e) {
    bad('apply()', e.message)
  }
  assert.equal(injections[0], 'conversation.input.right', '应注入到 composer 右侧 slot')
  ok('注入到 conversation.input.right', injections[0])
  if (registered.length !== 1) bad('注册 1 个组件', String(registered.length))
  else ok('注册 1 个组件', registered[0].spec.id)

  // 4. 点击行为：真草稿 → 写回（官方 inputActions 路径）
  const Comp = registered[0].comp
  let written = null
  const actions = { setDraft: (t) => { written = t }, captureInsertion: () => ({}), submit: () => {} }
  const clickEvent = { preventDefault() {}, stopPropagation() {} }
  const DRAFT = '帮我优化一下这个项目，让它变得更好用一些，感觉很多地方不太行'

  // props.inputActions（标准 kit 最常见的位置）
  currentDraft = DRAFT
  editorEl.innerText = DRAFT
  const vnode = Comp({ inputActions: actions })
  assert.equal(vnode.type, 'button', '应为 button 元素')
  ok('组件渲染出 button')

  vnode.props.onClick(clickEvent)

  if (written === null) bad('点击后应写入草稿')
  else {
    ok('点击后写入草稿（inputActions 路径）')
    if (!written.includes('帮我优化一下这个项目')) bad('写入内容应保留原话')
    else ok('写入内容保留原话')
    if (!written.includes('## 验收标准')) bad('写入内容应含验收槽位')
    else ok('写入内容含结构化槽位')
  }

  // 4b. 嵌套位置（runtime.inputActions）也要认
  written = null
  const vNested = Comp({ runtime: { inputActions: actions } })
  vNested.props.onClick(clickEvent)
  if (written === null) bad('runtime.inputActions 位置也应被识别')
  else ok('识别 runtime.inputActions 位置')

  // 4c. 【关键】拿不到 inputActions 时走 DOM 兜底（按钮不能变哑）
  written = null
  execCommandCalls = []
  currentDraft = DRAFT
  editorEl.innerText = DRAFT
  const vFallback = Comp({})
  vFallback.props.onClick(clickEvent)
  if (execCommandCalls.length === 0) bad('无 inputActions 时应走 DOM 兜底写入')
  else {
    ok('无 inputActions 时走 DOM 兜底')
    const wrote = execCommandCalls.find(c => c.cmd === 'insertText')
    if (!wrote || !wrote.text.includes('## 验收标准')) bad('DOM 兜底应写入结构化内容')
    else ok('DOM 兜底写入结构化内容')
  }
  // 兜底路径下按钮不得被禁用（否则等于没有按钮）
  if (vFallback.props.disabled) bad('无 inputActions 时按钮不应禁用')
  else ok('无 inputActions 时按钮仍可用')

  // 5. 空草稿：不得误写
  written = null
  execCommandCalls = []
  currentDraft = '   '
  editorEl.innerText = '   '
  const v2 = Comp({ inputActions: actions })
  v2.props.onClick(clickEvent)
  if (written !== null || execCommandCalls.length > 0) bad('空草稿不应写入')
  else ok('空草稿不写入')

  // 6. 无 actions：不得崩
  try {
    const v3 = Comp({})
    v3.props.onClick(clickEvent)
    ok('无 inputActions 时不崩')
  } catch (e) {
    bad('无 inputActions 时崩了', e.message)
  }

  // 7. slot 不可用时不崩
  try {
    mod.apply({ slots: { inject() { throw new Error('no slot') } } })
    ok('slot 注入失败时不崩')
  } catch (e) {
    bad('slot 注入失败带崩了', e.message)
  }
  try {
    mod.apply({})
    mod.apply(undefined)
    ok('ctx 缺失时不崩')
  } catch (e) {
    bad('ctx 缺失带崩了', e.message)
  }
}

const failed = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? '  OK  ' : ' FAIL '} ${r.l}${r.d ? '  — ' + r.d : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
