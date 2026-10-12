// Decision model: is a message an issue, task, feature, or noise?
// Pluggable chain (CLASSIFIERS env, default "jev,laya,llama,embed,keyword"): first one that answers wins.

export type Kind = 'issue' | 'task' | 'feature' | 'none'
export type Priority = 'low' | 'med' | 'high'
export type Decision = { kind: Kind; title: string; priority: Priority; model: string }
type Classifier = (text: string) => Promise<Decision>

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const LLAMA_MODEL = process.env.LLAMA_MODEL ?? 'llama3.2'
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text'

const firstLine = (text: string) => text.trim().split('\n')[0].slice(0, 80)

const guessPriority = (text: string): Priority =>
  /\b(urgent|asap|prod(uction)? (is )?down|outage|critical|blocker|p0|sev ?1)\b/i.test(text) ? 'high'
    : /\b(when you can|someday|nice to have|low priority)\b/i.test(text) ? 'low'
    : 'med'

async function ollama(path: string, body: unknown) {
  const res = await fetch(OLLAMA + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ollama ${path} ${res.status}`)
  return res.json() as Promise<any>
}

// System One decision models: TypeSafe Jev (hosted) and Laya (open weights, self-hosted `laya-serve`)
// share the same POST /v1/systemone protocol: a state plus typed questions in, calibrated answers out.
const LEVELS: Priority[] = ['low', 'med', 'high']
const MIN_CONFIDENCE = Number(process.env.SYSTEMONE_MIN_CONFIDENCE ?? 0.4) // below this, let the next classifier decide

const systemOne = (name: string, url: string, apiKey?: string, model?: string): Classifier => async text => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      ...(model && { model }),
      state: { message: text.slice(0, 8000) },
      questions: {
        kind: {
          type: 'choice',
          instructions: 'Classify this chat message for a software team kanban board.',
          criteria: {
            issue: 'something is broken: bug, error, crash, outage',
            task: 'a concrete request someone has to do',
            feature: 'a request for a new capability or an improvement',
            none: 'chit-chat, thanks, FYI, or a question that needs no work',
          },
        },
        priority: {
          type: 'score',
          instructions: 'How urgent is the work this message asks for?',
          criteria: ['can wait', 'should happen this week', 'urgent: blocking, production down, or a deadline today'],
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${name} ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as any
  const { kind, priority } = data.answers
  if (kind.confidence < MIN_CONFIDENCE) throw new Error(`${name} unsure (confidence ${kind.confidence})`)
  return {
    kind: kind.choice,
    title: firstLine(text), // System One models never generate text
    priority: LEVELS[Math.min(2, Math.max(0, Math.round(priority.score)))]!,
    model: `${name}:${data.model ?? model ?? 'auto'} (${kind.confidence.toFixed(2)})`,
  }
}

export const jev: Classifier = text => {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) return Promise.reject(new Error('TYPESAFE_API_KEY not set'))
  return systemOne('jev', process.env.JEV_URL ?? 'https://api.typesafe.ai/v1/systemone', key, process.env.JEV_MODEL ?? 'jev-latest')(text)
}

export const laya: Classifier = text =>
  systemOne('laya', process.env.LAYA_URL ?? 'http://127.0.0.1:8000/v1/systemone', process.env.LAYA_API_KEY, process.env.LAYA_MODEL)(text)

// Llama: generative decision with a JSON schema-constrained answer.
export const llama: Classifier = async text => {
  const data = await ollama('/api/chat', {
    model: LLAMA_MODEL,
    stream: false,
    options: { temperature: 0 },
    format: {
      type: 'object',
      properties: {
        kind: { enum: ['issue', 'task', 'feature', 'none'] },
        title: { type: 'string' },
        priority: { enum: ['low', 'med', 'high'] },
      },
      required: ['kind', 'title', 'priority'],
    },
    messages: [
      {
        role: 'system',
        content:
          'You triage chat messages for a software team kanban board. ' +
          'issue = something is broken/bug/error/outage. task = a concrete request someone must do. ' +
          'feature = a request for new capability or improvement. none = chit-chat, FYI, thanks, questions with no action. ' +
          'title = imperative summary under 80 chars. Answer JSON only.',
      },
      { role: 'user', content: text.slice(0, 4000) },
    ],
  })
  const out = JSON.parse(data.message.content)
  return { kind: out.kind, title: String(out.title).slice(0, 80) || firstLine(text), priority: out.priority, model: `llama:${LLAMA_MODEL}` }
}

// JEPA-style: compare the message embedding with label prototypes in latent space, no generation.
const PROTOTYPES: Record<Exclude<Kind, 'none'> | 'none', string[]> = {
  issue: ['the app crashes on login', 'getting a 500 error in production', 'this is broken since the last deploy', 'bug: button does nothing'],
  task: ['can you update the docs by friday', 'please rotate the API keys', 'someone needs to review my PR', 'need to migrate the database this week'],
  feature: ['it would be great if we could export to CSV', 'feature request: dark mode', 'can we add SSO support', 'users want a search filter'],
  none: ['thanks!', 'good morning team', 'lol nice', 'see you tomorrow', 'ok sounds good'],
}
let prototypeVectors: Promise<[Kind, number[]][]> | undefined

const embed = async (input: string[]): Promise<number[][]> => (await ollama('/api/embed', { model: EMBED_MODEL, input })).embeddings
const mean = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
export const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2 }
  return dot / (Math.sqrt(na * nb) || 1)
}

export const embedding: Classifier = async text => {
  prototypeVectors ??= Promise.all(
    Object.entries(PROTOTYPES).map(async ([kind, examples]) => [kind as Kind, mean(await embed(examples))] as [Kind, number[]]),
  ).catch(err => { prototypeVectors = undefined; throw err })
  const protos = await prototypeVectors // await first: an unawaited rejection would crash the process
  const [vector] = await embed([text.slice(0, 2000)])
  const [best] = protos
    .map(([kind, proto]) => [kind, cosine(vector, proto)] as const)
    .sort((a, b) => b[1] - a[1])
  return { kind: best[0], title: firstLine(text), priority: guessPriority(text), model: `embed:${EMBED_MODEL}` }
}

// Last resort so the bridge works with no model running.
export const keyword: Classifier = async text => {
  const kind: Kind =
    /\b(bug|error|crash|broken|fail(s|ed|ing)?|exception|500|down|not working|doesn'?t work)\b/i.test(text) ? 'issue'
      : /\b(feature|would be (nice|great)|can we add|could we (add|have)|support for|request)\b/i.test(text) ? 'feature'
      : /\b(please|can you|could you|todo|need to|needs to|by (mon|tue|wed|thu|fri|eod|tomorrow))\b/i.test(text) ? 'task'
      : 'none'
  return { kind, title: firstLine(text), priority: guessPriority(text), model: 'keyword' }
}

const REGISTRY: Record<string, Classifier> = { jev, laya, llama, embed: embedding, keyword }

export async function classify(text: string, chain = (process.env.CLASSIFIERS ?? 'jev,laya,llama,embed,keyword').split(',')): Promise<Decision> {
  for (const name of chain) {
    const fn = REGISTRY[name.trim()]
    if (!fn) continue
    try {
      return await fn(text)
    } catch (err) {
      console.warn(`classifier ${name} failed, trying next:`, (err as Error).message)
    }
  }
  return keyword(text)
}
