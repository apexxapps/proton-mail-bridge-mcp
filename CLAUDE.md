# proton-mail-bridge-mcp

## What this is

A small, free, open-source **MCP server** that gives any MCP client (Claude Code, Claude Desktop,
Cursor, Cline, …) access to a user's **ProtonMail** — search, read, draft, send, organise. It's a
standalone project, **not** part of BrainBoxx, but it's a deliberate *gateway* to it (see Positioning).

Scaffolded 2026-08-17 as a sibling folder to `brainboxx/`. Born out of a BrainBoxx conversation:
"CLI having Gmail is great, can we do Proton?" → the clean answer is a local MCP server, and it
doesn't belong *inside* BrainBoxx (BrainBoxx is a transport/control layer; an MCP server is an agent
*capability* — orthogonal). It composes for free: pair the machine with BrainBoxx and you drive your
Proton from your phone with zero code shared between the two.

## The hard dependency — read this first

There is **no public ProtonMail API** (Proton is end-to-end encrypted by design). The only sanctioned
way in is **Proton Bridge**, which Proton ships to expose a *local* IMAP + SMTP server on
`127.0.0.1`. So:

- This server talks IMAP/SMTP to Bridge on localhost. Decrypted mail never leaves the machine.
- **Bridge needs a PAID Proton plan** (Mail Plus / Unlimited). Free accounts can't run Bridge → can't
  use this. This scopes the audience; state it honestly everywhere (README does).
- Bridge hands out **per-account generated IMAP/SMTP credentials** — NOT the Proton login password.
- Bridge defaults: IMAP `1143`, SMTP `1025`, both **STARTTLS with a self-signed cert**. We trust the
  self-signed cert for localhost by default (`allowSelfSigned`, on) — expected for Bridge, not a smell.
- Bridge runs GUI on Mac/Win, headless via `protonmail-bridge --cli` on servers.

## Architecture

Node, **ESM**, MCP over **stdio** (the client spawns us; stdout is JSON-RPC ONLY — all logging →
stderr). Files in `src/`:

- **`index.js`** — bin entry (`#!/usr/bin/env node`). Builds the `McpServer`, registers tools,
  connects `StdioServerTransport`. Does NOT hard-fail on missing config (so the client can still list
  tools); individual tool calls throw a helpful error if unconfigured.
- **`config.js`** — loads config. Precedence: `PROTONMAIL_*` env → JSON file
  (`$PROTONMAIL_MCP_CONFIG` or `~/.config/proton-mail-bridge-mcp/config.json`) → Bridge defaults.
  `assertConfigured` gives the friendly "you're missing X" error.
- **`mail.js`** — the only place that touches Bridge. **Connect-per-operation** (imapflow client
  built, connected, used, logged out each call) — deliberate: sporadic MCP calls + a parked IMAP
  socket goes stale, so reconnecting against localhost is the robust trade. `withImap` / `withMailbox`
  wrappers. IMAP via **imapflow**, SMTP via **nodemailer**, draft MIME via nodemailer's
  `MailComposer` (imported from `nodemailer/lib/mail-composer/index.js` — it's NOT a named export),
  parsing via **mailparser** `simpleParser`. "Delete" = move to Trash (never hard-expunge).
- **`format.js`** — `cleanMessage` turns parsed MIME into tidy JSON for an LLM; `stripQuoted` trims
  quoted reply history + `-- ` signatures so summaries don't drown in forwarded chains (pass
  `full:true` to keep everything).
- **`tools.js`** — the MCP tool surface. **Deliberately small: exactly 8 tools** (Simon's scope call,
  2026-08-17 — the "plain and simple" niche vs the 30-tool incumbent `proton-mail-mcp`):
  `search_mail` (no filter = recent inbox), `get_message`, `download_attachment`, `create_draft`,
  `send_message`, `reply`, `reply_all`, `forward`. READ (first 3) always registered; WRITE (other 5)
  skipped entirely when `readOnly` (→ 3 tools). `guard()` wraps every handler so a throw becomes a
  clean MCP error, not a dead server. The sharp tools (send/reply/reply_all/forward) are *named +
  described* so the client's per-tool approval is the gate — we don't reinvent approval, we make it
  obvious. `reply`/`reply_all`/`forward` **send immediately unless `draft:true`** (→ Drafts).
  **Outgoing attachments:** any write tool takes `attachments: [localPath]` — absolute or relative to
  cwd, ~-expanded, read off disk via nodemailer (`attachLocal`); forward carries the original's
  attachments as bytes too. The BrainBoxx angle: email a file straight out of the brain you're in.
  **HTML email:** compose/reply/forward accept `body` (plain) OR `html` (formatted); `bodyParts()`
  always adds a plain-text alternative (via `htmlToText`) so it's proper multipart/alternative, and
  replies/forwards quote the original as an HTML blockquote (`quoteHtml`). Reading HTML-only mail:
  `format.js htmlToText` fallback so `get_message` isn't blank on HTML-only messages.
  Deliberately CUT (do NOT re-add without Simon — "plain and simple" is the positioning): mark
  read/unread, move/archive/trash, folders/labels, bulk ops, analytics, threads.
- **`setup.js`** — `npx proton-mail-bridge-mcp setup`: interactive first-run wizard (the onboarding
  differentiator vs the incumbent). Mirrors Bridge's Mailbox details panel field-for-field so users
  paste via Bridge's copy buttons; masked password prompt (TTY only); tests IMAP **and** SMTP
  (`verifySmtp`, timeout-guarded) before saving via `saveConfig` (0600). Wired as an argv branch in
  `index.js` alongside `doctor`. ⚠️ Testing note: piped stdin drops buffered readline lines between
  questions — test with paced input or a pty, not a bare `printf | node`.
- **`doctor.js`** — `npx proton-mail-bridge-mcp doctor`: human-facing preflight. Connects, authenticates,
  lists mailboxes → setup problems surface here with a clear message, not mid-conversation. (Wire the
  `doctor` subcommand as an argv branch in `index.js` if we want `proton-mail-bridge-mcp doctor` rather than
  `npm run doctor` / a separate bin — currently it's `scripts.doctor` + standalone.)

## Positioning (Simon, 2026-08-17)

- **Free + open source**, MIT. Goal: garner interest / goodwill in the MCP + Proton communities.
- **Its own identity** — own repo, own npm name `proton-mail-bridge-mcp`, optional own small website. NOT
  under the BrainBoxx brand. Naming decision: functional/descriptive beats funky for a *utility people
  find by searching the problem* — the whole MCP ecosystem names by function. `-mcp` is the broadest
  possible signal (works with ANY MCP client, not just Claude) — resist "claude"/"cli" in the name.
- **A gateway to BrainBoxx** — the README/site end with "do this from your pocket via BrainBoxx." The
  two never share code; they compose because BrainBoxx sits *above* the agent and MCP plugs in *below*
  it. A soft, honest funnel, not a bundling.
- Possible future: a BrainBoxx-side **MCP catalog** ("manage your fleet's agent capabilities from your
  phone", Proton being one entry). Post-v1 BrainBoxx idea, does NOT gate this project.

### Robustness borrowed from the incumbent (0.1.2, 2026-08-17)

Reviewed `proton-mail-mcp`'s hardening; took what fits "small + safe", skipped the rest:
- **TAKEN — prompt-injection hygiene:** `sanitizeText` (in mail.js) strips zero-width/bidi/control
  chars (invisible payload-smuggling vector) from bodies, subjects, and sender names; every
  `get_message` carries an `_untrusted` note and the server `instructions` tell the agent email
  content is data, never instructions. This is the real risk for an agent reading arbitrary mail.
- **N/A by construction — from-name spoofing:** they guard against an `@` in a user-set display name;
  we never let the agent set `from` (it's always the configured address), so there's no vector.
- **N/A — flag-verification / sent-copy retry:** we cut all flag/move tools, and SMTP accept is our
  send-confirmation (nodemailer returns accepted/rejected), so Proton's IMAP index-lag doesn't affect us.
- **SKIPPED (positioning):** 30 tools, bulk ops, folders/labels, analytics — the bloat we define against.
Verdict: we're a coherent "small, safe, great-onboarding" alternative, NOT a poor copy. Don't add tools.

### Competitive landscape (checked 2026-08-17)

An incumbent exists: **`proton-mail-mcp`** by sethbang (npm, MIT, github.com/sethbang/proton-mail-mcp)
— same stack (imapflow + nodemailer + MCP SDK, Bridge-dependent), but **30 tools** and heavily
hardened (HTML sanitisation, dryRun previews, restrict-outbound-to-self, Proton search-lag handling,
flag-verification, tests, CI-published). It's more mature than us on features.

**Our deliberate differentiation = the OPPOSITE direction: plain and simple.** 5 tools, not 30. The
"approachable ProtonMail MCP" — nicer onboarding (config file + `doctor` preflight, which theirs lacks
— it's env-only). We do NOT chase feature parity; that's the whole point. If tempted to add tools,
that's drift toward being a worse copy of the incumbent — resist. Simon: "I like plain and simple, I
don't want 30 tools."

## Dev loop

- `npm install` then `npm run doctor` (needs Bridge running + configured) to smoke-test the mail layer.
- Run the server directly: `node src/index.js` (it'll sit on stdio waiting for a client — Ctrl-C to
  quit; the stderr "ready" line confirms boot + mode).
- Fastest real test: `claude mcp add protonmail --scope user -- node <abs path>/src/index.js`, then in
  a Claude Code session ask it to search your mail.
- No build step, no TypeScript. Keep it dependency-light.

## State / TODO

- **Scaffold complete, UNTESTED against a live Bridge** (Simon may not have a paid Proton/Bridge yet —
  confirm before claiming it works end-to-end). `npm install` not yet run; deps are best-guess latest.
- Not yet published to npm; not yet a git repo of its own (still just files in the folder).
- Nice-to-haves, deferred: OS-keychain for the password (currently plaintext config/env — the one
  real wart); attachment download/upload; a `bridge --cli` bootstrap helper; the marketing site;
  a `curl | bash` installer on-ramp (optional — `npx` already makes install one line, so lower value
  than it was for BrainBoxx which has a daemon to supervise).
