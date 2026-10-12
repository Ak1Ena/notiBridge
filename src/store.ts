import { Database } from 'bun:sqlite'
import type { Decision } from './classify'

export type Status = 'todo' | 'doing' | 'done'
export type Card = {
  id: number
  kind: Decision['kind']
  title: string
  body: string
  priority: Decision['priority']
  model: string
  source: string
  author: string | null
  channel: string | null
  url: string | null
  status: Status
  agent: string | null
  note: string | null
  created_at: number
  updated_at: number
}
export type Message = { source: string; text: string; author?: string; channel?: string; url?: string; externalId?: string }

export function openStore(path = process.env.DB_PATH ?? 'notibridge.db') {
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    priority TEXT NOT NULL, model TEXT NOT NULL,
    source TEXT NOT NULL, external_id TEXT, author TEXT, channel TEXT, url TEXT,
    status TEXT NOT NULL DEFAULT 'todo', agent TEXT, note TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (source, external_id))`)

  const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END`

  return {
    // Same message seen twice (Slack webhook + macOS banner, or a retry) within 10 min is one card.
    isDuplicate(msg: Message) {
      if (msg.externalId && db.query('SELECT 1 FROM cards WHERE source = ? AND external_id = ?').get(msg.source, msg.externalId)) return true
      return !!db.query('SELECT 1 FROM cards WHERE body = ? AND created_at > ?').get(msg.text, Date.now() - 600_000)
    },

    add(msg: Message, d: Decision): Card {
      const now = Date.now()
      return db
        .query(`INSERT INTO cards (kind, title, body, priority, model, source, external_id, author, channel, url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(d.kind, d.title, msg.text, d.priority, d.model, msg.source, msg.externalId ?? null,
          msg.author ?? null, msg.channel ?? null, msg.url ?? null, now, now) as Card
    },

    list(status?: string): Card[] {
      return status
        ? (db.query(`SELECT * FROM cards WHERE status = ? ORDER BY ${PRIORITY_ORDER}, created_at`).all(status) as Card[])
        : (db.query(`SELECT * FROM cards ORDER BY ${PRIORITY_ORDER}, created_at`).all() as Card[])
    },

    get: (id: number) => db.query('SELECT * FROM cards WHERE id = ?').get(id) as Card | null,

    update(id: number, patch: { status?: Status; agent?: string | null; note?: string | null }): Card | null {
      return db
        .query(`UPDATE cards SET status = coalesce(?, status), agent = coalesce(?, agent), note = coalesce(?, note), updated_at = ?
                WHERE id = ? RETURNING *`)
        .get(patch.status ?? null, patch.agent ?? null, patch.note ?? null, Date.now(), id) as Card | null
    },

    // Atomic: two agents never claim the same card.
    claim(agent: string, id?: number): Card | null {
      return db
        .query(`UPDATE cards SET status = 'doing', agent = ?, updated_at = ?
                WHERE id = (SELECT id FROM cards WHERE status = 'todo' AND (? IS NULL OR id = ?) ORDER BY ${PRIORITY_ORDER}, created_at LIMIT 1)
                RETURNING *`)
        .get(agent, Date.now(), id ?? null, id ?? null) as Card | null
    },
  }
}
export type Store = ReturnType<typeof openStore>
