import type { Register } from 'claude-code'

// shortcut: fixed URL and agent name; make them userConfig options if the server moves or several sessions share one board.
const BOARD = 'http://127.0.0.1:7788'
const AGENT = 'claude-code'
const COMPRESS_OVER = 1500 // chars of card context before it goes through headroom
const TOOL_CLAIM = 'mcp__notibridge__board_claim'
const TOOL_UPDATE = 'mcp__notibridge__board_update'

type Card = {
  id: number
  kind: 'issue' | 'task' | 'feature'
  title: string
  body: string
  priority: 'low' | 'med' | 'high'
  source: string
  author: string | null
  url: string | null
  status: 'todo' | 'doing' | 'done'
  agent: string | null
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>

async function api<T>(fetch: Fetch, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(BOARD + path, body === undefined ? undefined : {
    method: path.startsWith('/api/cards/') ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`board ${path}: ${res.status} ${res.text.slice(0, 200)}`)
  return JSON.parse(res.text) as T
}

const line = (c: Card) => `#${c.id} [${c.kind}/${c.priority}] ${c.title}${c.agent ? ` (${c.agent})` : ''}`

export const register: Register = on => {
  let cards: Card[] = []
  const active = () => cards.find(c => c.status === 'doing' && c.agent === AGENT)

  on('session.start', async ($, e, next) => {
    const fetch: Fetch = (url, init) => $.http.fetch(url, init)
    const refresh = async () => {
      try {
        cards = (await api<Card[]>(fetch, '/api/cards')) ?? []
        const count = (s: Card['status']) => cards.filter(c => c.status === s).length
        const mine = active()
        $.ui.status(`board ${count('todo')} todo · ${count('doing')} doing${mine ? ` · on #${mine.id}` : ''}`)
      } catch {
        $.ui.status('board offline')
      }
    }

    await $.command.register({ name: 'board', description: 'Show the notiBridge kanban board' })
    await $.command.register({ name: 'next-task', description: 'Claim the top card from the notiBridge board and work it' })
    await $.tool.register({
      name: 'board_claim',
      description:
        'Claim a card from the notiBridge kanban board (highest priority todo, or a given id) and move it to in progress. ' +
        'Returns the card; long message context comes back compressed by headroom.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Card id; omit for the top todo card' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_update',
      description: 'Move a notiBridge board card to todo, doing or done, with an optional one-line note of what was done.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, status: { enum: ['todo', 'doing', 'done'] }, note: { type: 'string' } },
        required: ['id', 'status'],
      },
      isDeferred: false,
    })

    void refresh()
    $.clock.every(15_000, () => void refresh())
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    try {
      cards = (await api<Card[]>((u, i) => $.http.fetch(u, i), '/api/cards')) ?? []
    } catch {
      return { text: `notiBridge board offline at ${BOARD}. Start it: bun run start` }
    }
    const col = (s: Card['status'], name: string) => {
      const list = cards.filter(c => c.status === s)
      return `${name} (${list.length})\n${list.slice(0, 15).map(c => `  ${line(c)}`).join('\n') || '  -'}`
    }
    return { text: [col('todo', 'To do'), col('doing', 'In progress'), col('done', 'Done')].join('\n') + `\n\nWeb: ${BOARD}` }
  })

  on('command.run', { command: 'next-task' }, async $ => {
    await $.prompt.submit({
      text: `Call ${TOOL_CLAIM} to take the top card from the notiBridge board, do the work it describes in this repo, then call ${TOOL_UPDATE} with status "done" and a one-line note. If the card is unclear or not for this repo, put it back with status "todo" and a note why.`,
    })
    return { text: 'Claiming next board task.' }
  })

  on('tool.call', { tool: TOOL_CLAIM }, async ($, e) => {
    const input = e as unknown as { id?: number }
    const fetch: Fetch = (u, i) => $.http.fetch(u, i)
    const card = await api<Card>(fetch, '/api/claim', { agent: AGENT, id: input.id })
    if (!card) return { result: { claimed: null, message: 'No todo cards on the board.' } }
    cards = [...cards.filter(c => c.id !== card.id), card]

    // Headroom: keep the agent's context budget for the work, not the raw chat dump.
    let context = card.body
    let headroom = 'not needed'
    if (context.length > COMPRESS_OVER) {
      try {
        const out = await $.mcp.call('headroom', 'headroom_compress', { content: context })
        const text = out.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
        if (!out.isError && text) [context, headroom] = [text, 'compressed; full text via mcp__headroom__headroom_retrieve with the hash above']
      } catch {
        headroom = 'unavailable, raw context'
      }
    }
    $.ui.toast(`Claimed ${line(card)}`)
    return {
      result: {
        claimed: { id: card.id, kind: card.kind, title: card.title, priority: card.priority, source: card.source, author: card.author, url: card.url },
        context,
        headroom,
      },
    }
  }).catch(($, e, next) => ({ deny: `notiBridge board unreachable at ${BOARD}: ${String(next.error?.message ?? next.error?.kind ?? 'error')}. Start it with: bun run start` }))

  on('tool.call', { tool: TOOL_UPDATE }, async ($, e) => {
    const input = e as unknown as { id: number; status: Card['status']; note?: string }
    const card = await api<Card>((u, i) => $.http.fetch(u, i), `/api/cards/${input.id}`, { status: input.status, note: input.note })
    if (card) cards = [...cards.filter(c => c.id !== card.id), card]
    return { result: { updated: card && line(card), status: card?.status } }
  }).catch(($, e, next) => ({ deny: `notiBridge board unreachable at ${BOARD}: ${String(next.error?.message ?? next.error?.kind ?? 'error')}. Start it with: bun run start` }))

  // While this session works a board card, remind the model to keep context headroom.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const mine = active()
    if (!mine) return out
    return {
      ...out,
      sections: [
        ...out.sections,
        {
          id: 'notibridge:task',
          text:
            `You are working notiBridge board card #${mine.id} (${mine.kind}): ${mine.title}. ` +
            'Keep context headroom: pass large tool outputs, logs and files through mcp__headroom__headroom_compress before reasoning over them, ' +
            `and retrieve originals with mcp__headroom__headroom_retrieve only when needed. When finished call ${TOOL_UPDATE} with status "done".`,
          scope: 'session' as const,
        },
      ],
    }
  })
}
