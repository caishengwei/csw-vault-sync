import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { configPath, defaultConfig, readCookie, writeConfig } from './config'
import { canonicalVault, localStatus, runQuark } from './runtime'
import { acquireLock } from './state'
import { safeError, SyncError } from './types'

const HELP = `Vault Sync — 夸克同步（Node.js 20+）

vault-sync init --vault <知识库> --root-id <夸克目录ID> --cookie-file <Cookie文件>
vault-sync check --vault <知识库>
vault-sync preview --vault <知识库> [--allow-delete]
vault-sync sync --vault <知识库> [--allow-delete]
vault-sync status --vault <知识库>
vault-sync mcp --vault <知识库>

配置及历史保存在知识库 .vault-sync；与桌面插件共用。
输出为 JSON。sync 遇到冲突、失败、取消或被跳过的删除时返回非零退出码。
Cookie 通过本地文件读取，请勿将 Cookie 放在命令参数中。
`

export function parseCli(args: string[]) {
	const command = args[0] || 'help'
	if (command === 'help' || command === '--help' || args.includes('--help'))
		return { command: 'help', flags: {} as Record<string, string | boolean> }
	if (!['init', 'check', 'preview', 'sync', 'status', 'mcp'].includes(command))
		throw new SyncError('USAGE', '未知命令，请运行 vault-sync --help')
	const flags: Record<string, string | boolean> = {}
	for (let i = 1; i < args.length; i++) {
		const flag = args[i]
		if (flag === '--allow-delete') flags[flag] = true
		else if (
			['--vault', '--root-id', '--cookie-file'].includes(flag) &&
			args[i + 1] &&
			!args[i + 1].startsWith('--')
		)
			flags[flag] = args[++i]
		else
			throw new SyncError(
				'USAGE',
				'未知参数或参数缺少值，请运行 vault-sync --help',
			)
	}
	if (!flags['--vault'])
		throw new SyncError('USAGE', '请明确指定 --vault 知识库目录')
	if (command === 'init' && (!flags['--root-id'] || !flags['--cookie-file']))
		throw new SyncError('USAGE', 'init 需要 --root-id 和 --cookie-file')
	if (command !== 'init' && (flags['--root-id'] || flags['--cookie-file']))
		throw new SyncError('USAGE', '目录 ID 和 Cookie 文件仅在 init 中配置')
	if (!['preview', 'sync'].includes(command) && flags['--allow-delete'])
		throw new SyncError('USAGE', '--allow-delete 仅用于 preview 或 sync')
	return { command, flags }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	const { command, flags } = parseCli(args)
	if (command === 'help') {
		process.stdout.write(HELP)
		return 0
	}
	const vault = await canonicalVault(String(flags['--vault']))
	if (command === 'mcp') {
		const { startMcp } = await import('./mcp')
		await startMcp(vault)
		return 0
	}
	if (command === 'init') {
		const release = await acquireLock(vault)
		try {
			const exists = await fs
				.lstat(configPath(vault))
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') return undefined
					throw error
				})
			if (exists)
				throw new SyncError(
					'CONFIG_EXISTS',
					'配置已存在，请在插件设置或 .vault-sync/config.json 中修改',
				)
			const config = {
				...defaultConfig,
				rootFolderId: String(flags['--root-id']),
				cookieFile: resolve(String(flags['--cookie-file'])),
			}
			await readCookie(vault, config)
			await writeConfig(vault, config)
			process.stdout.write(
				JSON.stringify({ configured: true, configFile: configPath(vault) }) +
					'\n',
			)
		} finally {
			await release()
		}
		return 0
	}
	if (command === 'status') {
		process.stdout.write(
			JSON.stringify(await localStatus(vault), null, 2) + '\n',
		)
		return 0
	}
	const controller = new AbortController()
	const cancel = () => controller.abort()
	process.on('SIGINT', cancel)
	process.on('SIGTERM', cancel)
	try {
		const result = await runQuark(
			vault,
			command as 'check' | 'preview' | 'sync',
			{
				signal: controller.signal,
				allowDeletes: flags['--allow-delete'] ? true : undefined,
			},
		)
		process.stdout.write(JSON.stringify(result, null, 2) + '\n')
		if (
			'failed' in result &&
			(result.failed.length ||
				result.conflicts.length ||
				result.cancelled ||
				result.skipped.length)
		)
			return 2
		return 0
	} finally {
		process.off('SIGINT', cancel)
		process.off('SIGTERM', cancel)
	}
}

if (require.main === module) {
	main()
		.then((code) => {
			process.exitCode = code
		})
		.catch((error) => {
			process.stderr.write(
				JSON.stringify({
					error: safeError(error),
					code: error instanceof SyncError ? error.code : 'FAILED',
				}) + '\n',
			)
			process.exitCode = 1
		})
}
