import { classify } from './classify'
import { pollMacNotifications, slackEventToMessage, verifySlack } from './sources'
import { openStore, type Message, type Status, type Store } from './store'

const STATUSES: Status[] = ['todo', 'doing', 'done']

export async function ingest(store: Store, msg: Message) {
  if (!msg.text?.trim() || store.isDuplicate(msg)) return null
  const decision = await classify(msg.text)
  if (decision.kind === 'none') return null
  const card = store.add(msg, decision)
  console.log(`+ #${card.id} [${card.kind}/${card.priority}] ${card.title}  (${msg.source}, ${decision.model})`)
  return card
}

export function createApp(store: Store, env = process.env) {
  const json = (data: unknown, status = 200) => Response.json(data, { status })

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'GET' && path === '/') return new Response(Bun.file(new URL('../public/board.html', import.meta.url)))

    if (req.method === 'POST' && path === '/slack/events') {
      if (!env.SLACK_SIGNING_SECRET) return json({ error: 'SLACK_SIGNING_SECRET not set' }, 503)
      const raw = await req.text()
      if (!verifySlack(env.SLACK_SIGNING_SECRET, req.headers.get('x-slack-request-timestamp'), req.headers.get('x-slack-signature'), raw))
        return json({ error: 'bad signature' }, 401)
      const payload = JSON.parse(raw)
      if (payload.type === 'url_verification') return json({ challenge: payload.challenge })
      // Slack wants 200 within 3s; classify after answering. Retries are deduped by external id.
      const msg = slackEventToMessage(payload)
      if (msg) queueMicrotask(() => ingest(store, msg).catch(err => console.error('slack ingest failed:', err)))
      return new Response('ok')
    }

    if (req.method === 'POST' && path === '/ingest') {
      if (env.INGEST_TOKEN && req.headers.get('authorization') !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: 'unauthorized' }, 401)
      const body = (await req.json().catch(() => null)) as Partial<Message> | null
      if (typeof body?.text !== 'string') return json({ error: 'text (string) required' }, 400)
      const card = await ingest(store, { source: String(body.source ?? 'webhook'), text: body.text, author: body.author, channel: body.channel, url: body.url, externalId: body.externalId })
      return json({ card }, card ? 201 : 200)
    }

    if (req.method === 'GET' && path === '/api/cards') return json(store.list(url.searchParams.get('status') ?? undefined))

    if (req.method === 'POST' && path === '/api/claim') {
      const body = (await req.json().catch(() => ({}))) as { agent?: string; id?: number }
      const card = store.claim(String(body.agent ?? 'agent'), body.id)
      return card ? json(card) : new Response(null, { status: 204 })
    }

    const match = path.match(/^\/api\/cards\/(\d+)$/)
    if (match && req.method === 'GET') {
      const card = store.get(Number(match[1]))
      return card ? json(card) : json({ error: 'not found' }, 404)
    }
    if (match && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { status?: Status; agent?: string; note?: string }
      if (body.status && !STATUSES.includes(body.status)) return json({ error: `status must be one of ${STATUSES}` }, 400)
      const card = store.update(Number(match[1]), body)
      return card ? json(card) : json({ error: 'not found' }, 404)
    }

    return json({ error: 'not found' }, 404)
  }
}

if (import.meta.main) {
  const store = openStore()
  // Localhost by default: board/API have no auth. Expose /slack/events via a tunnel (cloudflared, ngrok).
  const server = Bun.serve({ hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 7788), fetch: createApp(store) })
  console.log(`notiBridge board: http://${server.hostname}:${server.port}`)
  if (process.env.NOTIF_MAC === '1') pollMacNotifications(msg => void ingest(store, msg).catch(err => console.error('mac ingest failed:', err)))
}
