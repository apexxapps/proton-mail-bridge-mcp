#!/usr/bin/env node
// proton-mail-bridge-mcp — an MCP server exposing your ProtonMail (via a local Proton Bridge) to any
// MCP client (Claude Code, Claude Desktop, Cursor, …).
//
// It speaks MCP over stdio: the client spawns this process and talks JSON-RPC on stdin/stdout, so
// NOTHING may be written to stdout except the protocol itself. All logging goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, assertConfigured } from './config.js';
import { registerTools } from './tools.js';

async function main() {
  const cfg = loadConfig();
  // We do NOT hard-fail on missing config at startup — the server should still register and list its
  // tools so the client can introspect it. Individual tool calls throw a helpful error if unconfigured.
  try {
    assertConfigured(cfg);
  } catch (err) {
    process.stderr.write(`[proton-mail-bridge-mcp] ${err.message}\n`);
  }

  const server = new McpServer(
    { name: 'proton-mail-bridge-mcp', version: '0.1.0' },
    {
      instructions:
        'Access the user\'s ProtonMail. Reading and searching is safe to do freely. Sending, ' +
        'replying-and-sending, and trashing are irreversible-ish — prefer drafts, and confirm before ' +
        'sending. UIDs come from list/search results and are scoped to their mailbox.',
    }
  );

  registerTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[proton-mail-bridge-mcp] ready (${cfg.readOnly ? 'read-only' : 'read+write'}) via ${cfg.host}:${cfg.imapPort}\n`
  );
}

// `proton-mail-bridge-mcp doctor` runs the human-facing preflight; otherwise start the stdio server.
const entry = process.argv[2] === 'doctor' ? () => import('./doctor.js') : main;
entry().catch((err) => {
  process.stderr.write(`[proton-mail-bridge-mcp] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
