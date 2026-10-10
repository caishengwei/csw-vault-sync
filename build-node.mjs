import esbuild from 'esbuild'
import { chmod } from 'node:fs/promises'

await esbuild.build({
	entryPoints: ['src/headless/cli.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile: 'dist/vault-sync.cjs',
	banner: { js: '#!/usr/bin/env node' },
	logLevel: 'info',
})
await chmod('dist/vault-sync.cjs', 0o755)
