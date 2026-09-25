/**
 * 注入通道单测：验证"挑哪条用户消息判定"与"注入插在哪一位"。
 *
 * 这两个位置语义错了就是灾难：
 *   - 判错消息 → 历史含糊话被反复重提示（唠叨）
 *   - 插错位置 → 引导跑到用户消息之前（远距离，实测衰减甚至反向）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastUserText, auditBody, pluginMsg, isPluginMsg, SOURCE_KIND, PRODUCER_FIELD } from '../src/channel.js'

// um(text, mine=true) = 本插件的注入；false = 真实用户消息
const um = (text, mine = false) => ({
  role: 'user',
  source: mine
    ? { kind: SOURCE_KIND, [PRODUCER_FIELD]: 'dsh-prompt-optimizer' }
    : { kind: 'user' },
  content: [{ type: 'text', text }],
})
const am = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

/* ---------- 回归：session format v4 拒收 source.kind='plugin' ---------- */

test('【回归】注入消息的 source.kind 不得为 "plugin"（v4 会拒收导致整轮失败）', () => {
  const m = pluginMsg('测试引导')
  assert.notEqual(m.source.kind, 'plugin',
    'kind="plugin" 是已退役的 V3 语义，v4 持久化会抛 ' +
    '"format v4 message requires a producer-owned source kind"')
  assert.equal(m.source.kind, 'user', '必须用 producer-owned kind')
  assert.equal(m.source[PRODUCER_FIELD], 'dsh-prompt-optimizer', '自身来源改用 producer 字段标记')
  // v4 要求 kind 为非空字符串
  assert.equal(typeof m.source.kind, 'string')
  assert.ok(m.source.kind.length > 0)
  // 不得残留已退役的 plugin 字段
  assert.equal(m.source.plugin, undefined)
})

test('【回归】pluginMsg 产出的消息能通过 v4 source 校验（复刻校验器规则）', () => {
  // 复刻 worker.cjs 的规则：非对象 / kind 非字符串 / kind 空 / kind==='plugin' → 抛
  const assertV4Source = (msg) => {
    const v = msg.source
    const bad = !v || typeof v !== 'object'
      || typeof v.kind !== 'string' || v.kind.length === 0 || v.kind === 'plugin'
    if (bad) throw new Error('format v4 message requires a producer-owned source kind')
  }
  assert.doesNotThrow(() => assertV4Source(pluginMsg('x')))
  // 对照：旧写法必须被拒（证明这个测试真的在测东西）
  assert.throws(
    () => assertV4Source({ role: 'user', source: { kind: 'plugin', plugin: 'p' }, content: [] }),
    /producer-owned source kind/,
  )
})

test('isPluginMsg：只认自己的注入，不误伤真实用户消息', () => {
  assert.equal(isPluginMsg(pluginMsg('x')), true, '本插件注入应被识别')
  assert.equal(isPluginMsg({ source: { kind: 'user' } }), false, '真实用户消息不得被误判')
  assert.equal(isPluginMsg({ source: { kind: 'user', producer: 'other-plugin' } }), false, '别的插件不关我事')
  assert.equal(isPluginMsg({}), false)
  assert.equal(isPluginMsg({ source: null }), false)
  // 兼容旧版已落盘的历史消息
  assert.equal(isPluginMsg({ source: { kind: 'plugin', plugin: 'dsh-prompt-optimizer' } }), true, '应兼容旧格式')
  assert.equal(isPluginMsg({ source: { kind: 'plugin', plugin: 'someone-else' } }), false)
})

test('lastUserText：取最后一条真实用户消息', () => {
  const msgs = [um('第一条'), am('回复'), um('第二条'), am('回复2'), um('第三条')]
  assert.deepEqual(lastUserText(msgs)?.text, '第三条')
})

test('lastUserText：跳过插件自己的注入消息', () => {
  const msgs = [um('真实输入'), um('【提示词优化·自查】...', true)]
  assert.equal(lastUserText(msgs)?.text, '真实输入')
  // 全是插件消息 → null（绝不基于自己的引导再触发）
  assert.equal(lastUserText([um('注入A', true), um('注入B', true)]), null)
})

test('lastUserText：忽略空文本与 assistant 消息', () => {
  assert.equal(lastUserText([am('只有助手')]), null)
  assert.equal(lastUserText([um('   ')]), null)
  assert.equal(lastUserText([]), null)
  assert.equal(lastUserText(null), null)
  const msgs = [um('有内容'), um('   ')]
  assert.equal(lastUserText(msgs)?.text, '有内容', '空白消息应被跳过，回退到有内容的用户消息')
})

test('lastUserText：返回索引便于定位', () => {
  const msgs = [um('a'), am('b'), um('c')]
  assert.equal(lastUserText(msgs)?.index, 2)
})

test('auditBody：命中率与计数字段完备', () => {
  const st = { enabled: true, count: 3, skipped: 7, turn: 10, asked: ['po:a', 'po:b'] }
  const b = auditBody(st, { level: 'full' }, '0.1.0')
  assert.equal(b.ok, true)
  assert.equal(b.count, 3)
  assert.equal(b.skipped, 7)
  assert.equal(b.dedupeSize, 2)
  assert.equal(b.hitRate, 0.3)
  assert.equal(b.version, '0.1.0')
  assert.deepEqual(b.settings, { level: 'full' })

  const empty = auditBody(null, {}, '0.1.0')
  assert.equal(empty.hitRate, 0, '零样本不得除零')
  assert.equal(empty.enabled, true)
})
