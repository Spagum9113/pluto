# Pluto v1

Pluto is a WhatsApp bucket-list bot for one bound group. v1 stores items, facts, chat context, one-off reminders, scheduled-item reminders, and a Thursday Melbourne nudge.

## Local test

```bash
cp .env.example .env
# add ANTHROPIC_API_KEY
npm install
npm start
```

Scan the QR from Ethan's phone, then type `!setup` in the target WhatsApp group. Stop the local process before deploying to Railway.

## Railway

Create one worker service with one replica and a volume mounted at `/data`.

Set env vars:

```bash
ANTHROPIC_API_KEY=...
DATA_DIR=/data
PAIR_PHONE=614xxxxxxxx
TIMEZONE=Australia/Melbourne
MODEL=claude-haiku-5-5
```

On first deploy, read the pairing code from logs and enter it in WhatsApp > Linked devices > Link with phone number. Then Ethan sends `!setup` in the group again because the Railway DB starts empty.

Do not run local and Railway at the same time on the same WhatsApp account.
