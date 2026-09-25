/**
 * 启用状态自检：确认插件在 profile 的三个位置都处于**启用**状态。
 *
 * 为什么要单独一个脚本：本插件被 DSH 自带的插件管理器（dsh-market）**在背后
 * 关闭过**——它会把插件同时从三处拿下，而且重启后会"记住"关闭状态：
 *
 *   1. `dsh.profile.bundles` 移除该条目
 *      （日志原话：dsh.profile.bundles removed so the official page's package switch agrees (#696)）
 *   2. `cordis.patch.yml` 写入 `- id: <entry> / disabled: true`
 *      （日志原话：patch layer disabled rows ...）
 *   3. `.dsh-market/state.json` 的 disabled 数组加入该包名
 *      （重启时据此判定 "plugin kept off"）
 *
 * 三处任一残留，插件都不会加载——表现就是"按钮没出现/命令不可用"，
 * 而且**不报错**（静默不加载），极难排查。所以做成脚本，一条命令查清。
 *
 * 用法：
 *   node scripts/verify-enabled.mjs                          # 默认查 desktop
 *   PO_PROFILE=C:/.../profiles/web node scripts/verify-enabled.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const NAME = '@dsh-external/dsh-prompt-optimizer'
const ENTRY_ID = 'dsh-prompt-optimizer'
const PROFILE = process.env.PO_PROFILE || 'C:/Users/33313/.dsh/profiles/desktop'

const results = []
const ok = (l, d = '') => results.push({ pass: true, l, d })
const bad = (l, d = '') => results.push({ pass: false, l, d })

/** 极简 YAML 行扫描（避免依赖 yaml 包；只看我们关心的 disabled 行）。 */
function patchHasDisabledRow(text) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*id:\s*['"]?([\w@/.-]+)['"]?\s*$/)
    if (!m || m[1] !== ENTRY_ID) continue
    // 该 id 之后的若干行里若有 disabled: true，即视为被禁用
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (/^\s*-\s*id:/.test(lines[j])) break
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) return true
    }
  }
  return false
}

// ---- 1. bundle 列表 ----
const pkgPath = join(PROFILE, 'package.json')
if (!existsSync(pkgPath)) bad('profile package.json 存在', pkgPath)
else {
  let pj = null
  try { pj = JSON.parse(readFileSync(pkgPath, 'utf-8')) } catch (e) { bad('package.json 可解析', String(e)) }
  if (pj) {
    const bundles = pj?.dsh?.profile?.bundles || []
    if (bundles.includes(NAME)) ok('① dsh.profile.bundles 含该插件')
    else bad('① dsh.profile.bundles **缺少**该插件', '插件管理器会移除这一行来关闭插件')
    const dep = pj?.dependencies?.[NAME]
    if (dep) ok('② package.json dependencies 含该插件', dep)
    else bad('② dependencies **缺少**该插件', 'junction 不会被 pnpm 维持')
  }
}

// ---- 2. patch 层 disabled 行 ----
const patchPath = join(PROFILE, 'cordis.patch.yml')
if (!existsSync(patchPath)) bad('cordis.patch.yml 存在', patchPath)
else {
  const txt = readFileSync(patchPath, 'utf-8')
  if (patchHasDisabledRow(txt)) bad('③ cordis.patch.yml **存在 disabled 行**', `- id: ${ENTRY_ID} / disabled: true`)
  else ok('③ cordis.patch.yml 无 disabled 行')
}

// ---- 3. dsh-market 状态 ----
const statePath = join(PROFILE, '.dsh-market', 'state.json')
if (!existsSync(statePath)) ok('④ 无 dsh-market 状态文件（跳过）')
else {
  try {
    const st = JSON.parse(readFileSync(statePath, 'utf-8'))
    const dis = Array.isArray(st?.disabled) ? st.disabled : []
    if (dis.includes(NAME)) bad('④ dsh-market disabled 列表**含该插件**', '重启时会被判定 "plugin kept off"')
    else ok('④ dsh-market 未禁用该插件')
  } catch (e) {
    bad('④ dsh-market state.json 可解析', String(e))
  }
}

// ---- 4. junction + client bundle 实际可达 ----
const pkgDir = join(PROFILE, 'node_modules', NAME)
if (!existsSync(join(pkgDir, 'package.json'))) bad('⑤ junction 可达', pkgDir)
else ok('⑤ junction 可达')
if (!existsSync(join(pkgDir, 'lib', 'client.js'))) bad('⑥ client bundle 可达（按钮靠它）')
else ok('⑥ client bundle 可达')

const failed = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? '  OK  ' : ' FAIL '} ${r.l}${r.d ? '  — ' + r.d : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('\n修复：删掉 cordis.patch.yml 里的 disabled 行、清空 .dsh-market/state.json 的 disabled，')
  console.log('并把插件名加回 dsh.profile.bundles，然后重启 DSH。')
}
process.exit(failed.length === 0 ? 0 : 1)
