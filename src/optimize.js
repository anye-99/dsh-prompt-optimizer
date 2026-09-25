/**
 * optimize — 提示词优化核心（纯函数，零 IO，可单测）。
 *
 * 设计立场（这是本插件的宪法，改行为前先读这里）：
 *
 * 1. **不替用户改写意图**。本插件绝不重写用户原话、绝不替换用户消息——
 *    原话永远原样送到模型面前（用户的话是事实，不是草稿）。
 *    优化 = 在原话**之后**补一层结构化引导（近距离注入），让模型把"该问的
 *    先问、该定的先定、该验的想清楚"，而不是让插件替用户说话。
 *
 * 2. **只在"含糊"时开口**。明确、简短、指令型的提示词（"看下 package.json"、
 *    "跑测试"）不该被加戏——加戏是噪音，还会稀释注意力、破坏前缀缓存。
 *    判定为清晰 → 返回 null，插件完全静默（官方零痕迹）。
 *
 * 3. **近距离注入**。引导文本插在用户消息**之后**（生态实测：同一指令放
 *    system 远距离会衰减甚至反向，放用户消息后近距离零衰减）。
 *
 * 4. **静态文本**。引导文本里不含任何会话动态内容（不拼任务原文、不拼时间、
 *    不拼计数）——system/前缀任何动态变化都会让整个会话缓存全量 miss（命中
 *    便宜约 10 倍）。任务原文由模型自己从上下文读，插件不复述。
 */

/** 优化档位：off=完全静默 / lite=只补目标与验收 / full=完整结构化引导。 */
export const LEVELS = ['off', 'lite', 'full']

/** 任务类型（弱判定：命中即用，不命中走通用模板——绝不武断归类）。 */
export const KINDS = ['code', 'research', 'writing', 'design', 'decision', 'generic']

/* ------------------------------------------------------------------ *
 * 一、清晰度判定：决定"该不该开口"
 * ------------------------------------------------------------------ */

/** 指令型动词/祈使开头（"改一下""加个""删掉""看下"）——短但有明确动作。 */
const IMPERATIVE_RE = /^(帮我|请|麻烦|给我|把|将|改|修|加|删|去|跑|运行|执行|查|看|读|打开|建|创建|写个|写一|做一|生成|安装|部署|测试|提交|推送|拉取|重启|停|启动|复制|移动|重命名|格式化|清理|导出|导入|替换|更新|升级|回滚|撤销|比较|对比|统计|列出|找|搜|爬|下载|上传|打包|发布|merge|rebase|commit|push|pull|build|run|fix|add|remove|delete|update|rename|refactor|test|lint|install|deploy|open|read|show|list|check|find|create|make|generate|write|edit|move|copy|export|import|upgrade|revert|rebase)/i

/** 明确的对象指认：路径 / 文件名 / 代码标识 / URL / 行号——"做什么"已经落地到具体对象。 */
const CONCRETE_RE = /([A-Za-z]:[\\/]|\.{0,2}[\\/][\w.-]+|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|py|go|rs|java|c|h|cpp|cs|sql|sh|ps1|html|css|scss|vue|toml|ini|cfg|log|tgz|zip)\b|https?:\/\/|\b\d+(?:\s*[-–~]\s*\d+)?\s*行|\b[\w$]+\(\)|\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b)/

/** 已经是结构化提示的标志：出现小标题/编号清单/字段名——用户自己会写，别抢活。 */
const STRUCTURED_RE = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|【[^】]{1,12}】|(?:目标|要求|约束|验收|背景|任务|输出|格式|步骤|context|goal|requirement|constraint|acceptance|task|output|format)\s*[:：])/im

/** 短促的确认/闲聊/元操作——一律不开口（回"好""继续""嗯"还要被教育一顿是灾难）。 */
const TRIVIAL_RE = /^(好|好的|好滴|行|可以|嗯|哦|ok|okay|收到|明白|了解|继续|接着|go|yes|no|是|不是|对|不对|谢谢|感谢|没事|算了|停|取消|不用了|稍等|等等|hi|hello|你好|在吗|测试|test)\s*[.!。！~]*$/i

/**
 * 代码块/日志/长文粘贴：用户给的是**素材**不是**指令**——这不是"含糊提示词"，
 * 是待处理的内容，别加戏。
 */
const PASTED_BLOB_RE = /(^|\n)\s*(```|~~~|\$ |>\s|Traceback|at\s+[\w$.]+\s*\(|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/m

/**
 * 提问句：用户明确在问——问题清晰，别改写。
 * 两路：① 句尾疑问语气词（吗/呢/么/?）② 句首疑问框架（能不能/可不可以/是否/如何/为什么…）。
 * 只看句尾不够："能不能帮我看看这个架构是否合理" 结尾是"理"。
 */
const QUESTION_RE = /(吗|呢|么|\?|？)\s*$/
const QUESTION_OPEN_RE = /^(能不能|可不可以|能否|是否可以|是否|有没有|要不要|该不该|怎么|如何|为什么|为何|什么时候|哪里|哪个|是不是|什么(?:是|叫)|what|how|why|which|when|where|should\s+i|can\s+you|could\s+you|is\s+it|does\s+it)/i

/**
 * 含糊度信号：说出"更好/优化/完善/自由发挥/感觉不太行"这类**无判据的期望词**，
 * 却没有指明对象与判据——这才是真正的"含糊提示词"。
 */
const VAGUE_SIGNAL_RE = /(更好|好用|优化|完善|提升|改进|美化|优雅|专业|高级|丝滑|流畅|自由发挥|看着办|随便|你懂的|差不多|感觉|好像|似乎|有点问题|不太行|不太好|不满意|不对|奇怪|乱|差|臃肿|乱糟糟|优化一下|弄一下|搞一下|处理一下|整整)/

/**
 * 清晰度判定（返回原因串，null=清晰/不该开口）。
 *
 * 判定顺序 = 从"最不该开口"到"最该开口"，先命中先返回。
 * 判定标准刻意宽松（宁可少开口，不可乱加戏）——误开口是噪音与缓存损失，
 * 漏开口只是没帮上忙，代价不对称。
 */
export function clarityVerdict(text, opts = {}) {
  const t = String(text ?? '').trim()
  const minLen = Number.isInteger(opts.minLen) ? opts.minLen : 12
  if (!t) return null
  if (TRIVIAL_RE.test(t)) return null
  if (PASTED_BLOB_RE.test(t)) return null
  if (STRUCTURED_RE.test(t)) return null
  if (QUESTION_RE.test(t) || QUESTION_OPEN_RE.test(t)) return null

  // 含具体对象（路径/文件/标识符/URL/行号）= 用户知道在说哪个东西
  const concrete = CONCRETE_RE.test(t)

  // 判定核心：**有没有含糊信号**。有 → 开口；没有 → 放行。
  // 注意：不能用"长度 ≤ N 且祈使开头"就直接放行——"帮我优化一下这个项目，让它
  // 变得更好用一些" 正是祈使开头且不够长，却恰恰是最该开口的含糊句（早期 bug）。
  const vagueSignal = VAGUE_SIGNAL_RE.test(t)

  if (vagueSignal) {
    // 有含糊信号，但同时把对象与判据都点明了（具体对象 + 足够长）→ 视作清晰
    if (concrete && t.length > 120) return null
    return t.length >= minLen ? 'vague' : null
  }

  // 无含糊信号：带具体对象 + 指令动作 = 明确的动作指令，别加戏
  if (concrete) return null

  // 无含糊信号、无具体对象：短句多半是明确动作（"跑测试""删掉缓存"）；长句多半是含糊需求
  if (IMPERATIVE_RE.test(t) && t.length <= (opts.imperativeMax ?? 40)) return null
  if (t.length < minLen) return null
  return 'vague'
}

/* ------------------------------------------------------------------ *
 * 二、任务类型弱判定（决定引导重心；模糊就不猜）
 * ------------------------------------------------------------------ */

/**
 * 类型信号。顺序 = 优先级，但**先判"任务动词"再判"领域名词"**——
 * 否则"帮我对比这两个数据库方案的优劣"会因命中"数据库"被误判成 code，
 * 而它的真实诉求是对比评估（research）。
 * 因此 research/decision 这类"任务本质"信号排在 code 这类"领域"信号之前。
 */
const KIND_HINTS = [
  ['research', /(分析|调研|研究|对比|比较|评估|选型|论证|查证|来源|文献|综述|为什么|原理|机制|优劣|利弊|分析一下|analy|research|compare|evaluat|investigat|survey|why|mechanism)/i],
  ['decision', /(要不要|该不该|选哪个|哪个好|怎么选|方案|取舍|权衡|决策|建议|推荐|recommend|choose|should i|trade-?off|decision)/i],
  ['writing', /(写一篇|文案|文章|报告|文档|总结|摘要|润色|翻译|邮件|周报|日报|说明|草稿|write|article|report|doc|summar|polish|translat|email)/i],
  ['design', /(设计|界面|视觉|布局|配色|交互|体验|原型|样式|ui|ux|design|layout|visual|prototype|style)/i],
  ['code', /(代码|函数|组件|接口|api|bug|报错|异常|崩溃|性能|重构|编译|构建|依赖|数据库|sql|类|模块|仓库|提交|部署|code|function|component|api|bug|error|crash|refactor|build|deploy|database)/i],
]

/** 弱判定：命中即用；命中多个取第一个（顺序=优先级）；零命中=generic。 */
export function classify(text) {
  const t = String(text ?? '')
  for (const [kind, re] of KIND_HINTS) if (re.test(t)) return kind
  return 'generic'
}

/* ------------------------------------------------------------------ *
 * 三、引导文本：静态、近距离、只问"该问的"
 * ------------------------------------------------------------------ */

/**
 * 通用骨架（所有类型共用）——三件事：目的、边界、验收。
 * 这是在治"含糊提示词"的真正病根：不是措辞不好，是**信息不全**就开工了。
 */
const CORE = `在动手前，先在心里把这三件事补齐（缺的要么问我，要么写成假设并说明——**不要默默替你猜**）：
1. **要达成什么**：这件事做完后，什么变化说明它成了？（可观测的结果，而不是"做完了"）
2. **边界在哪**：明确不做什么、不能碰什么、有什么硬约束（环境/技术栈/时间/风格）。
3. **怎么算通过**：我凭什么判断你说的是对的？（会看哪个产物、跑哪个命令、对哪个数）

补齐后直接开工——**不必把这三条复述给我**（除非有真的歧义要澄清）。`

/** 类型重心（一句话，只给最相关的那条）。 */
const KIND_FOCUS = {
  code: `**代码类重心**：改前先定位真实病根（复现→定位→再改），别按猜测动手；改完要跑通验证（编译/测试/实跑至少一项），没验证不得宣称修好；不顺手重构无关代码。`,
  research: `**调研类重心**：结论必须有来源或推导链，区分"查到的"与"我推断的"；给出可复核的复现路径；证据不足就明说不足，不要用漂亮话补洞。`,
  writing: `**写作类重心**：先定读者与用途（给谁看、看完要做什么），再定结构与详略；写完通读一遍改掉套话与水词。`,
  design: `**设计类重心**：先明确使用者与使用场景，再谈视觉；给可看的产物（截图/原型）而不是文字描述，判断"好不好用"要真的过一遍。`,
  decision: `**决策类重心**：先列判据与权重，再摆选项做对照；明确推荐一个并说清代价与风险；不搞"各有优劣、看情况"的和稀泥。`,
  generic: '',
}

/** 档位=lite 时的精简骨架（更省 token）。 */
const CORE_LITE = `动手前先补齐：**要达成什么**（可观测的结果）、**边界**（不做什么/硬约束）、**怎么算通过**（凭什么判断对了）。信息不足就问，或写明假设——不要默默替我猜。`

/**
 * 构建注入的引导文本（纯函数：同输入必同输出——静态文本，缓存友好）。
 *
 * @param {string} kind   classify() 的输出
 * @param {string} level  'lite' | 'full'
 * @returns {string}      注入正文（含头部标识）
 */
export function buildGuidance(kind, level = 'full') {
  const focus = level === 'full' ? (KIND_FOCUS[kind] || '') : ''
  const core = level === 'full' ? CORE : CORE_LITE
  const parts = [
    '【提示词优化·自查】你的上一条消息信息不完整（不是措辞问题，是要素缺失）。我不改你的话，只提醒你补齐：',
    core,
  ]
  if (focus) parts.push(focus)
  parts.push('（本条为插件自动提示；若你判断已足够明确，直接按我原话执行，忽略以上。）')
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ *
 * 四、辅助：token 估算与去重键
 * ------------------------------------------------------------------ */

/** 粗略字符量（用于审计与面板展示，不做精确 tokenizer——避免引入依赖）。 */
export function roughSize(s) {
  return String(s ?? '').length
}

/**
 * 去重键：同一会话同一文本只提示一次。
 * 用文本指纹而非轮次——用户重复粘贴同一句含糊话，第二次不该再教育一遍。
 */
export function dedupeKey(text) {
  const t = String(text ?? '').trim()
  let h = 0
  for (let i = 0; i < t.length; i++) {
    h = (h * 31 + t.charCodeAt(i)) | 0
  }
  return 'po:' + (h >>> 0).toString(36)
}
