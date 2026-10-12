import { expect, mock, test } from 'claude-code/testing'

const card = (body: string) => ({ id: 7, kind: 'issue', title: 'Checkout broken', body, priority: 'high', source: 'slack', author: null, url: null, status: 'doing', agent: 'claude-code' })
const ok = (data: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } })

test('claim sends long card context through headroom', async ($, on) => {
  const compressed: string[] = []
  on('http.fetch', async (_$, e) => (e.url.endsWith('/api/claim') ? ok(card('log line\n'.repeat(400))) : ok([])))
  on('mcp.call', async (_$, e) => {
    compressed.push(`${e.server}/${e.tool}`)
    return { value: { content: [{ type: 'text' as const, text: 'COMPRESSED hash=abc' }], isError: false } }
  })
  const ran: any = await $.tool.call({ tool: 'mcp__notibridge__board_claim' } as any)
  expect(compressed).toEqual(['headroom/headroom_compress'])
  expect(ran.result.context).toBe('COMPRESSED hash=abc')
  expect(ran.result.claimed.id).toBe(7)
})

test('short context skips headroom; offline board denies', async ($, on) => {
  let calls = 0
  let online = true
  on('http.fetch', async (_$, e) => {
    if (!online) return { deny: 'ECONNREFUSED' }
    return e.url.endsWith('/api/claim') ? ok(card('short')) : ok([])
  })
  on('mcp.call', async () => { calls++; return { value: { content: [], isError: false } } })
  const ran: any = await $.tool.call({ tool: 'mcp__notibridge__board_claim' } as any)
  expect(ran.result.context).toBe('short')
  expect(calls).toBe(0)
  online = false
  const denied: any = await $.tool.call({ tool: 'mcp__notibridge__board_claim' } as any).catch((err: Error) => ({ deny: err.message }))
  expect(String(denied.deny ?? denied.text)).toContain('unreachable')
})

test('starts the board server with bun when the board is offline', async ($, on) => {
  const spawned: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('http.fetch', async () => ({ deny: 'ECONNREFUSED' }))
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test' })
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, env: e.env })
    yield { stream: 'stdout' as const, text: 'notiBridge board: http://127.0.0.1:7788\n' }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__notibridge__${e.name}` } }))
  on('session.start', async (_$, e) => e)
  await ($ as any).session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.settle()
  expect(spawned).toHaveLength(1)
  expect(spawned[0]!.argv[0]).toBe('bun')
  expect(spawned[0]!.argv[1]).toEndWith('/src/server.ts')
  expect(spawned[0]!.env).toMatchObject({ DB_PATH: '/Users/test/.notibridge/notibridge.db', LAYA_URL: 'http://127.0.0.1:8010/v1/systemone', NOTIF_MAC: '1' })
})
