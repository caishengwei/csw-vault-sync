import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
	canonicalVault,
	localStatus,
	runQuark,
	RuntimeOptions,
} from './runtime'
import { safeError, SyncError } from './types'

function response(value: unknown, isError = false) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(value) }],
		isError,
	}
}

export function createMcp(vault: string, options: RuntimeOptions = {}) {
	const server = new McpServer({ name: 'vault-sync', version: '1.3.1' })
	let job:
		| {
				id: string
				controller: AbortController
				running: boolean
				progress?: { completed: number; total: number }
				result?: unknown
				error?: string
		  }
		| undefined
	let task: Promise<void> | undefined
	const currentJob = () =>
		job
			? {
					id: job.id,
					running: job.running,
					progress: job.progress,
					result: job.result,
					error: job.error,
				}
			: null
	const invoke = async (operation: () => Promise<unknown>) => {
		try {
			return response(await operation())
		} catch (error) {
			return response(
				{
					error: safeError(error),
					code: error instanceof SyncError ? error.code : 'FAILED',
				},
				true,
			)
		}
	}
	server.registerTool(
		'sync_preview',
		{
			description:
				'预览绑定知识库与夸克的同步动作，不修改笔记或远端文件；输出最多 200 条。',
			inputSchema: { allowDeletes: z.boolean().optional() },
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: true,
			},
		},
		({ allowDeletes }) =>
			invoke(() => runQuark(vault, 'preview', { ...options, allowDeletes })),
	)
	server.registerTool(
		'sync_run',
		{
			description:
				'执行绑定知识库与夸克的双向同步。返回任务 ID，请用 sync_status 查询；冲突保留双方。',
			inputSchema: { allowDeletes: z.boolean().optional() },
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			},
		},
		({ allowDeletes }) => {
			if (job?.running)
				return response({ error: '该 MCP 已有同步任务', jobId: job.id }, true)
			job = {
				id: randomUUID(),
				controller: new AbortController(),
				running: true,
			}
			const active = job
			task = runQuark(vault, 'sync', {
				...options,
				signal: active.controller.signal,
				allowDeletes,
				onProgress: (completed, total) => {
					active.progress = { completed, total }
					options.onProgress?.(completed, total)
				},
			})
				.then((result) => {
					active.result = result
				})
				.catch((error) => {
					active.error = safeError(error)
				})
				.finally(() => {
					active.running = false
				})
			return response({ jobId: active.id, running: true })
		},
	)
	server.registerTool(
		'sync_status',
		{
			description:
				'查询当前 MCP 任务和知识库的本地同步状态，不访问网盘，不返回 Cookie 或笔记内容。',
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			invoke(async () => ({
				job: currentJob(),
				...(await localStatus(vault)),
			})),
	)
	server.registerTool(
		'sync_cancel',
		{
			description:
				'取消当前 MCP 创建的同步任务；已完成的文件操作及同步历史保留。',
			inputSchema: { jobId: z.string() },
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ jobId }) => {
			if (!job || job.id !== jobId)
				return response({ error: '任务 ID 不匹配' }, true)
			job.controller.abort()
			return response({ jobId, cancellationRequested: true })
		},
	)
	return {
		server,
		stop: async () => {
			job?.controller.abort()
			await task
			await server.close()
		},
	}
}

export async function startMcp(vaultPath: string) {
	const { server, stop } = createMcp(await canonicalVault(vaultPath))
	await server.connect(new StdioServerTransport())
	let closing = false
	const shutdown = () => {
		if (closing) return
		closing = true
		void stop().finally(() => {
			process.exitCode = 0
		})
	}
	process.once('SIGINT', shutdown)
	process.once('SIGTERM', shutdown)
	server.server.onclose = shutdown
}
