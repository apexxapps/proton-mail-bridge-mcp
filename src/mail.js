// The mail layer: everything that actually touches Proton Bridge's local IMAP/SMTP.
//
// Design choice: connect-per-operation. An MCP server is long-lived but its tool calls are sporadic
// (a burst when you ask about email, then nothing for an hour), and a parked IMAP socket goes stale.
// Reconnecting each call costs a few ms against localhost and buys robustness — no "socket timed out"
// surprises mid-conversation. If throughput ever matters, pool here; the tool layer won't change.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';

// Well-known Proton mailbox names. Proton localises the display but Bridge exposes these paths.
export const MAILBOX = {
  inbox: 'INBOX',
  archive: 'Archive',
  trash: 'Trash',
  spam: 'Spam',
  sent: 'Sent',
  drafts: 'Drafts',
};

function tlsOpts(cfg) {
  return { rejectUnauthorized: !cfg.allowSelfSigned };
}

// --- IMAP -----------------------------------------------------------------------------------------

function imapClient(cfg) {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.imapPort,
    secure: false, // Bridge uses STARTTLS on 1143; imapflow upgrades automatically
    auth: { user: cfg.user, pass: cfg.pass },
    tls: tlsOpts(cfg),
    logger: false,
    emitLogs: false,
  });
}

// Run `fn(client)` against a freshly-connected IMAP client, always closing it afterwards.
export async function withImap(cfg, fn) {
  const client = imapClient(cfg);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Run `fn(client)` with an exclusive lock held on `mailbox` (imapflow requires this for fetch/search).
export async function withMailbox(cfg, mailbox, fn) {
  return withImap(cfg, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

export async function listMailboxes(cfg) {
  return withImap(cfg, async (client) => {
    const boxes = await client.list();
    return boxes.map((b) => ({
      path: b.path,
      name: b.name,
      specialUse: b.specialUse || null,
      subscribed: b.subscribed !== false,
    }));
  });
}

// Translate a friendly criteria object into an imapflow search query.
function buildSearch(criteria = {}) {
  const q = {};
  if (criteria.query) q.body = criteria.query; // free-text over the body
  if (criteria.from) q.from = criteria.from;
  if (criteria.to) q.to = criteria.to;
  if (criteria.subject) q.subject = criteria.subject;
  if (criteria.since) q.since = new Date(criteria.since);
  if (criteria.before) q.before = new Date(criteria.before);
  if (criteria.unseen) q.seen = false;
  if (Object.keys(q).length === 0) q.all = true;
  return q;
}

// Return message summaries (envelope + flags, no body) newest-first, capped at `limit`.
export async function searchSummaries(cfg, { mailbox = MAILBOX.inbox, limit = 20, ...criteria } = {}) {
  return withMailbox(cfg, mailbox, async (client) => {
    const uids = await client.search(buildSearch(criteria), { uid: true });
    if (!uids || uids.length === 0) return [];
    const pick = uids.slice(-limit).reverse(); // newest last in IMAP order → take tail, newest-first
    const out = [];
    for await (const msg of client.fetch(pick, { uid: true, envelope: true, flags: true, size: true }, { uid: true })) {
      out.push(summariseEnvelope(msg, mailbox));
    }
    // fetch may not preserve our requested order; re-sort newest-first by date
    out.sort((a, b) => new Date(b.date) - new Date(a.date));
    return out;
  });
}

// Fetch and fully parse one message.
export async function getMessage(cfg, { uid, mailbox = MAILBOX.inbox }) {
  return withMailbox(cfg, mailbox, async (client) => {
    let raw = null;
    let flags = new Set();
    for await (const msg of client.fetch([uid], { uid: true, source: true, flags: true }, { uid: true })) {
      raw = msg.source;
      flags = msg.flags || new Set();
    }
    if (!raw) throw new Error(`No message with uid ${uid} in ${mailbox}`);
    const parsed = await simpleParser(raw);
    return { parsed, flags, uid, mailbox };
  });
}

export async function setSeen(cfg, { uid, mailbox = MAILBOX.inbox }, seen) {
  return withMailbox(cfg, mailbox, async (client) => {
    if (seen) await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove([uid], ['\\Seen'], { uid: true });
    return true;
  });
}

export async function moveMessage(cfg, { uid, mailbox = MAILBOX.inbox, target }) {
  return withMailbox(cfg, mailbox, async (client) => {
    await client.messageMove([uid], target, { uid: true });
    return true;
  });
}

// "Delete" for Proton = move to Trash (a real expunge is destructive and rarely what you want from
// an agent). Trash itself has its own retention.
export async function trashMessage(cfg, { uid, mailbox = MAILBOX.inbox }) {
  if (mailbox === MAILBOX.trash) return true; // already there
  return moveMessage(cfg, { uid, mailbox, target: MAILBOX.trash });
}

export async function appendDraft(cfg, rawMime) {
  return withImap(cfg, async (client) => {
    await client.append(MAILBOX.drafts, rawMime, ['\\Draft']);
    return true;
  });
}

// --- SMTP -----------------------------------------------------------------------------------------

function smtpTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.smtpPort,
    secure: false, // Bridge uses STARTTLS on 1025
    requireTLS: true,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: tlsOpts(cfg),
  });
}

// Compose a message into its raw RFC822 bytes (for saving as a draft without sending).
export function composeMime(cfg, message) {
  const composer = new MailComposer({ from: cfg.fromAddress || cfg.user, ...message });
  return new Promise((resolve, reject) => {
    composer.compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

export async function sendMail(cfg, message) {
  const transport = smtpTransport(cfg);
  const info = await transport.sendMail({ from: cfg.fromAddress || cfg.user, ...message });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// --- helpers --------------------------------------------------------------------------------------

function addr(a) {
  if (!a || !a.value || !a.value.length) return [];
  return a.value.map((v) => ({ name: v.name || '', email: v.address || '' }));
}

function summariseEnvelope(msg, mailbox) {
  const e = msg.envelope || {};
  const from = (e.from && e.from[0]) || {};
  return {
    uid: msg.uid,
    mailbox,
    from: { name: from.name || '', email: from.address || '' },
    subject: e.subject || '(no subject)',
    date: (e.date || new Date(0)).toISOString(),
    unread: !(msg.flags && msg.flags.has('\\Seen')),
    size: msg.size || null,
  };
}

export { addr };
