import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createMcp } from './mcp'
import { defaultConfig, saveCookie, writeConfig } from './config'
import { MockQuark } from './test-support'

function value(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse(
		(result.content as Array<{ type: string; text: string }>)[0].text,
	)
}

describe('MCP wire protocol', () => {
	let vault: string
	let client: Client
	let cleanup: (() => Promise<void>) | undefined
	beforeEach(async () => {
		vault = await fs.mkdtemp(join(tmpdir(), 'vault-sync-mcp-'))
		const config = { ...defaultConfig, rootFolderId: 'root' }
		await writeConfig(vault, config)
		await saveCookie(vault, config, '__uid=test-user; __kps=synthetic-cookie')
		client = new Client({ name: 'test-client', version: '1' })
	})
	afterEach(async () => {
		await cleanup?.()
		await client.close()
		await fs.rm(vault, { recursive: true, force: true })
	})

	it('exposes four tools and executes preview/run/status with the actual SDK client', async () => {
		const quark = new MockQuark()
		await fs.writeFile(join(vault, 'note.md'), 'sync through MCP')
		const host = createMcp(vault, { transport: quark.transport })
		cleanup = host.stop
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([host.server.connect(a), client.connect(b)])
		const tools = await client.listTools()
		expect(tools.tools.map((tool) => tool.name)).toEqual([
			'sync_preview',
			'sync_run',
			'sync_status',
			'sync_cancel',
		])
		const preview = value(
			await client.callTool({ name: 'sync_preview', arguments: {} }),
		)
		expect(preview.actions[0].type).toBe('push')
		expect(quark.files.size).toBe(0)
		const run = value(
			await client.callTool({ name: 'sync_run', arguments: {} }),
		)
		expect(run.running).toBe(true)
		let status: ReturnType<typeof value>
		for (let i = 0; i < 200; i++) {
			status = value(
				await client.callTool({ name: 'sync_status', arguments: {} }),
			)
			if (!status.job.running) break
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		expect(status!.job.id).toBe(run.jobId)
		expect(status!.job.result.failed).toEqual([])
		expect(new TextDecoder().decode(quark.get('note.md')!.bytes)).toBe(
			'sync through MCP',
		)
		expect(JSON.stringify(status)).not.toContain('synthetic-cookie')
	})

	it('rejects overlapping jobs and cancels only the requested job', async () => {
		const quark = new MockQuark()
		let unblock!: () => void
		const gate = new Promise<void>((resolve) => {
			unblock = resolve
		})
		const host = createMcp(vault, {
			transport: async (request) => {
				await gate
				return quark.transport(request)
			},
		})
		cleanup = host.stop
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([host.server.connect(a), client.connect(b)])
		const job = value(
			await client.callTool({ name: 'sync_run', arguments: {} }),
		)
		const overlap = await client.callTool({ name: 'sync_run', arguments: {} })
		expect(overlap.isError).toBe(true)
		const wrong = await client.callTool({
			name: 'sync_cancel',
			arguments: { jobId: 'wrong-job' },
		})
		expect(wrong.isError).toBe(true)
		const cancelled = value(
			await client.callTool({
				name: 'sync_cancel',
				arguments: { jobId: job.jobId },
			}),
		)
		expect(cancelled.cancellationRequested).toBe(true)
		unblock()
		await host.stop()
		cleanup = undefined
		expect(await fs.readdir(join(vault, '.vault-sync'))).not.toContain('lock')
	})

	it('starts the compiled stdio server and completes initialization and tool calls without stdout pollution', async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [resolve('dist/vault-sync.cjs'), 'mcp', '--vault', vault],
			stderr: 'pipe',
		})
		await client.connect(transport)
		const tools = await client.listTools()
		expect(tools.tools).toHaveLength(4)
		const status = value(
			await client.callTool({ name: 'sync_status', arguments: {} }),
		)
		expect(status.configured).toBe(true)
		expect(status.locked).toBe(false)
		expect(status.job).toBeNull()
		await client.close()
	})
})
