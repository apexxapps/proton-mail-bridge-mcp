# protonmail-mcp

Give your AI coding agent access to your **ProtonMail** — search, read, draft, and send — from
Claude Code, Claude Desktop, Cursor, or any [MCP](https://modelcontextprotocol.io) client.

> _"Check my Proton and tell me anything I need to deal with today."_
> _"Find Sarah's last email and draft a reply saying Thursday at 2pm works — don't send it yet."_

Because Proton is end-to-end encrypted, there's no public mail API — so this talks to **Proton
Bridge**, the official local gateway Proton ships for exactly this. Everything stays on `127.0.0.1`;
your decrypted mail never leaves your machine, and nothing here is a hosted service.

---

## Before you start — the one requirement

You need **[Proton Bridge](https://proton.me/mail/bridge)** running on the same machine.

- Bridge requires a **paid Proton plan** (Mail Plus / Proton Unlimited). Free Proton accounts can't
  use Bridge, and therefore can't use this. That's a Proton limitation, not ours.
- Bridge runs on macOS, Windows, and Linux (headless via `protonmail-bridge --cli` on servers).
- Bridge gives each account its **own generated IMAP/SMTP username & password** — you'll use those
  here, **not** your normal Proton login.

## Install

```bash
# Claude Code — one line, no global install:
claude mcp add protonmail --scope user -- npx -y protonmail-mcp
```

Then tell it how to reach Bridge — either environment variables or a config file.

**Config file** (`~/.config/protonmail-mcp/config.json`):

```json
{
  "user": "you@proton.me",
  "pass": "your-bridge-generated-password",
  "imapPort": 1143,
  "smtpPort": 1025
}
```

**Or environment variables:** `PROTONMAIL_USER`, `PROTONMAIL_PASS`, `PROTONMAIL_IMAP_PORT`,
`PROTONMAIL_SMTP_PORT`. (Copy `config.example.json` for the full set of options.)

Check it works before wiring it into an agent:

```bash
npx protonmail-mcp doctor
```

That connects to Bridge, authenticates, and lists your mailboxes — so any setup problem shows up
here with a clear message instead of failing cryptically mid-conversation.

## Other MCP clients

Any MCP client works — point it at the `protonmail-mcp` command over stdio. For a JSON-config client
(Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "npx",
      "args": ["-y", "protonmail-mcp"],
      "env": { "PROTONMAIL_USER": "you@proton.me", "PROTONMAIL_PASS": "…" }
    }
  }
}
```

## Tools

**Read (safe — let the agent run these freely):**

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | List folders/labels |
| `list_recent_mail` | Newest messages in a mailbox (summaries) |
| `get_unread_mail` | Unread messages (summaries) |
| `search_mail` | Search by text / from / to / subject / date range |
| `get_message` | Full message by uid (quoted history trimmed by default) |

**Write (your MCP client should ask before running these):**

| Tool | What it does |
| --- | --- |
| `create_draft` | Save a draft (never sends) |
| `reply_to_message` | Threaded reply — **saves a draft by default**, `send=true` to send |
| `send_message` | Send a new email **immediately** |
| `mark_read` / `mark_unread` | Toggle the read flag |
| `archive_message` / `move_message` | Move between folders |
| `trash_message` | Move to Trash (reversible until emptied) |

Set `"readOnly": true` (or `PROTONMAIL_READONLY=1`) to register **only** the read tools — a hard
guarantee the agent can never send, move, or delete, regardless of client approval settings.

### Safety model

The write tools that matter — `send_message`, `trash_message`, and `reply_to_message` with
`send=true` — are named and described so your MCP client's per-tool approval is the natural gate;
reads never prompt. Prefer **drafting** over sending: the agent writes, you review in Proton, you
hit send. For an unattended/headless setup, run `readOnly` and there's simply nothing dangerous to
approve.

## On your phone

This is a local server, so it's reachable wherever your agent is. Pair the machine with
**[BrainBoxx](https://brainboxx.app)** and you can do the whole thing from your pocket — _"check my
Proton and tell me what needs dealing with"_ on the train, replies drafted by the time you're home.

## How it works

```
MCP client (Claude Code / Cursor / …)
        │  MCP over stdio
        ▼
   protonmail-mcp   ──IMAP──►  127.0.0.1:1143  ┐
        │          ──SMTP──►  127.0.0.1:1025  ├─ Proton Bridge ──► Proton Mail
        └── clean JSON in, tool calls out       ┘   (local, TLS, your machine only)
```

Bridge presents a self-signed cert on localhost (expected); this trusts it by default for
`127.0.0.1`. Set `"allowSelfSigned": false` to enforce full verification if you've given Bridge a
trusted cert.

## Licence

MIT © 2026 Simon Stark. Not affiliated with or endorsed by Proton AG.
