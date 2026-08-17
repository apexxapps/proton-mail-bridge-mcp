// Turn a raw parsed message into clean JSON an LLM can reason over — no MIME, no IMAP internals.
// The one non-obvious job here is trimming quoted history/signatures so a "summarise this" doesn't
// drown in forwarded chains.

import { addr } from './mail.js';

const QUOTE_MARKERS = [
  /^On .+ wrote:$/m, // "On Mon, 1 Jan 2026 ... <a@b> wrote:"
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{5,}$/m, // Outlook's underscore divider
  /^From:.*\nSent:.*\nTo:/im, // Outlook header block
];

// Cut the body at the first sign of quoted history, then collapse a trailing signature block.
function stripQuoted(text) {
  if (!text) return '';
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = text.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  let body = text.slice(0, cut);

  // Drop everything after a "-- " signature delimiter on its own line.
  const sig = body.search(/\n-- \n/);
  if (sig !== -1) body = body.slice(0, sig);

  // Trim a run of leading "> " quoted lines (top-posted quotes handled above; this catches stragglers).
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

function snippet(text, max = 280) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

// Full message → clean object. `opts.full` keeps the entire body; otherwise we strip quoted history.
export function cleanMessage({ parsed, flags, uid, mailbox }, opts = {}) {
  const bodyText = parsed.text || '';
  const trimmed = opts.full ? bodyText : stripQuoted(bodyText);
  return {
    uid,
    mailbox,
    messageId: parsed.messageId || null,
    from: addr(parsed.from)[0] || { name: '', email: '' },
    to: addr(parsed.to),
    cc: addr(parsed.cc),
    subject: parsed.subject || '(no subject)',
    date: (parsed.date || new Date(0)).toISOString(),
    unread: !(flags && flags.has('\\Seen')),
    body_text: trimmed,
    body_snippet: snippet(trimmed),
    quoted_trimmed: !opts.full && trimmed.length < bodyText.length,
    attachments: (parsed.attachments || []).map((a) => ({
      name: a.filename || '(unnamed)',
      type: a.contentType || 'application/octet-stream',
      size: a.size || 0,
    })),
    // Threading breadcrumbs so a reply tool can wire In-Reply-To/References correctly.
    inReplyTo: parsed.inReplyTo || null,
    references: parsed.references || null,
  };
}

export { stripQuoted, snippet };
