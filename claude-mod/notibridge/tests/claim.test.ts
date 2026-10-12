import { expect, test } from 'claude-code/testing'

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
