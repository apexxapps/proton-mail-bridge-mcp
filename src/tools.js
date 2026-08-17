// The MCP tool surface — deliberately small. Eight tools, no more:
//
//   search_mail          find messages (no filter = your recent inbox)
//   get_message          read one in full
//   download_attachment  save an inbound attachment to disk
//   create_draft         compose a NEW email (saved to Drafts, never sent)
//   send_message         send a NEW email immediately
//   reply                reply to the sender, threaded
//   reply_all            reply to sender + everyone, threaded
//   forward              forward a message (carries its attachments)
//
// search / read / download are safe to run freely. Everything that leaves the building
// (send/reply/reply_all/forward) is named + described so the MCP client's per-tool approval is the
// gate — reply/forward send immediately unless draft=true. Any outgoing tool can attach LOCAL FILES
// by path (absolute or relative to the working dir), so you can email a file straight out of the
// project you're working in. Set readOnly to strip every write tool (→ 3 read tools).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  MAILBOX,
  searchSummaries,
  getMessage,
  fetchAttachment,
  appendDraft,
  composeMime,
  sendMail,
} from './mail.js';
import { cleanMessage } from './format.js';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }] };
}

// Wrap a handler so a thrown error becomes a clean MCP error result, not a crashed server.
function guard(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerTools(server, cfg) {
  // --- SEARCH -------------------------------------------------------------------------------------

  server.tool(
    'search_mail',
    'Search email by any combination of free-text, sender, recipient, subject, and date range. ' +
      'With NO filters it returns your most recent inbox messages. Returns summaries (no body) newest ' +
      'first — use get_message with a result\'s uid to read the full text.',
    {
      query: z.string().optional().describe('Free text to match in the message body.'),
      from: z.string().optional().describe('Match the sender (name or address substring).'),
      to: z.string().optional().describe('Match a recipient.'),
      subject: z.string().optional().describe('Match the subject.'),
      since: z.string().optional().describe('Only messages on/after this date (ISO 8601, e.g. 2026-08-01).'),
      before: z.string().optional().describe('Only messages before this date (ISO 8601).'),
      unread: z.boolean().optional().describe('Restrict to unread messages.'),
      mailbox: z.string().optional().describe('Mailbox to search (default "INBOX").'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
    },
    guard(async ({ mailbox = MAILBOX.inbox, limit = 20, unread, ...rest }) => ({
      mailbox,
      messages: await searchSummaries(cfg, { mailbox, limit, unseen: unread, ...rest }),
    }))
  );

  // --- READ ---------------------------------------------------------------------------------------

  server.tool(
    'get_message',
    'Read one full message by uid (from a search result). Quoted reply history and signatures are ' +
      'trimmed by default for readability; pass full=true to keep everything. The result lists any ' +
      'attachments (name/type/size) — use download_attachment to save one.',
    {
      uid: z.number().int().describe('The message uid from a search result.'),
      mailbox: z.string().optional().describe('The mailbox the uid belongs to (default "INBOX").'),
      full: z.boolean().optional().describe('Keep the entire body including quoted history (default false).'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox, full = false }) =>
      cleanMessage(await getMessage(cfg, { uid, mailbox }), { full })
    )
  );

  // --- DOWNLOAD ATTACHMENT ------------------------------------------------------------------------

  server.tool(
    'download_attachment',
    'Save an attachment from a message to disk (into the configured download directory). Identify it ' +
      'by filename or 0-based index (from get_message); if the message has just one attachment, neither ' +
      'is needed. Returns the saved file path.',
    {
      uid: z.number().int().describe('The message uid.'),
      mailbox: z.string().optional().describe('The mailbox the uid belongs to (default "INBOX").'),
      filename: z.string().optional().describe('The attachment filename to save.'),
      index: z.number().int().min(0).optional().describe('0-based attachment index (alternative to filename).'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox, filename, index }) => {
      const att = await fetchAttachment(cfg, { uid, mailbox, filename, index });
      // Confine the write to downloadDir — basename strips any path in the (attacker-controllable)
      // attachment filename, so it can't traverse out.
      const safeName = path.basename(att.filename) || `attachment-${uid}`;
      const dest = path.join(cfg.downloadDir, safeName);
      fs.mkdirSync(cfg.downloadDir, { recursive: true });
      fs.writeFileSync(dest, att.content);
      return { saved: dest, name: safeName, contentType: att.contentType, size: att.size };
    })
  );

  if (cfg.readOnly) return; // read-only deployment: no compose/send/reply/forward tools exist

  // --- COMPOSE / SEND (new mail) ------------------------------------------------------------------

  server.tool(
    'create_draft',
    'Compose a new email and save it to Drafts. Does NOT send — you review and send it yourself in ' +
      'Proton. Can include local file attachments.',
    composeShape(),
    guard(async (a) => {
      await appendDraft(cfg, await composeMime(cfg, toMessage(a)));
      return { ok: true, saved: 'Drafts' };
    })
  );

  server.tool(
    'send_message',
    'Send a new email immediately. This goes out the moment it runs — the client should confirm first. ' +
      'To let a human review before sending, use create_draft instead. Can include local file attachments.',
    composeShape(),
    guard(async (a) => ({ ok: true, sent: await sendMail(cfg, toMessage(a)) }))
  );

  // --- REPLY / FORWARD (to an existing message) ---------------------------------------------------

  server.tool(
    'reply',
    'Reply to a message (to its sender), correctly threaded, quoting the original. Sends immediately ' +
      'unless draft=true (saves to Drafts for you to review). Can include local file attachments.',
    replyShape(),
    guard(async ({ uid, mailbox = MAILBOX.inbox, body, draft = false, attachments }) => {
      const message = await buildReply(cfg, { uid, mailbox, body, all: false });
      attachLocal(message, attachments);
      return deliver(cfg, message, draft);
    })
  );

  server.tool(
    'reply_all',
    'Reply to a message and everyone on it (sender + all other recipients, excluding you), threaded ' +
      'and quoting the original. Sends immediately unless draft=true. Can include local file attachments.',
    replyShape(),
    guard(async ({ uid, mailbox = MAILBOX.inbox, body, draft = false, attachments }) => {
      const message = await buildReply(cfg, { uid, mailbox, body, all: true });
      attachLocal(message, attachments);
      return deliver(cfg, message, draft);
    })
  );

  server.tool(
    'forward',
    'Forward a message to new recipients, carrying its original attachments. Optional intro note via ' +
      'body. Sends immediately unless draft=true. Can add further local file attachments.',
    {
      uid: z.number().int().describe('The message to forward.'),
      to: z.union([z.string(), z.array(z.string())]).describe('Recipient address(es) to forward to.'),
      mailbox: z.string().optional().describe('The mailbox the uid belongs to (default "INBOX").'),
      body: z.string().optional().describe('An optional note to add above the forwarded message.'),
      draft: z.boolean().optional().describe('Save to Drafts instead of sending (default false).'),
      attachments: attachmentsField(),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox, to, body, draft = false, attachments }) => {
      const message = await buildForward(cfg, { uid, mailbox, to, body });
      attachLocal(message, attachments); // merges with the carried-over originals
      return deliver(cfg, message, draft);
    })
  );
}

// --- shapes -------------------------------------------------------------------------------------

function attachmentsField() {
  return z
    .array(z.string())
    .optional()
    .describe(
      'Local file paths to attach — absolute, or relative to the working directory (e.g. "./report.pdf" ' +
        'from the project you\'re in). A leading ~ is expanded.'
    );
}

// Compose shape for new mail (create_draft / send_message).
function composeShape() {
  return {
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient address(es).'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('Plain-text body.'),
    cc: z.union([z.string(), z.array(z.string())]).optional(),
    bcc: z.union([z.string(), z.array(z.string())]).optional(),
    attachments: attachmentsField(),
  };
}

// Shape for reply / reply_all.
function replyShape() {
  return {
    uid: z.number().int().describe('The message being replied to.'),
    mailbox: z.string().optional().describe('The mailbox the uid belongs to (default "INBOX").'),
    body: z.string().describe('Your reply text (the original is quoted beneath it).'),
    draft: z.boolean().optional().describe('Save to Drafts instead of sending (default false).'),
    attachments: attachmentsField(),
  };
}

// --- message construction -----------------------------------------------------------------------

// Map new-mail args to a nodemailer/MailComposer message.
function toMessage(a) {
  const msg = { to: a.to, subject: a.subject, text: a.body };
  if (a.cc) msg.cc = a.cc;
  if (a.bcc) msg.bcc = a.bcc;
  attachLocal(msg, a.attachments);
  return msg;
}

// Resolve local file paths and attach them (merging with any already on the message, e.g. a forward's
// carried-over originals). Paths are ~-expanded and resolved against the working directory.
function attachLocal(message, paths) {
  if (!paths || !paths.length) return;
  const resolved = paths.map((p) => {
    const full = path.resolve(expandHome(p));
    if (!fs.existsSync(full)) throw new Error(`Attachment not found: ${p} (looked at ${full})`);
    return { path: full }; // nodemailer/MailComposer read it; filename defaults to the basename
  });
  message.attachments = [...(message.attachments || []), ...resolved];
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Build a threaded reply (all=true → reply-all, CC'ing the other recipients, never yourself).
async function buildReply(cfg, { uid, mailbox, body, all }) {
  const { parsed } = await getMessage(cfg, { uid, mailbox });
  const replyTo =
    parsed.replyTo?.value?.[0]?.address || parsed.from?.value?.[0]?.address;
  if (!replyTo) throw new Error('Could not determine a reply address on the original message.');

  const subject = /^re:/i.test(parsed.subject || '') ? parsed.subject : `Re: ${parsed.subject || ''}`.trim();
  const message = {
    to: replyTo,
    subject,
    text: `${body}${quoteOriginal(parsed)}`,
    inReplyTo: parsed.messageId || undefined,
    references: [parsed.references, parsed.messageId].flat().filter(Boolean).join(' ') || undefined,
  };

  if (all) {
    const me = new Set([cfg.fromAddress, cfg.user].filter(Boolean).map((s) => s.toLowerCase()));
    me.add(replyTo.toLowerCase());
    const cc = [...(parsed.to?.value || []), ...(parsed.cc?.value || [])]
      .map((v) => v.address)
      .filter((a) => a && !me.has(a.toLowerCase()));
    const unique = [...new Set(cc)];
    if (unique.length) message.cc = unique;
  }
  return message;
}

// Build a forward, carrying the original's attachments as real bytes.
async function buildForward(cfg, { uid, mailbox, to, body }) {
  const { parsed } = await getMessage(cfg, { uid, mailbox });
  const subject = /^fwd?:/i.test(parsed.subject || '') ? parsed.subject : `Fwd: ${parsed.subject || ''}`.trim();
  const header = [
    '---------- Forwarded message ----------',
    `From: ${parsed.from?.text || ''}`,
    `Date: ${parsed.date ? parsed.date.toUTCString() : ''}`,
    `Subject: ${parsed.subject || ''}`,
    `To: ${parsed.to?.text || ''}`,
  ].join('\n');
  const message = {
    to,
    subject,
    text: `${body ? body + '\n\n' : ''}${header}\n\n${parsed.text || ''}`,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      content: a.content,
      contentType: a.contentType,
    })),
  };
  return message;
}

// A conventional quoted-original block appended beneath a reply.
function quoteOriginal(parsed) {
  const who = parsed.from?.value?.[0];
  const when = parsed.date ? parsed.date.toUTCString() : '';
  const attribution = `On ${when}, ${who?.name || who?.address || 'the sender'} wrote:`;
  const quoted = (parsed.text || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\n${attribution}\n${quoted}`;
}

// Send now, or save to Drafts if draft=true.
async function deliver(cfg, message, draft) {
  if (draft) {
    await appendDraft(cfg, await composeMime(cfg, message));
    return { ok: true, saved: 'Drafts' };
  }
  return { ok: true, sent: await sendMail(cfg, message) };
}
