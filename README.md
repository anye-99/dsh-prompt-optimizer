# dsh-prompt-optimizer — 提示词优化器

> 两种用法，同一套规则：**提示词框里的「优化」按钮**（手动，点一下改写当前草稿）
> 和**会话内实时优化**（自动，含糊提示词出现时补引导）。
> 都不改你的意思——只补你漏掉的要素。

## 一、提示词框「优化」按钮（手动）

在提示词输入框里、发送按钮左侧，有一个 **✦ 优化** 按钮：

```
┌─────────────────────────────────────────────┐
│ 帮我优化一下这个项目，让它更好用一些          │  ← 你写的
│                                             │
│         [✦ 优化]  [模型 ▾]  [发送]           │  ← 点这里
└─────────────────────────────────────────────┘
                      ↓ 点击后（草稿被改写）
┌─────────────────────────────────────────────┐
│ 请按以下要求完成这件事。                      │
│                                             │
│ ## 原始需求（我的原话，请勿曲解）             │
│ 帮我优化一下这个项目，让它更好用一些          │  ← 原话一字不改
│                                             │
│ ## 目标（要达成什么）                        │
│ **（待补：我自己也还没说清）** 请先别猜——     │  ← 没说清的留白
│ 把你不确定的地方列成 1-3 个问题问我…          │
│                                             │
│ ## 背景与范围 / ## 约束 / ## 验收标准 …       │
│                                             │
│ ## 需要先澄清的点                            │
│ - 「更好用」需要落到可观测处：少点几次？…      │  ← 含糊词被翻成问题
└─────────────────────────────────────────────┘
```

**关键行为：**

| 行为 | 说明 |
|---|---|
| **只改草稿，不发送** | 你检查、修改、自己按发送。绝不替你点发送 |
| **原话完整保留** | 你的原话作为独立一节原样保留，绝不删改 |
| **没说的不编** | 你说不清的部分留成「待补」或转成提问，**不替你发明意图** |
| **含糊词翻成问题** | 「更好用」「优化一下」「自由发挥」→ 变成"需要澄清的点" |
| **自动提取对象** | 识别到你提到的文件/路径/函数名，归入背景槽位 |
| **按类型给验收** | 代码类给"跑通验证"，调研类给"标注来源"，写作类给"先定读者"… |

按钮状态：`优化` → `已优化`（绿字，3 秒后复原）；空草稿会提示"先写点什么"；失败只提示不崩。

## 二、会话内实时优化（自动）

不点按钮时的兜底：你发出**含糊**提示词，插件会在模型动手前自动补一层自查引导。

```
你说：「帮我优化一下这个项目，让它变得更好用一些，感觉有很多地方不太行」
                    ↓  原话原样送达，一个字不改
模型看到：你的原话（照旧）
        + 【提示词优化·自查】动手前补齐 ① 要达成什么 ② 边界在哪 ③ 怎么算通过
        + （代码类重心：先定位真实病根、改完必须跑通验证）
```

**清晰提示词一律放行**（`看下 package.json`、`跑测试`、`好`、粘贴的代码/报错）——加戏就是噪音。

## 它解决什么问题

含糊提示词真正的病根**不是措辞不好，是信息不全就开工了**——
"帮我优化一下这个项目"缺的不是文字技巧，是：为谁优化、优化到什么算成、凭什么验收。
模型于是开始猜，猜错了返工，返工了你才发现方向不对。

本插件在模型动手前，把这三件事摆到它面前。

## 怎么工作（一句话）

监听用户消息 → 判定是否"含糊" → **在用户消息之后**注入一段结构化自查引导 → 模型动手前补齐【目的 / 边界 / 验收】。

```
你说：「帮我优化一下这个项目，让它变得更好用一些，现在感觉有很多地方不太行」
                    ↓  原话原样送达，一个字不改
模型看到：你的原话（照旧）
        + 【提示词优化·自查】动手前补齐：① 要达成什么 ② 边界在哪 ③ 怎么算通过
        + （类型重心：代码类 → 先定位真实病根、改完必须跑通验证）
```

## 四条设计铁律（边界即特性）

| 铁律 | 为什么 |
|---|---|
| **绝不改写用户原话** | 你的话是事实，不是草稿。插件只在后面**补一层引导**，不替你说话 |
| **清晰提示词一律放行** | "看下 package.json""跑测试"加戏=噪音，还稀释注意力。误开口的代价远大于漏开口 |
| **不碰 system prompt** | 判定是动态的，而 system 前缀任何动态变化会让**整个会话缓存全量 miss**（命中便宜约 10 倍）。故：动态判定在前，注入文本**零动态拼接**（静态，可缓存） |
| **零工具注册** | 不占工具目录开销（工具 schema 按字符计费进首轮 prefill），纯引导层 |

注入位遵循生态实测结论：**近距离（用户消息之后）零衰减**，同一指令放 system 远距离会衰减甚至反向。

## 什么时候**不**开口

判定刻意宽松——只在真正含糊时开口。以下一律静默：

- **明确指令**：`看下 package.json`、`跑测试`、`改 src/index.js 第 42 行`、`fix the bug in auth.js`
- **结构化提示**：用户自己写了 `目标：/约束：/验收：`、编号清单、`【要求】` 小标题
- **提问句**：`这个怎么实现比较好呢`、`能不能帮我看看这个架构是否合理`
- **闲聊/确认**：`好`、`继续`、`嗯`、`ok`、`收到`、`算了`
- **粘贴的素材**：代码块、堆栈、日志、`$ 命令`——那是**内容**不是**指令**
- **短句**：低于 `minLen`（默认 12 字）
- **已提示过的同一句**：去重（重复粘贴同一句不再教育第二遍）
- **插件自己的注入**：绝不基于自己的引导再触发（防无限套娃）

## 安装（已完成）

已装配进 **`~/.dsh/profiles/desktop`**（实际在用的）与 `web`：

```jsonc
// package.json
"@dsh-external/dsh-prompt-optimizer": "link:D:/.../dsh-routing-suite/prompt-optimizer"
// dsh.profile.bundles 已追加 "@dsh-external/dsh-prompt-optimizer"
// pnpm-lock.yaml importers 已记录该 link: 依赖（用 pnpm install --lockfile-only 写入，未动 node_modules）
```

**重启 DSH 后自动装配**；本插件不注册工具，装配后无工具目录变化。

### ⚠️ 插件管理器会在背后"关闭"插件（三处同时下手）

**这是本项目踩得最深的一个坑**，症状是：插件**静默不加载**——不报错，按钮不出现，
命令不可用，且**重启也不会恢复**。

DSH 自带的插件管理器（`dsh-market`）关闭一个插件时，会**同时**改三处
（`.dsh-market/log.ndjson` 原话）：

```
"@dsh-external/dsh-prompt-optimizer -> off: fiber=true"
"dsh.profile.bundles removed so the official page's package switch agrees (#696)"
"patch layer disabled rows dsh-prompt-optimizer"          → cordis.patch.yml
"@dsh-external/dsh-prompt-optimizer: off ok=true"          → .dsh-market/state.json
```

重启时的判定：
```
"@dsh-external/dsh-prompt-optimizer -> off: fiber=false"
"plugin kept off: @dsh-external/dsh-prompt-optimizer"      ← 记住了关闭状态
```

| # | 位置 | 被改成什么 |
|---|---|---|
| ① | `package.json` → `dsh.profile.bundles` | 条目**被删除** |
| ② | `cordis.patch.yml` | 追加 `- id: dsh-prompt-optimizer` + `disabled: true` |
| ③ | `.dsh-market/state.json` | `disabled` 数组加入该包名 |

**三处任一残留都不会加载。** 排查一条命令：

```bash
node scripts/verify-enabled.mjs          # 6/6 通过 = 真正启用
# 查 web profile：
PO_PROFILE=C:/Users/33313/.dsh/profiles/web node scripts/verify-enabled.mjs
```

修复 = 删掉 ② 的 disabled 行 + 清空 ③ 的 disabled 数组 + 把 ① 加回去，然后重启。

> 顺带：该管理器**在 UI 里点关闭**或**识别到插件被停用**时都会走这套流程；
> 本插件曾被连点两次（日志里 `-> off` 出现 4 次）。如果你在插件页看到它显示为关闭，
> 请开着——那才是它该有的状态。

### ⚠️ 本地依赖链接（生态硬性约定，漏了必挂）

junction 装配的插件，其 `import` 从**包自身**的 `node_modules` 解析（Node 按**真实路径**
解析，不是 profile 的）。所以本目录**必须**自带依赖链接：

```
prompt-optimizer/node_modules/@deepseek-ai/schemastery  →  profile 的 schemastery
```

不链的后果：`Cannot find package '@deepseek-ai/schemastery'` → 重启后装配直接失败。
（同 profile 的 `dsh-super-injector` 也是这么做的——其 README「踩坑记录」有原话：
*插件包必须自带依赖链接*。）
本目录的 `node_modules/` 已在 `.gitignore` 中，由安装步骤创建。

### 客户端半的构建（无 bundler）

本机 profile 里**没有** tsdown/esbuild/rollup，但 DSH 的 client bundle 格式极简——
就是一个 `window.__ModuleLoader__.load({ id, factory })` 包装，外部依赖走 `require(...)`，
React 来自宿主冻结的 `PLATFORM_MODULES` 基线。所以手写构建即可：

```bash
node scripts/build-client.mjs     # src/ → lib/client.js
```

改 `src/optimize-core.js` 或 `src/client/index.js` 后**必须重跑**，否则 lib 是旧的。

`dsh-client-modules` 会自动扫描 `dsh.client` 声明并把它发布为 `/plugins` 下的 bundle，
**无需任何额外接线**。

### 装配终验（预演一次重启装配）

```bash
node scripts/verify-install.mjs     # 12/12 通过
```

它做的事 = **DSH 启动时 bundle 装配的完整路径**：从 profile 解析 `package.json` →
读 `dsh.bundle.patch` → 校验 patch 是单一顶层数组 → 按 `entry.name` 真 `import` 主模块
→ 校验导出契约（`apply`/`name`/`inject`）。**这一步抓到过真 bug**：早期缺本地
依赖链接，文件全在、结构全对，但 `import` 失败——只看"文件存在"是查不出来的。

## 用法

### 按钮

提示词框内、发送键左侧点 **✦ 优化**。改完草稿自己检查、自己发送。

### 命令

```
/optimize            查看状态（开关/档位/命中统计）
/optimize on         本会话开启自动优化
/optimize off        本会话关闭自动优化（按钮仍可用）
/optimize full       档位=full（三要素 + 类型重心）
/optimize lite       档位=lite（仅三要素精简版，省 token）
```

## 档位（作用于自动模式）

| 档位 | 内容 | 适用 |
|---|---|---|
| `off` | 自动模式完全静默 | 干活时不想要任何插话（按钮不受影响） |
| `lite` | 三要素精简骨架 | 想省 token、只要最低限度提醒 |
| `full`（默认） | 三要素 + 按任务类型给重心 | 常态 |

任务类型弱判定（命中即用，不命中走通用模板，绝不武断归类）：
`code` / `research` / `writing` / `design` / `decision` / `generic`。
**先判任务动词再判领域名词**——"对比这两个数据库方案"是 research（对比评估），不是 code。

## 设置与审计端点

```bash
GET  /prompt-optimizer/api/settings?sid=<sid>
PUT  /prompt-optimizer/api/settings?sid=<sid>   # {level, minLen, cooldownTurns, scope}
GET  /prompt-optimizer/api?sid=<sid>            # 计数/命中率/去重表大小
```

设置两级：全局（`~/.dsh/prompt-optimizer-settings.json`）< 会话覆盖（`.settings.json`）。
状态磁盘单轨（`~/.dsh/prompt-optimizer/<sid>.json`）——注入判定与命令读写同一份快照，
热重载/重启天然恢复，杜绝"内存说注过了、磁盘说没注"的双注根因。

## ⚠️ 生态坑：`source.kind = 'plugin'` 已被 session format v4 拒收

**症状**：每一轮都红字报 `本轮运行失败：format v4 message requires a producer-owned source kind`。

**根因**（源码依据）：

```js
// @deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs
// (= session-format-v3-to-v4/src/message-sources.ts)
function source(message) {
  const value = message["source"];
  if (!isSessionFormatJsonObject(value)
      || typeof value["kind"] !== "string"
      || value["kind"].length === 0
      || value["kind"] === "plugin")            // ← 就是这里
    throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
```

`kind: 'plugin'` 是**已退役的 V3 包装器语义**。v3→v4 迁移只为**白名单里的历史插件名**
自动改写（`rewritePluginSource`），**新插件用它就是持久化失败**。

**为什么容易被误用**：生态里的老插件（如 `dsh-graded-mode`）源码里就是这么写的，
照抄就会踩中。区别在于**注入的消息会不会进持久化**：

| 注入方式 | 是否进持久化 | `kind:'plugin'` 后果 |
|---|---|---|
| `agent.followup()` / 仅改当轮 `decision.messages` | 否（瞬时） | 侥幸不报错 |
| 消息进入会话事件流（含 resume 重放） | **是** | **整轮运行失败** |

本插件的自动注入会进入事件流，所以必然触发。

**正解**：用 producer-owned kind，自身来源改走**额外字段**标记：

```js
source: { kind: 'user', producer: 'dsh-prompt-optimizer' }
//        ↑ v4 接受          ↑ 额外字段被保留（迁移只过滤 `plugin` 键）
```

`kind` 必须是**非空字符串且不为 `'plugin'`**；`role: 'user'` 配 `kind: 'user'` 是官方配对
（bundle 里构造 user 消息即 `source: { kind: "user" }`）。

本插件已加**注入前自检**（`validateSource()` 复刻上述规则）：不合法就静默跳过本轮注入，
**绝不把用户的一轮对话搞挂**。

## 测试

```bash
node --test "tests/core.test.mjs" "tests/optimize.test.mjs" "tests/inject.test.mjs" "tests/apply.test.mjs"   # 37 项
node tests/client-bundle.test.mjs   # 20 项：在假浏览器里真跑 client bundle
node scripts/verify-install.mjs     # 15 项：预演一次重启装配
```

- `core.test.mjs` — **按钮改写器**：原话保真、缺信息留白、类型验收建议
- `optimize.test.mjs` — 自动模式的判定边界（**"必须静默"的用例远多于"必须开口"**，代价不对称）
- `inject.test.mjs` — 挑哪条消息判定、注入插在哪一位、**v4 source 合法性回归**
- `apply.test.mjs` — host 半装配自检：真跑 `apply()`，验证注入/放行/去重/防套娃
- `client-bundle.test.mjs` — client 半装配自检：bundle 注册、点击写回、**DOM 兜底**、降级不崩

**这些检查抓到过真 bug**（不是走过场）：

1. **`source.kind = 'plugin'`** —— session format v4 拒收，导致**整轮运行失败**
   （用户看到一屏红字）。这条是用户在真实使用中撞到的，不是测试先发现的——
   现已补上回归测试 + 注入前自检。
2. **缺本地依赖链接** —— 文件全在、结构全对，但从 profile 路径 `import` 失败
3. **`ctx.slots.inject()` 抛出未捕获** —— 早期只守住了回调，`inject` 本身抛出会一路
   冒到插件加载，**把 GUI 启动带崩**
4. **bundle id 与包名不一致** —— 测试用短名查找，实际 bundle 以完整包名注册
5. **slot 组件拿不到 `inputActions`** —— 渲染点是 `renderSlot(name, {})`，传的是**空 owner
   props**；`inputActions` 是经 slot 作用域下发的标准 prop。现已多层查找 + DOM 兜底，
   且**拿不到也不禁用按钮**

> `src/channel.js` 与 `src/index.js` 分开的原因：`index.js` 依赖 `@deepseek-ai/schemastery`
> （由 profile 的 node_modules 运行时提供，源码目录没有），纯逻辑必须分家，单测才跑得起来。

## 结构

```
src/optimize.js        自动模式的判定器（该不该开口）
src/optimize-core.js   按钮模式的改写器（点了按钮后产出什么）← 两形态共享规则
src/channel.js         注入通道纯逻辑（消息筛选/插位/审计体/v4 source 自检）
src/state.js           磁盘单轨状态 + 两级设置
src/index.js           host 半：命令 / 路由 / pre-step 注入
src/client/index.js    client 半：composer 按钮组件
lib/client.js          构建产物（勿手改）
scripts/build-client.mjs   无依赖构建
```

### 挂载点（供后续维护）

按钮挂在 `conversation.input.right`（`kind: "list"`, `scope: "session"`）——
提交按钮左侧的紧凑控件区，与模型选择器同一行，`order: 30`。
先例：`@linxin666/dsh-liangshen` 的梁神拉杆（同 slot，order=20）。

> **注意**：该 slot 的渲染点是 `renderSlot("conversation.input.right", {})` —— owner props
> 是**空对象**。所以组件里**不能**只从 `props.inputActions` 顶层找，必须考虑标准 prop
> 的下发位置差异，并准备 DOM 兜底。

读写草稿优先走官方 `inputActions` face（经 slot 作用域下发的标准 prop）：

| 方法 | 用途 |
|---|---|
| `setDraft(text)` | **整稿替换**（按钮用的就是这个） |
| `captureInsertion()` | 取光标位置 + draftRev |
| `insertText(text, span)` | 受 draftRev 保护的 undoable 插入 |
| `submit()` | 提交（**本插件不用**——绝不替用户发送） |

拿不到 `inputActions` 时降级：读 `[contenteditable="true"]` 的 `innerText`，
写用 `document.execCommand('insertText')`（会触发 React/Lexical 的 input 事件，
草稿状态能同步；直接改 `innerText` 会让编辑器状态与 DOM 脱节）。

---
BSD-3-Clause
