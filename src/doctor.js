#!/usr/bin/env node
// `proton-mail-bridge-mcp doctor` — a human-facing preflight. Checks that config exists and that Bridge is
// actually reachable + accepting the credentials, so setup problems surface HERE with a clear message
// instead of as a cryptic failure inside an agent's tool call. Prints to stdout (this is not the MCP
// server — it's a CLI check), exits non-zero on failure.

import { loadConfig, assertConfigured, configFilePath } from './config.js';
import { withImap, listMailboxes, describeImapError } from './mail.js';

async function main() {
  const cfg = loadConfig();
  console.log('proton-mail-bridge-mcp doctor\n');
  console.log(`  config file:  ${configFilePath()}`);
  console.log(`  host:         ${cfg.host}`);
  console.log(`  imap port:    ${cfg.imapPort}`);
  console.log(`  smtp port:    ${cfg.smtpPort}`);
  console.log(`  user:         ${cfg.user || '(unset)'}`);
  console.log(`  from:         ${cfg.fromAddress || '(defaults to user)'}`);
  console.log(`  self-signed:  ${cfg.allowSelfSigned ? 'allowed (Bridge default)' : 'rejected'}`);
  console.log(`  mode:         ${cfg.readOnly ? 'read-only' : 'read+write'}\n`);

  try {
    assertConfigured(cfg);
  } catch (err) {
    console.error(`  ✗ ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write('  connecting to Proton Bridge over IMAP… ');
  try {
    const boxes = await withImap(cfg, () => listMailboxes(cfg));
    console.log('ok');
    console.log(`  ✓ authenticated — ${boxes.length} mailboxes visible.\n`);
    console.log('  You\'re good. Register it with your MCP client, e.g. Claude Code:');
    console.log('    claude mcp add protonmail --scope user -- npx -y proton-mail-bridge-mcp\n');
  } catch (err) {
    console.log('failed');
    console.error(`  ✗ ${describeImapError(err)}`);
    console.error('\n  Common causes:');
    console.error('    • Proton Bridge isn\'t running (start the Bridge app / `protonmail-bridge --cli`).');
    console.error('    • Wrong credentials — copy them from Bridge → account → Mailbox details,');
    console.error('      NOT your normal Proton password.');
    console.error('    • Ports differ — check Bridge → Settings → IMAP/SMTP.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
