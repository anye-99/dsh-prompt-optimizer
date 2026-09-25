/**
 * 按钮改写器单测（optimize-core）。
 *
 * 与 optimize.test.mjs 的区别：那里测"该不该自动开口"，这里测"用户点了按钮后
 * 产出什么"。核心断言是**不发明意图**——用户没说的必须留成待补槽位，
 * 而不是被编出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optimizePrompt, classify, extractAnchors, SLOTS } from '../src/optimize-core.js'

test('空输入不产出（不生成空骨架）', () => {
  const r = optimizePrompt('')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty')
  assert.equal(r.text, '')
  assert.equal(optimizePrompt('   ').ok, false)
  assert.equal(optimizePrompt(null).ok, false)
})

test('原话必须完整保留（绝不删改用户表达）', () => {
  const raw = '帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行'
  const r = optimizePrompt(raw)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes(raw), '原文必须原样出现在结果里')
})

test('产出包含四要素骨架', () => {
  const r = optimizePrompt('帮我优化一下这个项目，让它更好用一些')
  for (const label of ['## 原始需求', '## 目标', '## 背景与范围', '## 约束', '## 验收标准']) {
    assert.ok(r.text.includes(label), `缺槽位: ${label}`)
  }
  assert.deepEqual(SLOTS, ['goal', 'context', 'constraints', 'acceptance'])
})

test('含糊措辞被翻成待澄清问题（而不是替用户编答案）', () => {
  const r = optimizePrompt('帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行')
  assert.ok(r.notes.length > 0, '应识别出含糊点')
  assert.ok(r.text.includes('需要先澄清的点'))
  // 关键：不能出现"用户已确定要 X"式的伪造断言
  assert.ok(!/已确定|用户要求必须/.test(r.text), '不得伪造用户意图')
})

test('无具体对象时，目标槽位留成待补而非编造', () => {
  const r = optimizePrompt('帮我把这个东西弄好一点，现在体验不太好，你自由发挥就行')
  assert.ok(r.text.includes('待补') || r.text.includes('问我'), '应显式留白或转为提问')
})

test('有具体对象时，锚点被提取进背景槽位', () => {
  const r = optimizePrompt('帮我重构 src/utils/date.ts 里的 formatDate 函数，让它更好维护一些')
  assert.ok(r.anchors.length > 0, '应提取到对象锚点')
  assert.ok(r.text.includes('涉及对象：'), '锚点应进入背景槽位')
  assert.ok(r.anchors.some(a => a.includes('date.ts')), '应命中文件路径')
})

test('extractAnchors 提取路径/文件/URL/驼峰', () => {
  const a = extractAnchors('看下 src/a/b.ts 和 https://x.com/y 以及 getUserById 这个函数')
  assert.ok(a.some(x => x.includes('b.ts')))
  assert.ok(a.some(x => x.includes('https://x.com/y')))
  assert.ok(a.some(x => x.includes('getUserById')))
  assert.ok(extractAnchors('').length === 0)
})

test('classify 决定验收建议的类型', () => {
  assert.equal(classify('这段代码有 bug'), 'code')
  assert.equal(classify('对比这两个方案'), 'research')
  assert.equal(classify('写一篇文章'), 'writing')
  assert.equal(classify('设计一个界面'), 'design')
  assert.equal(classify('随便弄弄'), 'generic')
  const code = optimizePrompt('帮我改改这段代码，质量不太行')
  assert.equal(code.kind, 'code')
  assert.ok(code.text.includes('编译/测试/实跑'), 'code 类型应给代码类验收建议')
})

test('rewrite 模式：产出可直接发送的短稿', () => {
  const raw = '帮我优化一下这个项目，让它更好用一些'
  const r = optimizePrompt(raw, { mode: 'rewrite' })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes(raw), 'rewrite 也保留原话')
  assert.ok(!r.text.includes('## 原始需求'), 'rewrite 不应有重骨架')
  assert.ok(r.text.includes('要求：'))
  assert.ok(r.text.length < optimizePrompt(raw).text.length, 'rewrite 应更短')
})

test('输出确定：同输入必同输出', () => {
  const raw = '帮我优化一下这个项目，让它更好用一些'
  assert.equal(optimizePrompt(raw).text, optimizePrompt(raw).text)
})
