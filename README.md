# notiBridge

Chat messages in, kanban cards out. notiBridge listens to Slack, any webhook, and macOS notifications, asks a decision model whether each message is an **issue**, **task**, **feature** or noise, and puts the real ones on a kanban board. A Claude Code mod lets an agent pull cards off the board and work them, with [headroom](https://github.com/chopratejas/headroom) compressing the card context so the agent keeps its context budget.

```
Slack Events ─┐
POST /ingest ─┼─> decision model ──> SQLite board ──> web board (http://127.0.0.1:7788)
macOS notifs ─┘   jev > laya > llama >          └──> Claude Code mod (/board, /next-task)
                  embed > keyword                                    claim -> headroom_compress -> work -> done
```

## Run

```sh
bun run start        # board at http://127.0.0.1:7788
bun test
```

Needs [Bun](https://bun.sh). No dependencies.

## Decision model

The `CLASSIFIERS` setting lists classifiers in order (default `jev,laya,llama,embed,keyword`). The first one that answers wins. One that isn't set up, or that is unsure, passes to the next. With nothing set up, the keyword classifier still sorts messages.

| name | what | setup |
| --- | --- | --- |
| `jev` | [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), hosted System One decision model | `TYPESAFE_API_KEY` from [console.typesafe.ai](https://console.typesafe.ai/keys) |
| `laya` | [Laya](https://huggingface.co/convaiinnovations/laya), open-weight System One model (Apache 2.0), self-hosted | `pip install "laya[serve]"` then `LAYA_HOST=127.0.0.1 laya-serve` |
| `llama` | Llama via Ollama, JSON-schema constrained | `ollama pull llama3.2` |
| `embed` | nearest label prototype in embedding space, via Ollama | `ollama pull nomic-embed-text` |
| `keyword` | regex fallback | nothing |

Jev and Laya use the same `POST /v1/systemone` protocol. notiBridge sends each message as `state` plus two typed questions:
- `kind`: a Choice of issue, task, feature or none
- `priority`: a Score from "can wait" to "urgent"

If the `kind` answer's calibrated confidence is under `SYSTEMONE_MIN_CONFIDENCE` (default `0.4`), the next classifier decides instead. The card's model field shows who decided and how sure it was, e.g. `laya:english (0.91)`.

```sh
TYPESAFE_API_KEY=... bun run start                       # Jev first
CLASSIFIERS=laya,keyword bun run start                   # open-source only, fully local
LAYA_MODEL=multilingual bun run start                    # force Laya checkpoint (default: auto-routes by language, e.g. Thai goes to multilingual)
```

Other settings:
- Jev: `JEV_MODEL` (default `jev-latest`), `JEV_URL`
- Laya: `LAYA_URL` (default `http://127.0.0.1:8000/v1/systemone`), `LAYA_API_KEY` (if `laya-serve` runs with one)
- Ollama: `OLLAMA_URL`, `LLAMA_MODEL`, `EMBED_MODEL`

Run `laya-serve` with `LAYA_HOST=127.0.0.1`: it binds `0.0.0.0` by default.

### Laya in Podman

```sh
git clone --depth 1 https://github.com/NandhaKishorM/laya.git
podman build --build-arg TORCH_INDEX=cpu -t laya:local laya          # ~1.2 GB image
podman run -d --name laya-serve -p 127.0.0.1:8010:8000 \
  -e LAYA_PRELOAD=1 -e LAYA_MODELS=english -e LAYA_DEFAULT_MODEL=english -e LAYA_MAX_LOADED=1 \
  -v laya-model-cache:/home/laya/.cache/huggingface laya:local laya-serve   # first start downloads ~1.6 GB
curl localhost:8010/health

CLASSIFIERS=laya,keyword LAYA_URL=http://127.0.0.1:8010/v1/systemone LAYA_MODEL=english bun run start
```

The English checkpoint uses about 2.3 GB of RAM on CPU and answers in about 0.6 s per message. Publish on `127.0.0.1` only: laya-serve has no auth unless `LAYA_API_KEY` is set.

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
