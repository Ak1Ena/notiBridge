import { Database } from 'bun:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import type { Message } from './store'

// --- Slack Events API ---------------------------------------------------------

// https://api.slack.com/authentication/verifying-requests-from-slack
export function verifySlack(secret: string, timestamp: string | null, signature: string | null, rawBody: string, now = Date.now()) {
  if (!timestamp || !signature) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false // replay window
  const hmac = new Bun.CryptoHasher('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  const expected = Buffer.from(`v0=${hmac}`)
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function slackEventToMessage(payload: any): Message | null {
  const ev = payload?.event
  // Only human messages: skip bots (avoid loops), edits, joins, etc.
  if (ev?.type !== 'message' || ev.subtype || ev.bot_id || !ev.text) return null
  return {
    source: 'slack',
    text: ev.text,
    author: ev.user,
    channel: ev.channel,
    externalId: `${ev.channel}:${ev.ts}`,
    url: payload.team_id ? `https://app.slack.com/client/${payload.team_id}/${ev.channel}/p${String(ev.ts).replace('.', '')}` : undefined,
  }
}

// --- macOS Notification Center ------------------------------------------------
// Reads the usernoted DB (needs Full Disk Access for the terminal running bun).
// shortcut: schema is undocumented (app/record tables, bplist `data` with req.titl/req.body); re-check after major macOS upgrades.

const MAC_DB = `${homedir()}/Library/Group Containers/group.com.apple.usernoted/db2/db`
const DEFAULT_APPS = 'com.tinyspeck.slackmacgap,com.microsoft.teams2,com.hnc.Discord,jp.naver.line.mac,com.apple.MobileSMS'

function plistField(data: Uint8Array, keyPath: string) {
  const p = Bun.spawnSync(['plutil', '-extract', keyPath, 'raw', '-o', '-', '-'], { stdin: data })
  return p.exitCode === 0 ? p.stdout.toString().trim() : ''
}

export function pollMacNotifications(onMessage: (m: Message) => void, intervalMs = 5000) {
  const apps = (process.env.NOTIF_APPS ?? DEFAULT_APPS).split(',').map(s => s.trim())
  let db: Database
  try {
    db = new Database(`file:${MAC_DB}?mode=ro`, { readonly: true })
  } catch (err) {
    console.error(`macOS notifications disabled: cannot open ${MAC_DB} (grant Full Disk Access to your terminal).`, (err as Error).message)
    return () => {}
  }
  const query = db.query(`SELECT r.rec_id, r.uuid, r.data, a.identifier FROM record r JOIN app a ON a.app_id = r.app_id
                          WHERE r.rec_id > ? AND a.identifier IN (${apps.map(() => '?').join(',')}) ORDER BY r.rec_id`)
  // Start from now: don't flood the board with history.
  let last = (db.query('SELECT max(rec_id) AS m FROM record').get() as { m: number | null }).m ?? 0

  const timer = setInterval(() => {
    try {
      for (const row of query.all(last, ...apps) as { rec_id: number; uuid: Uint8Array | string; data: Uint8Array; identifier: string }[]) {
        last = row.rec_id
        const title = plistField(row.data, 'req.titl')
        const body = plistField(row.data, 'req.body')
        if (!body) continue
        onMessage({
          source: `mac:${row.identifier}`,
          text: body,
          author: title || undefined,
          externalId: typeof row.uuid === 'string' ? row.uuid : Buffer.from(row.uuid).toString('hex'),
        })
      }
    } catch (err) {
      console.warn('macOS notification poll failed:', (err as Error).message)
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
