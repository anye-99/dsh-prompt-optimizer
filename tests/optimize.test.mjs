/**
 * 优化核心单测：重点验证"该不该开口"的判定边界。
 *
 * 判定是本插件唯一的风险面——误开口 = 噪音 + 缓存损失（代价不对称），
 * 所以断言里"必须静默"的用例远多于"必须开口"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clarityVerdict, classify, buildGuidance, dedupeKey, LEVELS } from '../src/optimize.js'

test('明确指令不介入（最常见的误伤场景）', () => {
  const clear = [
    '看下 package.json',
    '跑测试',
    '改 src/index.js 第 42 行',
    '删除 logs 目录',
    '把 getUserById 的返回值改成 null',
    '运行 npm run build',
    'fix the bug in auth.js',
    'read README.md and summarize',
    'https://example.com 这个页面抓一下标题',
    '把 D:\\work\\a.ts 的 type 改成 string',
  ]
  for (const t of clear) {
    assert.equal(clarityVerdict(t), null, `不该开口: ${t}`)
  }
})

test('结构化提示词不介入（用户自己会写）', () => {
  const structured = [
    '目标：实现登录\n约束：只用标准库\n验收：跑通测试',
    '- 第一步做 A\n- 第二步做 B\n- 第三步做 C',
    '## 任务\n帮我看看这个项目',
    'Task: refactor the auth module\nContext: legacy code',
    '【要求】输出 JSON\n【背景】接口联调',
  ]
  for (const t of structured) {
    assert.equal(clarityVerdict(t), null, `不该开口: ${t}`)
  }
})

test('闲聊/确认/元操作一律静默', () => {
  const trivial = ['好', '好的', '嗯', '继续', 'ok', '收到', '谢谢', '算了', '停', '取消', '你好', '在吗', 'test', 'Go']
  for (const t of trivial) {
    assert.equal(clarityVerdict(t), null, `不该开口: ${t}`)
  }
})

test('粘贴的代码/日志/堆栈不介入（那是素材不是指令）', () => {
  const blobs = [
    '```js\nconst a = 1\n```',
    'Traceback (most recent call last):\n  File "a.py", line 1',
    '2026-09-25 22:48:07 ERROR something failed badly here',
    '> 这是一段引用文本，包含较长的说明内容用于测试',
    '$ npm install --save-dev typescript',
    'at Object.<anonymous> (/app/index.js:10:15)',
  ]
  for (const t of blobs) {
    assert.equal(clarityVerdict(t), null, `不该开口: ${t}`)
  }
})

test('提问句不介入（问题本身清晰）', () => {
  const qs = ['这个怎么实现比较好呢', '为什么会这样', '能不能帮我看看这个架构是否合理', 'Is this approach correct?']
  for (const t of qs) {
    assert.equal(clarityVerdict(t), null, `不该开口: ${t}`)
  }
})

test('短文本不介入（低于阈值）', () => {
  assert.equal(clarityVerdict('帮我弄一下'), null)      // 含祈使 + 短
  assert.equal(clarityVerdict('优化一下'), null)
  assert.equal(clarityVerdict(''), null)
  assert.equal(clarityVerdict(null), null)
  assert.equal(clarityVerdict('   '), null)
})

test('含糊长文本才开口（本插件的唯一目标场景）', () => {
  const vague = [
    '帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行，用户反馈也不太好',
    '最近这个东西跑起来有点问题，你看看哪里可能有问题，顺便能提升的话也提升一下',
    '我想让这个功能更完善一点，你自由发挥，做成那种比较专业的效果就行',
    '这个模块整体需要重构一下，代码质量不太行，可维护性也差，希望你能处理得优雅一点',
  ]
  for (const t of vague) {
    assert.equal(clarityVerdict(t), 'vague', `应当开口: ${t}`)
  }
})

test('长文本但含明确对象 → 不介入', () => {
  const t = '麻烦你把 src/utils/date.ts 里面的 formatDate 函数重构一下，加上时区参数，' +
    '顺便把调用它的地方都更新一遍，注意保持向后兼容不要破坏现有测试的预期行为'
  assert.equal(clarityVerdict(t), null)
})

test('classify 弱判定：命中即用，零命中=generic', () => {
  assert.equal(classify('这段代码有 bug 报错'), 'code')
  assert.equal(classify('帮我对比这两个数据库方案的优劣'), 'research',
    '任务本质（对比评估）应优先于领域名词（数据库）——否则会被误判成 code')
  assert.equal(classify('要不要重构这个模块'), 'decision',
    '决策信号优先于领域信号')
  assert.equal(classify('写一篇关于气候变化的文章'), 'writing')
  assert.equal(classify('设计一个登录界面的布局配色'), 'design')
  assert.equal(classify('我该不该选这个框架'), 'decision')
  assert.equal(classify('这段代码需要重构一下'), 'code')
  assert.equal(classify('随便弄弄'), 'generic')
  assert.equal(classify(''), 'generic')
})

test('buildGuidance：静态输出、含三要素、零动态拼接', () => {
  const a = buildGuidance('code', 'full')
  const b = buildGuidance('code', 'full')
  assert.equal(a, b, '同输入必须同输出——静态文本才能保住前缀缓存')
  assert.match(a, /要达成什么/)
  assert.match(a, /边界在哪/)
  assert.match(a, /怎么算通过/)
  assert.match(a, /代码类重心/)
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), '不得含时间戳等动态内容')

  const lite = buildGuidance('code', 'lite')
  assert.ok(lite.length < a.length, 'lite 档应更短')
  assert.ok(!lite.includes('代码类重心'), 'lite 不含类型重心')
  assert.match(lite, /要达成什么/)

  assert.ok(buildGuidance('generic', 'full').length > 0)
  assert.ok(!buildGuidance('generic', 'full').includes('重心'), 'generic 无重心段')
})

test('dedupeKey：同文本同键、异文本异键、稳定', () => {
  assert.equal(dedupeKey('  abc '), dedupeKey('abc'), 'trim 后同键')
  assert.notEqual(dedupeKey('abc'), dedupeKey('abd'))
  assert.equal(dedupeKey('abc'), dedupeKey('abc'))
  assert.match(dedupeKey('x'), /^po:/)
})

test('LEVELS 常量与实现一致', () => {
  assert.deepEqual(LEVELS, ['off', 'lite', 'full'])
})
