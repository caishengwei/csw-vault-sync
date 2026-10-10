import { describe, expect, it } from 'vitest'
import { parseCli } from './cli'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

describe('CLI entry point', () => {
	it('requires explicit vault and disallows literal secrets in command arguments', () => {
		expect(() => parseCli(['sync'])).toThrow('明确指定')
		expect(() =>
			parseCli([
				'init',
				'--vault',
				'/tmp/vault',
				'--cookie',
				'synthetic-secret',
			]),
		).toThrow('未知参数')
		expect(() =>
			parseCli(['sync', '--vault', '/tmp/vault', '--root-id', '0']),
		).toThrow('仅在 init')
		expect(
			parseCli(['sync', '--vault', '/tmp/vault with spaces', '--allow-delete'])
				.flags['--vault'],
		).toBe('/tmp/vault with spaces')
	})

	it('runs the compiled executable with actionable usage and safe nonzero error output', () => {
		const cli = resolve('dist/vault-sync.cjs')
		const help = spawnSync(process.execPath, [cli, '--help'], {
			encoding: 'utf8',
		})
		expect(help.status).toBe(0)
		expect(help.stdout).toContain('vault-sync mcp')
		const invalid = spawnSync(
			process.execPath,
			[cli, 'sync', '--cookie', 'synthetic-secret'],
			{ encoding: 'utf8' },
		)
		expect(invalid.status).toBe(1)
		expect(JSON.parse(invalid.stderr).code).toBe('USAGE')
		expect(invalid.stderr).not.toContain('synthetic-secret')
	})
})
