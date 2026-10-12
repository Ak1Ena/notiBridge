# notiBridge

Chat messages in, kanban cards out. notiBridge listens to Slack, any webhook, and macOS notifications, asks a decision model whether each message is an **issue**, **task**, **feature** or noise, and puts the real ones on a kanban board. A Claude Code mod lets an agent pull cards off the board and work them, with [headroom](https://github.com/chopratejas/headroom) compressing the card context so the agent keeps its context budget.

```
Slack Events ─┐
POST /ingest ─┼─> decision model ──> SQLite board ──> web board (http://127.0.0.1:7788)
macOS notifs ─┘   llama > embed >                └──> Claude Code mod (/board, /next-task)
                  keyword                               claim -> headroom_compress -> work -> done
```

## Run

```sh
bun run start        # board at http://127.0.0.1:7788
bun test
```

Needs [Bun](https://bun.sh). No dependencies.

## Decision model

Chain set by `CLASSIFIERS` (default `llama,embed,keyword`). First one that answers wins, so the bridge works with no model running.

| name | how | needs |
| --- | --- | --- |
| `llama` | Llama via Ollama, JSON-schema constrained answer (`kind`, `title`, `priority`) | `ollama pull llama3.2` |
| `embed` | JEPA-style: embeds the message and picks the nearest label prototype in embedding space, no generation | `ollama pull nomic-embed-text` |
| `keyword` | regex fallback | nothing |

Env: `OLLAMA_URL` (default `http://127.0.0.1:11434`), `LLAMA_MODEL`, `EMBED_MODEL`. Prototypes live in `src/classify.ts` (`PROTOTYPES`); add examples from your team's chat to tune the embedding classifier.

## Sources

**Generic webhook**: `POST /ingest` with `{ "text": "...", "source": "discord", "author": "...", "channel": "...", "url": "...", "externalId": "..." }`. Set `INGEST_TOKEN` to require `Authorization: Bearer <token>`.

**Slack**: create a Slack app, subscribe to `message.channels` (and `message.groups`/`message.im` if wanted), set the request URL to `https://<tunnel>/slack/events`, and run with `SLACK_SIGNING_SECRET`. Requests are signature-checked; bot messages are ignored. The server binds to localhost, so expose it with a tunnel (`cloudflared tunnel --url http://127.0.0.1:7788`).

**macOS notifications**: `NOTIF_MAC=1 bun run start`. Reads Notification Center's database, so every app's banners count (Slack, Teams, Discord, LINE, Messages by default; set `NOTIF_APPS` to a comma list of bundle ids). Grant your terminal **Full Disk Access** in System Settings > Privacy & Security.

The same message from two sources within 10 minutes becomes one card.

## Board

`http://127.0.0.1:7788`: three columns (To do, In progress, Done), filter by kind, drag cards between columns. API:

- `GET /api/cards[?status=todo]`
- `POST /api/claim` `{ "agent": "name", "id"?: 3 }`: atomically moves the top todo (high priority first) to doing
- `PATCH /api/cards/:id` `{ "status": "done", "note": "..." }`

The board and API have no auth and listen on localhost only; keep `HOST` at `127.0.0.1` unless you put auth in front.

## Claude Code mod

Install (repo is private, so your GitHub account needs access):

```
/plugin install notibridge --marketplace Ak1Ena/notiBridge
```

or for development: `claude --plugin-dir claude-mod/notibridge`.

- Status line: `board 3 todo · 1 doing · on #7`
- `/board`: lists the board
- `/next-task`: the agent claims the top card, does it, marks it done
- Tools `board_claim` / `board_update` the model calls directly
- Headroom: card context over 1500 chars goes through `headroom_compress` (needs the headroom MCP server connected as `headroom`); while a card is in progress the system prompt tells the agent to compress large outputs and retrieve originals only when needed.

Mod tests: `claude plugin test claude-mod/notibridge`.
