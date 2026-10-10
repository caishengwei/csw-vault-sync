import postcss from '@deanc/esbuild-plugin-postcss'
import UnoCSS from '@unocss/postcss'
import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs, { readFileSync } from 'fs'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async () => {
			const cssSource = prod ? './dist/main.css' : './main.css'
			const cssDest = prod ? './dist/styles.css' : './styles.css'
			fs.renameSync(cssSource, cssDest)
		})
	},
}

/**
 * esbuild plugin to patch localforage's internal setImmediate polyfill
 * which uses document.createElement('script') as a fallback, triggering
 * Obsidian community plugin review warnings.
 *
 * The script-based fallback is dead code in modern browsers (MutationObserver
 * is always available), but the review bot scans for the literal string
 * pattern in the output. We replace it with the setTimeout fallback.
 */
const patchLocalforage = {
	name: 'patch-localforage',
	setup(build) {
		build.onLoad({ filter: /localforage[/\\]dist[/\\]localforage\.js$/ }, (args) => {
			let contents = fs.readFileSync(args.path, 'utf-8')

			// Replace the script-element-based setImmediate fallback with a
			// safe setTimeout fallback. This collapses the two else branches
			// into one, removing both document.createElement('script') calls.
			contents = contents.replace(
				/\} else if \('document' in global && 'onreadystatechange' in global\.document\.createElement\('script'\)\) \{[\s\S]*?\} else \{/,
				'} else {',
			)

			return { contents, loader: 'js' }
		})
	},
}

const context = await esbuild.context({
	entryPoints: ['src/index.ts'],
	bundle: true,
	external: [
		'node:*',
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
	],
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || ''),
		'process.env.PLUGIN_VERSION': JSON.stringify(pkgJson.version),
	},
	format: 'cjs',
	target: 'es2018',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: prod ? 'dist/main.js' : 'main.js',
	minify: prod,
	platform: 'browser',
	plugins: [
		patchLocalforage,
		postcss({
			plugins: [UnoCSS(), postcssMergeRules()],
		}),
		renamePlugin,
	],
})

if (prod) {
	await context.rebuild()
	await context.dispose()
} else {
	await context.watch()
}
