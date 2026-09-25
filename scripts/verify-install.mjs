/**
 * 装配终验（模拟 DSH 启动时的 bundle 装配路径）：
 *   1. 从 profile 的 node_modules 解析本插件的 package.json（= loader 的解析方式）
 *   2. 读 dsh.bundle.patch 指向的 cordis.patch.yml，确认是**单一顶层数组**
 *   3. 按 entry.name 真 import 插件主模块（= loader 的 import 方式）
 *   4. 校验导出契约（apply/name/inject）
 *
 * 为什么必须做：前期只验证了"文件存在"，但真正的失败点是**从 profile 解析**——
 * junction、软链、node_modules 布局任一环节错了，重启后装配就会失败。
 * 本脚本用 profile 自己的路径去解析，等于预演了一次重启装配。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// profile 目标可切换：默认验 desktop（实际在用的），PO_PROFILE 可覆盖为 web
const PROFILE = process.env.PO_PROFILE || 'C:/Users/33313/.dsh/profiles/desktop'
const NAME = '@dsh-external/dsh-prompt-optimizer'
const results = []
const ok = (label, detail = '') => results.push({ pass: true, label, detail })
const bad = (label, detail = '') => results.push({ pass: false, label, detail })

// 1. 从 profile 解析
const pkgDir = join(PROFILE, 'node_modules', NAME)
const pkgJsonPath = join(pkgDir, 'package.json')
if (!existsSync(pkgJsonPath)) {
  bad('从 profile 解析 package.json', pkgJsonPath)
} else {
  ok('从 profile 解析 package.json', pkgJsonPath)
}

let pkg = null
try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) } catch (e) { bad('package.json 可解析', String(e)) }

// 2. bundle patch 合法性（顶层单一数组——SPEC 硬契约）
if (pkg) {
  const patchRel = pkg?.dsh?.bundle?.patch
  if (!patchRel) bad('声明 dsh.bundle.patch')
  else {
    const patchPath = join(pkgDir, patchRel)
    if (!existsSync(patchPath)) bad('patch 文件存在', patchPath)
    else {
      ok('patch 文件存在', patchPath)
      const raw = readFileSync(patchPath, 'utf-8')
      // 轻量解析：只校验"单一顶层数组 + 含 insert + id/name 正确"，避免依赖 yaml
      const insertCount = (raw.match(/^\s*-\s*insert:/gm) || []).length
      if (insertCount !== 1) bad('patch 顶层恰一个 insert 块', `实际 ${insertCount}`)
      else ok('patch 顶层恰一个 insert 块')
      if (!raw.includes(`id: dsh-prompt-optimizer`)) bad('patch 含正确 entry id')
      else ok('patch 含正确 entry id')
      if (!raw.includes(`name: '${NAME}'`)) bad('patch 的 name 与包名一致')
      else ok('patch 的 name 与包名一致')
    }
  }
}

// 3. 按 main 真 import（loader 的 import 方式）
if (pkg) {
  const mainPath = join(pkgDir, pkg.main || './src/index.js')
  if (!existsSync(mainPath)) bad('main 入口存在', mainPath)
  else {
    ok('main 入口存在', mainPath)
    try {
      const mod = await import(pathToFileURL(mainPath).href)
      ok('从 profile 路径真 import 成功')
      // 4. 导出契约
      if (typeof mod.apply !== 'function') bad('导出 apply()')
      else ok('导出 apply()')
      if (mod.name !== 'dsh-prompt-optimizer') bad('导出 name', String(mod.name))
      else ok('导出 name', mod.name)
      if (!Array.isArray(mod.inject)) bad('导出 inject 数组')
      else ok('导出 inject', JSON.stringify(mod.inject))
    } catch (e) {
      bad('从 profile 路径真 import', e?.message || String(e))
    }
  }
}

// 5. 客户端半：bundle 契约（DSH 会把它发布为 /plugins 下的 bundle）
if (pkg) {
  const clientRel = pkg?.exports?.['./client']?.default
  const declClient = pkg?.dsh?.client
  if (!clientRel) bad('声明 exports["./client"]')
  else {
    const clientPath = join(pkgDir, clientRel)
    if (!existsSync(clientPath)) bad('client bundle 存在', clientPath)
    else {
      ok('client bundle 存在', clientRel)
      const src = readFileSync(clientPath, 'utf-8')
      // bundle 契约：window.__ModuleLoader__.load({ id, factory })
      if (!src.includes('__ModuleLoader__')) bad('bundle 用 __ModuleLoader__.load 注册')
      else ok('bundle 用 __ModuleLoader__.load 注册')
      // id 必须是完整包名（与 @linxin666/dsh-liangshen 同约定）
      if (!src.includes(`id: ${JSON.stringify(pkg.name)}`)) bad('bundle id = 完整包名', pkg.name)
      else ok('bundle id = 完整包名')
      if (!/factory:\s*\(require\)/.test(src)) bad('bundle 导出 factory(require)')
      else ok('bundle 导出 factory(require)')
    }
  }
  if (!declClient || declClient.platform !== 'web') bad('声明 dsh.client.platform = web')
  else ok('声明 dsh.client.platform = web')
}

// 6. 与同 profile 的既有插件对照（结构一致性）
for (const peer of ['@dsh-external/dsh-graded-mode', '@dsh-external/dsh-super-injector']) {
  const pd = join(PROFILE, 'node_modules', peer, 'package.json')
  if (existsSync(pd)) ok(`对照插件可解析: ${peer}`, 'ok')
}

const failed = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? '  OK  ' : ' FAIL '} ${r.label}${r.detail ? '  — ' + r.detail : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
