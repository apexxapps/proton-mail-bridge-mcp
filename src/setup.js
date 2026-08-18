#!/usr/bin/env node
// `proton-mail-bridge-mcp setup` — an interactive first-run wizard.
//
// The whole design goal: get someone connected in ~60 seconds by mirroring Proton Bridge's
// "Mailbox details" panel field-for-field, in the same order, so they just paste each value (Bridge
// has a copy button on every field). We then test IMAP *and* SMTP live before saving, so the two
// traps that bite people — a mistyped password (Bridge reports it as "no such user") and a wrong
// SMTP security setting (reading works, sending silently fails) — are caught here, not mid-conversation.
//
// Dependency-free: Node's readline, with a masked prompt for the password.

import readline from 'node:readline';
import fs from 'node:fs';
import { configFilePath, saveConfig } from './config.js';
import { withImap, listMailboxes, verifySmtp, describeImapError } from './mail.js';

function ask(rl, question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (a) => resolve((a || '').trim() || fallback || ''));
  });
}

// Prompt without echoing the typed characters (for the password). Masks only on a real TTY; piped
// input isn't echoed anyway, and trying to mute it can wedge.
function askHidden(rl, question) {
  return new Promise((resolve) => {
    const prompt = `  ${question}: `;
    if (!process.stdin.isTTY) {
      rl.question(prompt, (a) => resolve((a || '').trim()));
      return;
    }
    let muted = false;
    const original = rl._writeToOutput ? rl._writeToOutput.bind(rl) : (s) => rl.output.write(s);
    rl._writeToOutput = (str) => {
      if (!muted) rl.output.write(str);
    };
    rl.question(prompt, (a) => {
      rl._writeToOutput = original;
      rl.output.write('\n');
      resolve((a || '').trim());
    });
    muted = true; // begin muting immediately after the prompt is drawn
  });
}

async function askSecurity(rl, label, fallback) {
  while (true) {
    const v = (await ask(rl, `${label} security — STARTTLS or SSL (copy from Bridge)`, fallback)).toUpperCase();
    if (v === 'STARTTLS' || v === 'SSL') return v;
    console.log('    Please type STARTTLS or SSL.');
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  proton-mail-bridge-mcp setup\n');
  console.log('  Open Proton Bridge -> your account -> Mailbox details. Copy each value below');
  console.log("  (Bridge has a copy button on every field — paste, don't type, especially the password).\n");

  const existingPath = configFilePath();
  if (fs.existsSync(existingPath)) {
    const yes = await ask(rl, `A config already exists at ${existingPath}. Overwrite? (y/N)`, 'N');
    if (!/^y/i.test(yes)) {
      console.log('  Keeping the existing config. Run `proton-mail-bridge-mcp doctor` to test it.\n');
      rl.close();
      return;
    }
    console.log('');
  }

  const user = await ask(rl, 'IMAP Username (e.g. you@proton.me)');
  const pass = await askHidden(rl, 'Password (paste from Bridge — hidden)');
  const imapPort = Number(await ask(rl, 'IMAP Port', '1143'));
  const smtpPort = Number(await ask(rl, 'SMTP Port', '1025'));
  const imapSecurity = await askSecurity(rl, 'IMAP', 'STARTTLS');
  const smtpSecurity = await askSecurity(rl, 'SMTP', 'SSL');

  const cfg = {
    host: '127.0.0.1',
    imapPort,
    smtpPort,
    user,
    pass,
    fromAddress: user,
    imapSecurity,
    smtpSecurity,
    allowSelfSigned: true,
    readOnly: false,
  };

  // --- test before saving --------------------------------------------------------------------------
  console.log('');
  process.stdout.write('  Testing IMAP (reading)... ');
  try {
    const boxes = await withImap(cfg, () => listMailboxes(cfg));
    console.log(`ok — ${boxes.length} mailboxes.`);
  } catch (err) {
    console.log('failed');
    console.error(`  x ${describeImapError(err)}\n`);
    console.error('  Nothing was saved. Re-copy your username and password from Bridge (the copy');
    console.error('  buttons — a single mistyped character reads as "no such user") and run setup again.\n');
    rl.close();
    process.exitCode = 1;
    return;
  }

  process.stdout.write('  Testing SMTP (sending)... ');
  let smtpOk = true;
  try {
    await verifySmtp(cfg);
    console.log('ok.');
  } catch (err) {
    smtpOk = false;
    console.log('failed');
    console.error(`  ! ${err.message}`);
    console.error('    Reading works but sending does not — this is almost always the SMTP security');
    console.error(`    setting. You entered "${smtpSecurity}"; check Bridge's SMTP Security value and`);
    console.error('    re-run setup if it differs. Saving anyway so reading works.');
  }

  const saved = saveConfig(cfg);
  console.log(`\n  Saved to ${saved}${smtpOk ? '' : ' (SMTP unverified — see above)'}`);
  console.log('\n  Now register it with your MCP client, e.g. Claude Code:');
  console.log('    claude mcp add protonmail --scope user -- npx -y proton-mail-bridge-mcp@latest\n');
  rl.close();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
