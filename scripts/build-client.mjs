/**
 * 构建 client bundle（无需 bundler）。
 *
 * 为什么手写构建而不是用 tsdown：本机 profile 里没有 tsdown/esbuild/rollup 等任何
 * 打包器，而 DSH 的 client bundle 格式极简——就是一个
 * `window.__ModuleLoader__.load({ id, factory })` 包装，外部依赖走 `require(...)`。
 * 这个格式手写完全可控，且能保证"源码改动 → 重新生成"是确定性的。
 *
 * 本脚本：把 src/optimize-core.js 与 src/client/index.js 的内容内联进 factory，
 * 产出 lib/client.js。只用字符串处理，不引入任何依赖。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const coreSrc = readFileSync(join(root, 'src', 'optimize-core.js'), 'utf-8')
const clientSrc = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf-8')

/** 去掉 ESM 的 import/export 语法，转成 factory 内的普通声明（顺序即依赖序）。 */
function stripEsm(src) {
  return src
    // 去掉 import 语句（本 bundle 的模块间依赖已由拼接顺序解决）
    .replace(/^\s*import\s+[^;\n]*from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    // export default { ... } → const __default = { ... }
    .replace(/^\s*export\s+default\s+/gm, 'const __defaultExport = ')
    // export function/const/class → 去掉 export 关键字
    .replace(/^\s*export\s+(function|const|let|var|class)\b/gm, '$1')
    // export { a, b } 形式（本工程未用，保险处理）
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
}

const coreJs = stripEsm(coreSrc)
const clientJs = stripEsm(clientSrc)

const out = `/**
 * ${pkg.name} — 浏览器半（自动生成，请勿手改；改 src/ 后跑 node scripts/build-client.mjs）
 *
 * 格式 = DSH client bundle 契约：window.__ModuleLoader__.load({ id, factory })。
 * 执行本文件只注册 factory；模块体副作用（含 CSS 注入）在 materialize 时才跑。
 */
window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/* ---- 外部依赖（宿主提供，走 require） ---- */
		let react = require("react");

		/* ==================== src/optimize-core.js ==================== */
${coreJs.split('\n').map(l => '\t\t' + l).join('\n')}

		/* ==================== src/client/index.js ==================== */
${clientJs.split('\n').map(l => '\t\t' + l).join('\n')}

		/* ---- 把 React 交给组件（避免组件内再 require，保持单一来源） ---- */
		OptimizeButton._react = react;

		exports.apply = apply;
		exports.inject = inject;
		exports.OptimizeButton = OptimizeButton;
		exports.optimizePrompt = optimizePrompt;
		exports.default = __defaultExport;
		/*
		 * 契约要点（2026-09-26 实测，官方 decoration 模板为准）：
		 * factory **直接返回插件对象本身** { inject, apply }。
		 *
		 * 不要依赖 module.exports + default 让宿主走 unwrapExports 兜底——
		 * unwrapExports 是 exports.default ?? exports，任何一处漏带 inject 都会让
		 * plugin.inject 变 undefined，ctx.slots 拿不到，apply 首行 return：
		 * 表现为插件管理页该组件行「异常」、且按钮永不出现。
		 * 直接返回插件对象，与官方模板一一对应，不依赖任何 interop 兜底。
		 */
		return { inject, apply, OptimizeButton, optimizePrompt, default: __defaultExport };
	}
});
`

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), out, 'utf-8')
console.log('built lib/client.js  (' + out.length + ' bytes)')
