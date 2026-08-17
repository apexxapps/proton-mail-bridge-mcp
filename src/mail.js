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

// The two Proton mailboxes this tool touches. Everything defaults to reading INBOX; composed drafts
// land in Drafts. (Proton localises the display names but Bridge exposes these canonical paths.)
export const MAILBOX = {
  inbox: 'INBOX',
  drafts: 'Drafts',
};

function tlsOpts(cfg) {
  return { rejectUnauthorized: !cfg.allowSelfSigned };
}

// "SSL" = implicit TLS from the first byte; anything else (STARTTLS) = connect plain then upgrade.
function isImplicitTls(security) {
  return String(security).toUpperCase() === 'SSL';
}

// --- IMAP -----------------------------------------------------------------------------------------

function imapClient(cfg) {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.imapPort,
    secure: isImplicitTls(cfg.imapSecurity), // STARTTLS (default): false → imapflow upgrades in-band
    auth: { user: cfg.user, pass: cfg.pass },
    tls: tlsOpts(cfg),
    logger: false,
    emitLogs: false,
    // Fail fast instead of hanging if Bridge is mid-sync and not answering.
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

// imapflow flattens most failures to "Command failed" — dig out the useful bits (the server's NO
// text, whether it was an auth rejection) so callers can give a real diagnosis.
export function describeImapError(err) {
  const parts = [];
  if (err.authenticationFailed) parts.push('authentication rejected by Bridge');
  const server = err.responseText || err.response || (err.serverResponseCode ? `code ${err.serverResponseCode}` : '');
  if (server) parts.push(`server said: "${String(server).trim()}"`);
  // Bridge/gluon reports EVERY auth failure as "no such user" — including a wrong PASSWORD. Spell that
  // out; taking it literally (as "the username is unknown") sends you down a rabbit hole. (It cost us one.)
  if (/no such user/i.test(server)) {
    parts.push('(this means wrong username OR wrong password — Bridge says "no such user" for both; ' +
      'copy both fresh from Bridge → Mailbox details, don\'t transcribe by eye)');
  }
  if (!parts.length) parts.push(err.message || String(err));
  return parts.join(' — ');
}

// Run `fn(client)` against a freshly-connected IMAP client, always closing it afterwards.
export async function withImap(cfg, fn) {
  const client = imapClient(cfg);
  // imapflow emits an 'error' event on socket faults (e.g. a timeout during teardown). Node throws
  // on an unhandled 'error' event and would crash the whole process — swallow it here, since real
  // failures already surface as rejected promises from connect()/fn() that our callers catch.
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close().catch(() => {}));
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

// Fetch one attachment's bytes. Selection: by exact filename, else by 0-based index, else — if the
// message has exactly one attachment — that one. Returns the raw Buffer plus its name/type for the
// caller to write to disk.
export async function fetchAttachment(cfg, { uid, mailbox = MAILBOX.inbox, filename, index }) {
  const { parsed } = await getMessage(cfg, { uid, mailbox });
  const atts = parsed.attachments || [];
  if (atts.length === 0) throw new Error(`Message ${uid} has no attachments.`);

  let att;
  if (filename) att = atts.find((a) => (a.filename || '') === filename);
  else if (Number.isInteger(index)) att = atts[index];
  else if (atts.length === 1) att = atts[0];

  if (!att) {
    const names = atts.map((a, i) => `[${i}] ${a.filename || '(unnamed)'}`).join(', ');
    throw new Error(`Couldn't pick an attachment — specify filename or index. Available: ${names}`);
  }
  return {
    filename: att.filename || `attachment-${uid}`,
    contentType: att.contentType || 'application/octet-stream',
    content: att.content, // Buffer
    size: att.size || (att.content ? att.content.length : 0),
  };
}

export async function appendDraft(cfg, rawMime) {
  return withImap(cfg, async (client) => {
    await client.append(MAILBOX.drafts, rawMime, ['\\Draft']);
    return true;
  });
}

// --- SMTP -----------------------------------------------------------------------------------------

function smtpTransport(cfg) {
  const ssl = isImplicitTls(cfg.smtpSecurity);
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.smtpPort,
    secure: ssl, // SSL → implicit TLS; STARTTLS → false + requireTLS upgrades in-band
    requireTLS: !ssl,
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

// Check SMTP is reachable + accepts our credentials WITHOUT sending anything. Catches the classic
// "reading works but sending fails" mismatch (wrong smtpSecurity) at setup time. A wrong security
// setting can hang the handshake, so we race it against a timeout rather than block forever.
export async function verifySmtp(cfg, timeoutMs = 12000) {
  const transport = smtpTransport(cfg);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('SMTP handshake timed out — check the SMTP security setting (STARTTLS vs SSL).')), timeoutMs)
  );
  try {
    await Promise.race([transport.verify(), timeout]);
    return true;
  } finally {
    transport.close();
  }
}

// --- helpers --------------------------------------------------------------------------------------

function addr(a) {
  if (!a || !a.value || !a.value.length) return [];
  return a.value.map((v) => ({ name: v.name || '', email: v.address || '' }));
}

// Strip zero-width, bidi, and control characters — invisible to a human but a known vector for
// smuggling prompt-injection payloads into email text/subjects/sender names. (Keeps \t \n \r.)
function sanitizeText(text) {
  if (!text) return '';
  return text
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '') // zero-width, bidi, word-joiner, BOM
    .replace(/[ --]/g, ''); // control chars (keep \t \n \r)
}

function summariseEnvelope(msg, mailbox) {
  const e = msg.envelope || {};
  const from = (e.from && e.from[0]) || {};
  return {
    uid: msg.uid,
    mailbox,
    from: { name: sanitizeText(from.name || ''), email: from.address || '' },
    subject: sanitizeText(e.subject) || '(no subject)',
    date: (e.date || new Date(0)).toISOString(),
    unread: !(msg.flags && msg.flags.has('\\Seen')),
    size: msg.size || null,
  };
}

export { addr, sanitizeText };
