/**
 * optimize-core — 提示词优化的纯规则层（host/client 双端共享，零依赖）。
 *
 * 与 src/optimize.js 的分工：那个是"自动注入"的判定器（决定要不要开口）；
 * 这个是"**用户点按钮**"时的改写器（用户已明确要求优化，所以不再判断该不该，
 * 而是直接产出一份结构化提示词）。
 *
 * 设计立场与自动模式一致：**绝不替用户发明意图**。
 * 改写只做三件事：① 保留原话（不删不改）② 补上缺失的要素槽位
 * ③ 把含糊措辞翻成可执行的要求。用户没说的，就留成待补的槽位，而不是瞎编。
 */

/** 要素槽位（结构化提示词的骨架）。 */
export const SLOTS = ['goal', 'context', 'constraints', 'acceptance']

const IMPERATIVE_RE = /^(帮我|请|麻烦|给我|把|将|改|修|加|删|去|跑|运行|执行|查|看|读|打开|建|创建|写个|写一|做一|生成|安装|部署|测试|提交|推送|拉取|重启|停|启动|复制|移动|重命名|格式化|清理|导出|导入|替换|更新|升级|回滚|撤销|比较|对比|统计|列出|找|搜|爬|下载|上传|打包|发布|merge|rebase|commit|push|pull|build|run|fix|add|remove|delete|update|rename|refactor|test|lint|install|deploy|open|read|show|list|check|find|create|make|generate|write|edit|move|copy|export|import|upgrade|revert)/i

const CONCRETE_RE = /([A-Za-z]:[\\/]|\.{0,2}[\\/][\w.-]+|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|py|go|rs|java|c|h|cpp|cs|sql|sh|ps1|html|css|scss|vue|toml|ini|cfg|log|tgz|zip)\b|https?:\/\/|\b\d+(?:\s*[-–~]\s*\d+)?\s*行|\b[\w$]+\(\)|\b[a-z]+[A-Z][A-Za-z0-9]*\b)/

/** 含糊措辞 → 可执行要求的翻译表（只做"提问化"，不替用户作答）。 */
const VAGUE_TRANSLATIONS = [
  [/(更好用|好用一些|更好一些|好用点|用户体验好)/i, '「更好用」需要落到可观测处：是少点几次、还是快几秒、还是少报错？'],
  [/(优化一下|优化下|优化|提升|改进|完善)/i, '「优化」需要一个方向与判据：优化什么维度（速度/体积/可读性/稳定性），改善到什么程度算达成？'],
  [/(美化|好看|美观|视觉|样式好)/i, '「好看」需要一个参照或标准：对齐哪个设计/截图，还是先给一版再由你挑？'],
  [/(乱|乱糟糟|臃肿|质量差|不太行|不太好|有点问题|有问题)/i, '「有问题」需要定位到现象：什么操作下、看到什么、期望什么？'],
  [/(专业|高级|优雅|丝滑|流畅)/i, '「专业/优雅」是主观判断，需要一条可对照的样板或明确的验收动作。'],
  [/(自由发挥|看着办|你懂的|随便|都行)/i, '「自由发挥」= 没有验收锚。至少给一个方向或一个禁区，否则无法判断做对没有。'],
]

const KIND_HINTS = [
  ['research', /(分析|调研|研究|对比|比较|评估|选型|论证|查证|来源|文献|综述|为什么|原理|机制|优劣|利弊|analy|research|compare|evaluat|investigat|survey|why|mechanism)/i],
  ['decision', /(要不要|该不该|选哪个|哪个好|怎么选|方案|取舍|权衡|决策|建议|推荐|recommend|choose|should i|trade-?off|decision)/i],
  ['writing', /(写一篇|文案|文章|报告|文档|总结|摘要|润色|翻译|邮件|周报|日报|说明|草稿|write|article|report|doc|summar|polish|translat|email)/i],
  ['design', /(设计|界面|视觉|布局|配色|交互|体验|原型|样式|ui|ux|design|layout|visual|prototype|style)/i],
  ['code', /(代码|函数|组件|接口|api|bug|报错|异常|崩溃|性能|重构|编译|构建|依赖|数据库|sql|类|模块|仓库|提交|部署|code|function|component|api|bug|error|crash|refactor|build|deploy|database)/i],
]

export function classify(text) {
  const t = String(text ?? '')
  for (const [kind, re] of KIND_HINTS) if (re.test(t)) return kind
  return 'generic'
}

/** 类型专属的验收建议（验收槽位的候选写法——是**建议**不是断言）。 */
const ACCEPTANCE_HINT = {
  code: '跑通验证：编译/测试/实跑至少一项，给出命令与结果；改前先复现问题。',
  research: '每条结论标注来源（文件/公式/数据）与复现路径；证据不足的明说"未证实"。',
  writing: '先定读者与用途，再定结构与详略；交付后通读一遍删套话。',
  design: '给出可看的产物（截图/原型），并按使用场景实际走一遍。',
  decision: '列出判据与权重，明确推荐一个并说清代价；不写"各有优劣"。',
  generic: '指明"做到什么程度算完成"，以及你凭什么判断它做到了。',
}

/** 约束槽位的类型提示。 */
const CONSTRAINT_HINT = {
  code: '技术栈/版本限制、不能动的东西、兼容性要求、是否允许新增依赖。',
  research: '信息源范围（只看仓库内/可联网）、时间范围、必须覆盖与不必覆盖的部分。',
  writing: '篇幅、语气、面向的读者、必须包含或必须避免的内容。',
  design: '目标平台/尺寸、品牌或风格约束、必须保留的元素。',
  decision: '硬性限制（成本/时间/人力）、不可接受的代价。',
  generic: '不能做什么、不能碰什么、有什么硬性限制。',
}

/** 抽取用户原话里已存在的具体对象（作为 context 槽位的素材，不发明新内容）。 */
export function extractAnchors(text) {
  const t = String(text ?? '')
  const found = new Set()
  const patterns = [
    /[A-Za-z]:[\\/][^\s，。；、）)]+/g,
    /[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|py|go|rs|java|c|h|cpp|cs|sql|sh|ps1|html|css|scss|vue|toml|ini|cfg|log|tgz|zip)\b/g,
    /https?:\/\/[^\s，。；、）)]+/g,
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
  ]
  for (const re of patterns) {
    for (const m of t.matchAll(re)) found.add(m[0])
  }
  return [...found].slice(0, 8)
}

/**
 * 生成优化结果。
 *
 * @param {string} raw 用户原文
 * @param {object} [opts]
 * @param {'structured'|'rewrite'} [opts.mode='structured']
 *        structured=保留原话 + 补要素骨架（默认，安全）
 *        rewrite=直接给一份可发送的改写稿（用户原话作为其中一节）
 * @returns {{ok:boolean, reason?:string, text:string, kind:string, notes:string[], anchors:string[]}}
 */
export function optimizePrompt(raw, opts = {}) {
  const mode = opts.mode === 'rewrite' ? 'rewrite' : 'structured'
  const original = String(raw ?? '').trim()
  if (!original) {
    return { ok: false, reason: 'empty', text: '', kind: 'generic', notes: [], anchors: [] }
  }

  const kind = classify(original)
  const anchors = extractAnchors(original)
  const notes = []
  for (const [re, ask] of VAGUE_TRANSLATIONS) {
    if (re.test(original)) notes.push(ask)
  }

  // 已含具体对象 → 说明用户对"对象"是清楚的，context 槽位可以收紧
  const hasConcrete = CONCRETE_RE.test(original)
  const imperative = IMPERATIVE_RE.test(original)

  const acceptance = ACCEPTANCE_HINT[kind] || ACCEPTANCE_HINT.generic
  const constraint = CONSTRAINT_HINT[kind] || CONSTRAINT_HINT.generic

  const lines = []
  lines.push('请按以下要求完成这件事。')
  lines.push('')
  lines.push('## 原始需求（我的原话，请勿曲解）')
  lines.push(original)
  lines.push('')
  lines.push('## 目标（要达成什么）')
  lines.push(hasConcrete
    ? `针对上面提到的对象完成处理${imperative ? '' : '，并按下面验收标准交付'}。**请先用一句话复述你理解的目标，确认无误再动手。**`
    : '**（待补：我自己也还没说清）** 请先别猜——把你不确定的地方列成 1-3 个具体问题问我，或给出你的默认理解让我确认。')
  lines.push('')
  lines.push('## 背景与范围')
  if (anchors.length > 0) {
    lines.push(`涉及对象：${anchors.join('、')}`)
  } else {
    lines.push('（未指明具体文件/模块——请先定位，再动手）')
  }
  lines.push('明确**不做**的部分：（待补：请确认哪些不在范围内）')
  lines.push('')
  lines.push('## 约束')
  lines.push(constraint)
  lines.push('')
  lines.push('## 验收标准（凭什么算完成）')
  lines.push(acceptance)
  lines.push('')
  if (notes.length > 0) {
    lines.push('## 需要先澄清的点（来自我原话里的含糊处）')
    for (const n of notes) lines.push(`- ${n}`)
    lines.push('')
  }
  lines.push('## 执行方式')
  lines.push('信息足够就直接做，不要反复确认；确实有歧义就**一次问完**，不要挤牙膏式追问。')

  if (mode === 'rewrite') {
    // rewrite：只给"可以直接发出去的话"，弱化骨架感
    const rw = []
    rw.push(original)
    rw.push('')
    rw.push(`要求：${hasConcrete ? '先定位再动手' : '先确认理解再动手'}；${acceptance}`)
    rw.push(`约束：${constraint}`)
    if (notes.length > 0) rw.push(`需先澄清：${notes.map(n => n.replace(/^「[^」]*」/, m => m)).join(' ')}`)
    return { ok: true, text: rw.join('\n'), kind, notes, anchors }
  }

  return { ok: true, text: lines.join('\n'), kind, notes, anchors }
}

/** 粗略字数（面板展示用）。 */
export function roughSize(s) { return String(s ?? '').length }
