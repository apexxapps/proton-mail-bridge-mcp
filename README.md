# proton-mail-bridge-mcp

Give your AI coding agent access to your **ProtonMail** — search, read, draft, and send — from
Claude Code, Claude Desktop, Cursor, or any [MCP](https://modelcontextprotocol.io) client.

> _"Check my Proton and tell me anything I need to deal with today."_
> _"Find Sarah's last email and draft a reply saying Thursday at 2pm works — don't send it yet."_

Because Proton is end-to-end encrypted, there's no public mail API — so this talks to **Proton
Bridge**, the official local gateway Proton ships for exactly this. Everything stays on `127.0.0.1`;
your decrypted mail never leaves your machine, and nothing here is a hosted service.

---

## Quick start

The whole path, in order — about 10 minutes from scratch. Steps 1–3 are one-time prerequisites (mostly
Proton's); the tool itself is the last two.

1. **Have a paid Proton plan** (Mail Plus / Unlimited). Free Proton can't do this — it's a Proton limit, not ours.
2. **Install & connect Proton Bridge** — [download it](https://proton.me/mail/bridge), sign in to Proton
   (this opens a browser — that login is Proton's, not this tool), and **wait until Bridge shows "Connected"
   and finishes its first sync.** ([details](#2-proton-bridge))
3. **Install Node.js** if you don't have it — check with `node -v`. ([details](#1-nodejs-18))
4. **Run the setup wizard.** Open Bridge's *Mailbox details* and paste each value when asked (it tests the
   connection and saves):
   ```bash
   npx proton-mail-bridge-mcp setup
   ```
5. **Register it with your AI client** (e.g. Claude Code):
   ```bash
   claude mcp add protonmail --scope user -- npx -y proton-mail-bridge-mcp
   ```
6. **Start a fresh session** in your client (MCP tools load at session start), then try it:
   _"Search my Proton inbox and tell me what needs a reply."_

The rest of this README is detail on each step.

## Before you start

Two prerequisites: **Node.js** (it provides the `npx` command everything below uses) and **Proton Bridge**.

### 1. Node.js 18+

First check whether you already have it — in a terminal:

```bash
node -v      # prints something like v20.x → you're set, skip to Proton Bridge
```

If that says `command not found`, install Node. Pick **one** of these:

**Quickest — no admin password, no website (macOS / Linux):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
  && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts
```

**With Homebrew (macOS)** — if you don't have `brew` yet, install it first (it asks for your Mac
password and may take a few minutes):

```bash
# 1) install Homebrew, then add it to your PATH (these two PATH lines are for Apple-Silicon Macs;
#    the installer also prints the exact lines for your machine at the end):
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"

# 2) install Node:
brew install node
```

**Windows (PowerShell):**

```powershell
winget install OpenJS.NodeJS
```

Then **open a fresh terminal** and confirm it worked: `npx -v` should print a version number.

### 2. Proton Bridge

**[Proton Bridge](https://proton.me/mail/bridge)** is Proton's official app that runs an IMAP/SMTP server
on your machine so mail clients (and this tool) can reach your encrypted mailbox. Set it up first:

1. **Download and install** Bridge, then open it.
2. **Sign in** to your Proton account — this opens a **browser window** (that's Proton's login, nothing to
   do with this tool).
3. **Wait** until Bridge shows **"Connected"** and its **first sync finishes** — it re-reads its mailbox on
   startup and can take a few minutes. Trying to connect before it's synced fails.

Good to know:

- Bridge requires a **paid Proton plan** (Mail Plus / Proton Unlimited). Free Proton accounts can't use
  Bridge, and therefore can't use this. That's a Proton limitation, not ours.
- Bridge runs on macOS, Windows, and Linux (headless via `protonmail-bridge --cli` on servers).
- Bridge gives each account its **own generated IMAP/SMTP username & password** (in its *Mailbox details*
  panel) — you'll paste those into the setup wizard, **not** your normal Proton login.

## Install

**Quickest — run the setup wizard.** It mirrors Bridge's *Mailbox details* panel field-for-field
(paste each value using Bridge's copy buttons), tests reading **and** sending, and writes the config:

```bash
npx proton-mail-bridge-mcp setup
```

Then register it with your MCP client, e.g. Claude Code:

```bash
claude mcp add protonmail --scope user -- npx -y proton-mail-bridge-mcp
```

Finally, **start a fresh session** in your client — MCP tools load when a session starts, so they won't
appear in a session that was already open. Then ask it something like _"search my Proton inbox and tell me
what needs a reply."_

That's it. Prefer to configure by hand instead of the wizard? Read on.

### Manual configuration

Tell it how to reach Bridge — either environment variables or a config file.

**Config file** (`~/.config/proton-mail-bridge-mcp/config.json`):

```json
{
  "user": "you@proton.me",
  "pass": "your-bridge-generated-password",
  "imapPort": 1143,
  "smtpPort": 1025,
  "imapSecurity": "STARTTLS",
  "smtpSecurity": "STARTTLS"
}
```

Copy **all** of these from Bridge → your account → **Mailbox details** (the panel with IMAP and SMTP
columns). Two things people get wrong:

- **Copy the password, don't type it.** Use Bridge's copy button. A single mis-transcribed character
  (an `l` vs `I`, an `O` vs `0`) fails as `"no such user"` — see Troubleshooting.
- **Match the `Security` field for *each* of IMAP and SMTP — they can differ.** Bridge shows a
  Security value under both columns (`STARTTLS` or `SSL`), and on some setups IMAP is STARTTLS while
  SMTP is SSL. Set `imapSecurity`/`smtpSecurity` to exactly what Bridge shows, or **sending can fail
  even though reading works.**

**Or environment variables:** `PROTONMAIL_USER`, `PROTONMAIL_PASS`, `PROTONMAIL_IMAP_PORT`,
`PROTONMAIL_SMTP_PORT`, `PROTONMAIL_IMAP_SECURITY`, `PROTONMAIL_SMTP_SECURITY`. (See
`config.example.json` for every option, including `downloadDir` and `readOnly`.)

Check it works before wiring it into an agent:

```bash
npx proton-mail-bridge-mcp doctor
```

That connects to Bridge, authenticates, and lists your mailboxes — so any setup problem shows up
here with a clear message instead of failing cryptically mid-conversation.

## Other MCP clients

Any MCP client works — point it at the `proton-mail-bridge-mcp` command over stdio. For a JSON-config client
(Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "npx",
      "args": ["-y", "proton-mail-bridge-mcp"],
      "env": { "PROTONMAIL_USER": "you@proton.me", "PROTONMAIL_PASS": "…" }
    }
  }
}
```

## Tools

Deliberately small — eight, and only eight.

| Tool | What it does | |
| --- | --- | --- |
| `search_mail` | Find messages by text / from / to / subject / date (no filter = your recent inbox) | read |
| `get_message` | Read one message in full (quoted history trimmed by default) | read |
| `download_attachment` | Save an inbound attachment to disk (into your download directory) | read |
| `create_draft` | Compose a new email, saved to Drafts — **never sends** | write |
| `send_message` | Send a new email **immediately** | write |
| `reply` | Reply to the sender, threaded and quoting the original | write |
| `reply_all` | Reply to sender + everyone else (never you), threaded | write |
| `forward` | Forward a message to new recipients, carrying its attachments | write |

Any outgoing tool (`create_draft` / `send_message` / `reply` / `reply_all` / `forward`) can:
- send **plain text** (`body`) or a formatted **HTML** email (`html`) — HTML messages get an
  auto-generated plain-text alternative so they render in any client, and replies quote the original
  as an HTML blockquote;
- attach **local files** by path — absolute, or relative to the working directory, so you can email a
  file straight out of the project you're working in (e.g. `attachments: ["./report.pdf"]`).

`reply` / `reply_all` / `forward` send immediately unless you pass `draft: true`, which saves to
Drafts instead.

**Signatures.** Proton's own signature is a composer feature and isn't applied when sending over SMTP,
so set one here to have it appended automatically — at the end of new mail, and above the quoted
original on replies:

```json
{
  "signature": "Simon\nApexx Apps · apexx.app",
  "signatureHtmlPath": "~/.config/proton-mail-bridge-mcp/signature.html"
}
```

`signature` is plain text; `signatureHtml` (inline) or `signatureHtmlPath` (a file) supplies a formatted
HTML signature used on HTML emails. Set either or both — if only one is given, the other is derived.

**`signatureHtmlPath` is live** — the file is re-read on every send, so editing it changes what goes out
on your next email, no restart. Keep your signature in one HTML file and it stays in sync everywhere.

**Emails are sent as HTML by default.** Even when the agent composes plain text, the body is wrapped in
minimal HTML (with a plain-text alternative kept) so it renders in a normal proportional font everywhere
instead of monospace — and any formatted signature always appears. Set `"plainText": true` to send plain
text instead.

**Missing-signature guard.** If you've set a `signatureHtmlPath` and the file can't be read at send time
(moved, renamed, deleted), the tool **refuses to send** rather than quietly firing off an unsigned email —
with a clear message telling you to restore the file or fix the path. Set `"requireSignature": false` to
send-without instead of blocking. (No effect if you haven't configured a signature.)

Set `"readOnly": true` (or `PROTONMAIL_READONLY=1`) to register **only** the three read tools — a
hard guarantee the agent can never compose, send, reply, or forward, whatever the client's approval
settings.

### Safety model

The tools that leave the building — `send_message`, `reply`, `reply_all`, `forward` — are named and
described so your MCP client's per-tool approval is the natural gate; searching, reading, and
downloading never prompt. Prefer drafting: `create_draft` (or `draft: true` on a reply/forward) lets
the agent write while you review in Proton and hit send yourself. For an unattended/headless setup,
run `readOnly` and there's simply nothing that can send. Downloaded attachments are confined to the
configured directory (filenames are basename-sanitised, so a crafted name can't escape it); outgoing
attachments read local files by path, so treat `send`/`reply`/`forward` as the trust boundary they
are.

## On your phone

This is a local server, so it's reachable wherever your agent is. Pair the machine with
**[BrainBoxx](https://brainboxx.app)** and you can do the whole thing from your pocket — _"check my
Proton and tell me what needs dealing with"_ on the train, replies drafted by the time you're home.

## How it works

```
MCP client (Claude Code / Cursor / …)
        │  MCP over stdio
        ▼
   proton-mail-bridge-mcp   ──IMAP──►  127.0.0.1:1143  ┐
        │          ──SMTP──►  127.0.0.1:1025  ├─ Proton Bridge ──► Proton Mail
        └── clean JSON in, tool calls out       ┘   (local, TLS, your machine only)
```

Bridge presents a self-signed cert on localhost (expected); this trusts it by default for
`127.0.0.1`. Set `"allowSelfSigned": false` to enforce full verification if you've given Bridge a
trusted cert.

## Updating

`npx` keeps each package in an **execution cache** (`~/.npm/_npx`) and reuses it — so a new release
isn't necessarily picked up on its own, and a plain `npm cache clean --force` does **not** clear it
(that's a different cache). To force the newest version:

```bash
rm -rf ~/.npm/_npx        # clears npx's execution cache (macOS / Linux)
npx -y proton-mail-bridge-mcp@latest doctor
```

Your MCP client uses the new version the next time it starts the server.

**Prefer reliable updates without the cache dance? Install it globally** — then it's a normal package
you update on demand, and your client runs it directly (no `npx`):

```bash
npm install -g proton-mail-bridge-mcp
# then register it as the bare command:
claude mcp add protonmail --scope user -- proton-mail-bridge-mcp
# update any time:
npm update -g proton-mail-bridge-mcp
```

## Troubleshooting

Run `npx proton-mail-bridge-mcp doctor` first — it names the actual failure. Common ones:

- **`no such user`** — Bridge reports **every** auth failure this way, including a **wrong password**.
  It almost never means the username is genuinely unknown. Re-copy *both* username and password from
  Bridge → Mailbox details (copy buttons, don't type), and double-check for `l`/`I` and `O`/`0` mix-ups.
- **Reading works but sending fails** — your SMTP `Security` is probably `SSL` while you've left
  `smtpSecurity` at `STARTTLS` (or vice-versa). Set `imapSecurity`/`smtpSecurity` to exactly what
  Bridge shows under each column.
- **`too many login attempts`** — Bridge rate-limits repeated logins; it resets after a few minutes of
  quiet. Stop retrying, wait, try once. (Restarting Bridge also resets it.)
- **Nothing connects / `connection refused`** — Bridge isn't running, or is mid-sync. Start it, let the
  first sync finish (the progress bar must reach 100%), then try.
- **Just added the account and it won't authenticate** — let the initial sync complete, and if it
  still refuses, quit Bridge fully and reopen it once.

## Licence

MIT © 2026 Apexx Apps. Not affiliated with or endorsed by Proton AG.
