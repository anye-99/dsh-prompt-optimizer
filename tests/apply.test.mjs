/**
 * 装配自检（可重复运行）：在"假宿主 ctx"里真跑一遍 apply()，
 * 验证插件能装配、注册命令/路由、并在 pre-step 通道真的注入。
 *
 * 为什么要这个：单测只覆盖纯函数；真正的风险在"宿主契约"——
 * 依赖服务名写错、事件签名对不上、decision.messages 结构假设错，
 * 这些只有把 apply() 真跑起来才暴露。宿主不可用时至少保证这一步过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../src/index.js'
import * as hostMod from '../src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个够用的假宿主：effect/on/commands/webServer 四件套。 */
function fakeCtx() {
  const handlers = new Map()
  const commands = []
  const routes = []
  const effects = []
  const ctx = {
    handlers, effects,
    effect(fn) { const d = fn(); effects.push(d); return d },
    on(ev, fn) { handlers.set(ev, fn) },
    commands: { register(def) { commands.push(def); return () => {} }, list: commands },
    webServer: { register(route) { routes.push(route); return () => {} }, list: routes },
  }
  ctx.commandList = commands
  ctx.routeList = routes
  return ctx
}

test('插件导出契约完备', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(name, 'dsh-prompt-optimizer')
})

/**
 * 【启动死机回归·2026-09-26】
 *
 * host 半**绝不能**导出 inject=['commands','webServer']。
 *
 * 原因：本插件是 Host+Client 双面包、单一入口。Web 端 Loader 会读同一份 inject，
 * 但浏览器里没有 commands/webServer 这两个 Host 专属服务。cordis 对声明了
 * 拿不到服务的 fiber 永远停在 pending/loading → web boot 直接 abort，
 * GUI 起不来（弹"web boot: 1 entry did not activate ... : loading"）。
 *
 * 正确做法：不在入口声明 inject，改在 apply 内防御性取服务（拿不到就静默降级）。
 * 所以这里断言的是"**没有** inject"——一旦有人为了类型方便把它加回来，
 * 这条会立刻红。
 */
test('host 半不得声明 inject（否则 web boot 死机）', () => {
  assert.equal(
    hostMod.inject, undefined,
    'src/index.js 导出 inject 会让 web 端 fiber 卡在 loading，GUI 起不来',
  )
  // 契约面仍是完整的：cordis 认 apply/name/Config
  assert.equal(typeof hostMod.apply, 'function')
  assert.equal(typeof hostMod.name, 'string')
})

/**
 * 【按钮不显示回归·2026-09-26】
 *
 * client 半的 default 导出**必须**带上 inject=['slots']。
 *
 * 原因：cordis unwrapExports 是 `exports.default ?? exports`——default 存在就
 * 只用 default。若 default 里没有 inject，plugin.inject 为 undefined，
 * ctx.slots 取不到（cannot get property "slots" without inject），
 * apply 首行 `if (!ctx.slots) return` 直接返回 → boot 不报错但按钮永远挂不上。
 */
test('client 半 default 必须带 inject（否则按钮挂不上）', async () => {
  const mod = await import('../src/client/index.js')
  const plugin = mod.default ?? mod
  assert.deepEqual(plugin.inject, ['slots'], 'default 必须带 inject，否则 ctx.slots 拿不到')
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 可装配：注册命令 + 路由 + pre-step 监听', () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    assert.equal(ctx.commandList.length, 1, '应注册 /optimize 命令')
    assert.equal(ctx.commandList[0].name, 'optimize')
    assert.ok(ctx.routeList.length >= 2, '应注册 settings + 审计路由')
    assert.ok(ctx.handlers.has('agent/pre-step'), '应监听 agent/pre-step')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-step 真注入：含糊输入 → 用户消息之后追加引导', async () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const preStep = ctx.handlers.get('agent/pre-step')

    const vague = '帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行，用户反馈也不太好'
    const decision = { messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: vague }] }] }
    const agent = { session: { id: 'session-test-1' } }

    const out = await preStep({ agent, messages: decision.messages }, async () => decision)
    assert.equal(out.messages.length, 2, '应注入一条引导')
    const inj = out.messages[1]
    assert.equal(inj.role, 'user')
    // 【回归】注入的 source 必须过 session format v4：kind 不得为 'plugin'
    assert.notEqual(inj.source.kind, 'plugin', 'kind="plugin" 会让整轮运行失败')
    assert.equal(inj.source.kind, 'user')
    assert.equal(inj.source.producer, 'dsh-prompt-optimizer', '自身标记走 producer 字段')
    assert.match(inj.content[0].text, /提示词优化/)
    // 关键：原话必须原样保留在引导之前
    assert.equal(out.messages[0].content[0].text, vague, '绝不改写用户原话')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-step 放行：清晰输入不注入', async () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const preStep = ctx.handlers.get('agent/pre-step')
    const decision = { messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看下 package.json' }] }] }
    const out = await preStep({ agent: { session: { id: 'session-test-2' } }, messages: decision.messages }, async () => decision)
    assert.equal(out.messages.length, 1, '清晰输入必须放行——不得加戏')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-step 去重：同一含糊输入不重复教育', async () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const preStep = ctx.handlers.get('agent/pre-step')
    const vague = '帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行，用户反馈也不太好'
    const agent = { session: { id: 'session-test-3' } }

    const mk = () => ({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: vague }] }] })
    const a = await preStep({ agent, messages: mk().messages }, async () => mk())
    assert.equal(a.messages.length, 2, '首次应注入')
    const b = await preStep({ agent, messages: mk().messages }, async () => mk())
    assert.equal(b.messages.length, 1, '同文本第二次不得再注入')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-step 不因自身注入而自我触发（新格式）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const preStep = ctx.handlers.get('agent/pre-step')
    const agent = { session: { id: 'session-test-4' } }
    const onlyMine = [{
      role: 'user',
      source: { kind: 'user', producer: 'dsh-prompt-optimizer' },
      content: [{ type: 'text', text: '【提示词优化·自查】……' }],
    }]
    const decision = { messages: [...onlyMine] }
    const out = await preStep({ agent, messages: decision.messages }, async () => decision)
    assert.equal(out.messages.length, 1, '不得基于自己的注入再注入（防无限套娃）')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-step 不因自身注入而自我触发（兼容旧版已落盘格式）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'po-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const preStep = ctx.handlers.get('agent/pre-step')
    const agent = { session: { id: 'session-test-5' } }
    // 旧版写进磁盘的历史消息（kind='plugin'）仍应被识别为"自己的"
    const legacy = [{
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-prompt-optimizer' },
      content: [{ type: 'text', text: '【提示词优化·自查】……' }],
    }]
    const decision = { messages: [...legacy] }
    const out = await preStep({ agent, messages: decision.messages }, async () => decision)
    assert.equal(out.messages.length, 1, '旧格式注入也应被跳过')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
