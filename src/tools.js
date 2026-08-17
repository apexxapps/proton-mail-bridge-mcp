// The MCP tool surface. Two tiers, and the split is deliberate:
//
//   READ tools  (search / read / list)      — always registered, safe to let an agent run freely.
//   WRITE tools (draft / send / move / trash) — registered unless config.readOnly, and the ones that
//     are irreversible-ish (send, trash) are named + described so the MCP client's per-tool approval
//     is the natural gate. We don't try to reinvent approval here; we make the dangerous tools
//     obvious and let the client (Claude Code, etc.) prompt for them.
//
// Every handler returns clean JSON as text content — the model does the reasoning, we just hand it
// tidy data.

import { z } from 'zod';
import {
  MAILBOX,
  listMailboxes,
  searchSummaries,
  getMessage,
  setSeen,
  moveMessage,
  trashMessage,
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
  // --- READ ---------------------------------------------------------------------------------------

  server.tool(
    'list_mailboxes',
    'List the mailboxes/folders in the Proton account (INBOX, Archive, Sent, custom labels, …).',
    {},
    guard(async () => ({ mailboxes: await listMailboxes(cfg) }))
  );

  server.tool(
    'list_recent_mail',
    'List the most recent messages in a mailbox (summaries only — no body). Newest first.',
    {
      mailbox: z.string().optional().describe('Mailbox path, e.g. "INBOX" (default), "Archive", "Sent".'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return (default 20).'),
    },
    guard(async ({ mailbox = MAILBOX.inbox, limit = 20 }) => ({
      mailbox,
      messages: await searchSummaries(cfg, { mailbox, limit }),
    }))
  );

  server.tool(
    'get_unread_mail',
    'List unread messages in a mailbox (summaries only). Newest first.',
    {
      mailbox: z.string().optional().describe('Mailbox path (default "INBOX").'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return (default 20).'),
    },
    guard(async ({ mailbox = MAILBOX.inbox, limit = 20 }) => ({
      mailbox,
      messages: await searchSummaries(cfg, { mailbox, limit, unseen: true }),
    }))
  );

  server.tool(
    'search_mail',
    'Search a mailbox by any combination of free-text, sender, recipient, subject, and date range. ' +
      'Returns summaries (no body) newest first. Use get_message for the full text of a result.',
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

  server.tool(
    'get_message',
    'Fetch one full message by uid (from a search/list result). Quoted reply history and signatures ' +
      'are trimmed by default for readability; pass full=true to keep everything.',
    {
      uid: z.number().int().describe('The message uid from a list/search result.'),
      mailbox: z.string().optional().describe('The mailbox the uid belongs to (default "INBOX").'),
      full: z.boolean().optional().describe('Keep the entire body including quoted history (default false).'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox, full = false }) =>
      cleanMessage(await getMessage(cfg, { uid, mailbox }), { full })
    )
  );

  if (cfg.readOnly) return; // read-only deployment: stop here, no write tools exist

  // --- WRITE (mutating; the client should approve these) ------------------------------------------

  server.tool(
    'mark_read',
    'Mark a message read (adds the \\Seen flag).',
    {
      uid: z.number().int(),
      mailbox: z.string().optional().describe('Default "INBOX".'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox }) => ({ ok: await setSeen(cfg, { uid, mailbox }, true) }))
  );

  server.tool(
    'mark_unread',
    'Mark a message unread (removes the \\Seen flag).',
    {
      uid: z.number().int(),
      mailbox: z.string().optional().describe('Default "INBOX".'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox }) => ({ ok: await setSeen(cfg, { uid, mailbox }, false) }))
  );

  server.tool(
    'archive_message',
    'Move a message to the Archive.',
    {
      uid: z.number().int(),
      mailbox: z.string().optional().describe('Current mailbox (default "INBOX").'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox }) => ({
      ok: await moveMessage(cfg, { uid, mailbox, target: MAILBOX.archive }),
    }))
  );

  server.tool(
    'move_message',
    'Move a message to another mailbox/folder.',
    {
      uid: z.number().int(),
      target: z.string().describe('Destination mailbox path (see list_mailboxes).'),
      mailbox: z.string().optional().describe('Current mailbox (default "INBOX").'),
    },
    guard(async ({ uid, target, mailbox = MAILBOX.inbox }) => ({
      ok: await moveMessage(cfg, { uid, mailbox, target }),
    }))
  );

  server.tool(
    'trash_message',
    'Move a message to Trash. This is reversible until Trash is emptied — but treat it as destructive.',
    {
      uid: z.number().int(),
      mailbox: z.string().optional().describe('Current mailbox (default "INBOX").'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox }) => ({ ok: await trashMessage(cfg, { uid, mailbox }) }))
  );

  server.tool(
    'create_draft',
    'Save a draft message (does NOT send). Appears in your Proton Drafts folder.',
    draftShape(),
    guard(async (a) => {
      const mime = await composeMime(cfg, toMessage(a));
      await appendDraft(cfg, mime);
      return { ok: true, saved: 'Drafts' };
    })
  );

  server.tool(
    'reply_to_message',
    'Reply to a message. By default saves a DRAFT reply (threaded, addressed to the original sender); ' +
      'pass send=true to send it immediately. Prefer drafting so the user can review before it goes out.',
    {
      uid: z.number().int().describe('The message being replied to.'),
      mailbox: z.string().optional().describe('Its mailbox (default "INBOX").'),
      body: z.string().describe('Your reply text.'),
      send: z.boolean().optional().describe('Send now instead of saving a draft (default false).'),
    },
    guard(async ({ uid, mailbox = MAILBOX.inbox, body, send = false }) => {
      const { parsed } = await getMessage(cfg, { uid, mailbox });
      const to = parsed.from?.value?.[0]?.address;
      if (!to) throw new Error('Could not determine a reply address on the original message.');
      const subject = /^re:/i.test(parsed.subject || '') ? parsed.subject : `Re: ${parsed.subject || ''}`.trim();
      const refs = [parsed.references, parsed.messageId].filter(Boolean).join(' ').trim() || undefined;
      const message = toMessage({ to, subject, body, inReplyTo: parsed.messageId, references: refs });
      if (send) return { ok: true, sent: await sendMail(cfg, message) };
      await appendDraft(cfg, await composeMime(cfg, message));
      return { ok: true, saved: 'Drafts' };
    })
  );

  server.tool(
    'send_message',
    'Send a NEW email immediately. This goes out the moment it runs — the client should confirm first.',
    draftShape(),
    guard(async (a) => ({ ok: true, sent: await sendMail(cfg, toMessage(a)) }))
  );
}

// Shared input shape for compose-style tools.
function draftShape() {
  return {
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient address(es).'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('Plain-text body.'),
    cc: z.union([z.string(), z.array(z.string())]).optional(),
    bcc: z.union([z.string(), z.array(z.string())]).optional(),
  };
}

// Map our tool args to a nodemailer/MailComposer message.
function toMessage(a) {
  const msg = { to: a.to, subject: a.subject, text: a.body };
  if (a.cc) msg.cc = a.cc;
  if (a.bcc) msg.bcc = a.bcc;
  const headers = {};
  if (a.inReplyTo) headers['In-Reply-To'] = a.inReplyTo;
  if (a.references) headers['References'] = a.references;
  if (Object.keys(headers).length) msg.headers = headers;
  return msg;
}
