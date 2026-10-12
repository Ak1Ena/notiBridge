import { expect, test } from 'bun:test'
import { classify, cosine, jev, keyword, laya } from './classify'
import { createApp } from './server'
import { slackEventToMessage, verifySlack } from './sources'
import { openStore } from './store'

test('keyword classifier', async () => {
  expect((await keyword('Login page crashes with 500 error')).kind).toBe('issue')
  expect((await keyword('can we add dark mode support?')).kind).toBe('feature')
  expect((await keyword('please update the docs by friday')).kind).toBe('task')
  expect((await keyword('thanks, good morning!')).kind).toBe('none')
  expect((await keyword('URGENT prod is down')).priority).toBe('high')
})

test('chain falls through to next classifier when one fails', async () => {
  const d = await classify('the checkout button is broken', ['nope', 'keyword'])
  expect(d).toMatchObject({ kind: 'issue', model: 'keyword' })
})

test('cosine', () => {
  expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
})

test('slack signature', () => {
  const now = 1_700_000_000_000
  const ts = String(now / 1000)
  const body = '{"a":1}'
  const sig = 'v0=' + new Bun.CryptoHasher('sha256', 's3cret').update(`v0:${ts}:${body}`).digest('hex')
  expect(verifySlack('s3cret', ts, sig, body, now)).toBe(true)
  expect(verifySlack('wrong', ts, sig, body, now)).toBe(false)
  expect(verifySlack('s3cret', ts, sig, body, now + 600_000)).toBe(false) // replay
  expect(slackEventToMessage({ event: { type: 'message', bot_id: 'B1', text: 'x' } })).toBeNull()
})

test('ingest, dedupe, priority claim, update via HTTP', async () => {
  process.env.CLASSIFIERS = 'keyword'
  const store = openStore(':memory:')
  const app = createApp(store, { INGEST_TOKEN: 't' })
  const post = (path: string, body: unknown, auth = 'Bearer t') =>
    app(new Request(`http://x${path}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }))

  expect((await post('/ingest', { text: 'bug: x' }, 'Bearer bad')).status).toBe(401)
  expect((await post('/ingest', { text: 'please write release notes' })).status).toBe(201)
  expect((await post('/ingest', { text: 'URGENT: payments are broken' })).status).toBe(201)
  expect((await (await post('/ingest', { text: 'please write release notes' })).json()).card).toBeNull() // dup
  expect((await (await post('/ingest', { text: 'lol nice' })).json()).card).toBeNull() // noise

  const first = await (await post('/api/claim', { agent: 'claude' })).json()
  expect(first).toMatchObject({ kind: 'issue', priority: 'high', status: 'doing', agent: 'claude' })
  const second = await (await post('/api/claim', { agent: 'claude' })).json()
  expect(second.kind).toBe('task')
  expect((await post('/api/claim', { agent: 'claude' })).status).toBe(204)

  const done = await app(new Request(`http://x/api/cards/${first.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', note: 'fixed' }) }))
  expect(await done.json()).toMatchObject({ status: 'done', note: 'fixed' })
  expect((await app(new Request(`http://x/api/cards/${first.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'bogus' }) }))).status).toBe(400)
})

test('jev and laya speak /v1/systemone; low confidence falls through', async () => {
  const seen: { auth: string | null; body: any }[] = []
  let confidence = 0.9
  const fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      seen.push({ auth: req.headers.get('authorization'), body })
      return Response.json({
        model: 'fake-1',
        answers: {
          kind: { type: 'choice', choice: 'issue', confidence, probabilities: { issue: 0.9, task: 0.05, feature: 0.05, none: 0 } },
          priority: { type: 'score', score: 2, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 1 } },
        },
      })
    },
  })
  const url = `http://127.0.0.1:${fake.port}/v1/systemone`
  Object.assign(process.env, { LAYA_URL: url, JEV_URL: url, TYPESAFE_API_KEY: 'k' })
  try {
    expect(await laya('checkout is down')).toMatchObject({ kind: 'issue', priority: 'high', model: 'laya:fake-1 (0.90)' })
    expect(seen[0]!.auth).toBeNull()
    expect(Object.keys(seen[0]!.body.questions.kind.criteria)).toEqual(['issue', 'task', 'feature', 'none'])

    expect((await jev('checkout is down')).model).toStartWith('jev:')
    expect(seen[1]!).toMatchObject({ auth: 'Bearer k', body: { model: 'jev-latest' } })

    confidence = 0.1
    expect((await classify('checkout is broken', ['laya', 'keyword'])).model).toBe('keyword')

    delete process.env.TYPESAFE_API_KEY
    await expect(jev('x')).rejects.toThrow('TYPESAFE_API_KEY')
  } finally {
    fake.stop()
    delete process.env.LAYA_URL
    delete process.env.JEV_URL
  }
})
