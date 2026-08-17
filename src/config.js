// Config loading for protonmail-mcp.
//
// Talking to ProtonMail means talking to a *locally-running Proton Bridge* — Bridge exposes an
// IMAP and an SMTP server on localhost and hands out its own generated username/password (NOT your
// Proton login). We read those here. Precedence: environment variables win, then a JSON file at
// $PROTONMAIL_MCP_CONFIG or ~/.config/protonmail-mcp/config.json, then Bridge's documented defaults.
//
// Nothing here is Proton-official — Bridge is the sanctioned local gateway, and everything stays on
// 127.0.0.1, so decrypted mail never leaves the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = {
  host: '127.0.0.1',
  imapPort: 1143, // Bridge default (STARTTLS)
  smtpPort: 1025, // Bridge default (STARTTLS)
  allowSelfSigned: true, // Bridge presents a self-signed cert on localhost — expected, not a red flag
  readOnly: false, // when true, only the read tools are registered (no send/draft/move/delete)
};

function configFilePath() {
  if (process.env.PROTONMAIL_MCP_CONFIG) return process.env.PROTONMAIL_MCP_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'protonmail-mcp', 'config.json');
}

function readFileConfig() {
  const p = configFilePath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read config at ${p}: ${err.message}`);
  }
}

function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function loadConfig() {
  const file = readFileConfig();
  const env = process.env;

  const cfg = {
    host: env.PROTONMAIL_HOST || file.host || DEFAULTS.host,
    imapPort: Number(env.PROTONMAIL_IMAP_PORT || file.imapPort || DEFAULTS.imapPort),
    smtpPort: Number(env.PROTONMAIL_SMTP_PORT || file.smtpPort || DEFAULTS.smtpPort),
    user: env.PROTONMAIL_USER || file.user || '',
    pass: env.PROTONMAIL_PASS || file.pass || '',
    // The address mail is sent *from*. Usually your Proton address; defaults to the Bridge username
    // when that already looks like an email.
    fromAddress: env.PROTONMAIL_FROM || file.fromAddress || '',
    allowSelfSigned: bool(env.PROTONMAIL_ALLOW_SELF_SIGNED, bool(file.allowSelfSigned, DEFAULTS.allowSelfSigned)),
    readOnly: bool(env.PROTONMAIL_READONLY, bool(file.readOnly, DEFAULTS.readOnly)),
  };

  if (!cfg.fromAddress && /@/.test(cfg.user)) cfg.fromAddress = cfg.user;
  return cfg;
}

// Fail loudly and helpfully rather than letting IMAP throw a cryptic auth error deep in a tool call.
export function assertConfigured(cfg) {
  const missing = [];
  if (!cfg.user) missing.push('user (Bridge IMAP/SMTP username)');
  if (!cfg.pass) missing.push('pass (Bridge-generated password)');
  if (missing.length) {
    throw new Error(
      `protonmail-mcp is not configured — missing: ${missing.join(', ')}.\n` +
        `Set PROTONMAIL_USER / PROTONMAIL_PASS, or create ${configFilePath()} ` +
        `(see config.example.json). These come from Proton Bridge → your account → Mailbox details, ` +
        `NOT your normal Proton password.`
    );
  }
}

export { configFilePath };
