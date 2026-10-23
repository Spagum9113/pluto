# Pluto

Pluto is a WhatsApp bot for one group. It keeps a bucket list, remembers facts, sets reminders, and nudges the group on Thursday evening when the next week is empty.

Say the bot's name, quote it, or answer a question it just asked. `pluto help` and `pluto yo help` return a fixed list. Other messages stay in the group.

## What it does

- Add, edit, remove, complete, and list bucket-list items. An open item with the same title is not added again.
- Schedule an item. Pluto pings the night before and two hours before.
- Set, list, and cancel one-off reminders. A reminder more than an hour late is skipped.
- Remember, list, and forget facts.
- Undo the last list, fact, or reminder change.
- Send a poll when two or three items could match, instead of changing the list.
- React to the message that triggered it, and pin a quoted message for 7 days.
- On Thursday at 19:00 in `TIMEZONE`, if nothing is scheduled in the next seven days, suggest two open items that have no date.

`personality.md` is the voice. Edit that file to change how Pluto talks. Code adds the prefix and keeps a normal reply to one short message.

## Requirements

- Node.js 22 or newer
- An [Anthropic](https://www.anthropic.com/) API key
- A phone that can link a WhatsApp device

## Run locally

```bash
cp .env.example .env
npm install
npm start
```

Scan the QR with the phone that should own the linked device, then send `!setup` in the group. Stop this process before the same account runs anywhere else.

```bash
npm test
npm run typecheck
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | | Claude API key |
| `MODEL` | | `claude-haiku-5-5` | Model name |
| `TIMEZONE` | | `Australia/Melbourne` | Schedules, reminders, and the Thursday nudge |
| `DATA_DIR` | | `./data` | WhatsApp session and `bucket.db` |
| `BOT_NAMES` | | `pluto` | Comma-separated names that wake the bot |
| `BOT_PREFIX` | | `🐧 ` | Prepended to replies |
| `OWNER_NAME` | | `ethan` | Name used when a message is from the linked phone |
| `PAIR_PHONE` | | | Phone number for a pairing code. Leave unset when a session already exists |
| `WAIT_FOR_SESSION` | | | Set to `1` to wait for `$DATA_DIR/READY` before opening WhatsApp |

`data/` and `.env` stay off git and out of the Docker image. Do not commit a session, a database, or an API key.

## Railway

One worker, one replica, no public domain. Mount a volume at `/data` and deploy with `railway up`.

```bash
ANTHROPIC_API_KEY=...
DATA_DIR=/data
TIMEZONE=Australia/Melbourne
MODEL=claude-haiku-5-5
BOT_NAMES=pluto
BOT_PREFIX=🐧 
OWNER_NAME=your-name
```

Leave `PAIR_PHONE` unset when `/data/auth/creds.json` is already there. A pairing code links a second device.

To move a laptop session onto the volume:

1. Deploy once with `WAIT_FOR_SESSION=1`. The process waits for `/data/READY` and does not open WhatsApp or create `creds.json`.
2. Stop the local process. Checkpoint SQLite, then copy `data/auth` and `data/bucket.db` onto the volume. Leave `bucket.db-wal` and `bucket.db-shm` behind.
3. Create `/data/READY` only after the copy finishes.
4. Remove `WAIT_FOR_SESSION` and restart.

Logs should show `whatsapp connected` and `listening in the bound group`. The group binding is already in the database.

Do not run the laptop and Railway at the same time on the same WhatsApp account.

## License

No license yet. This repository is public so the code can be read. It is not open source until a license is added; until then, don't copy it into another project.
