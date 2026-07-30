#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/createServer.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const VERSION = packageJson.version;

// Handle --version and --help flags
const cliArgs = process.argv.slice(2);
const firstArg = cliArgs[0];

if (firstArg === "--version" || firstArg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (firstArg === "--help" || firstArg === "-h") {
  console.log(`
mcpvault v${VERSION}

Universal AI bridge for Obsidian vaults - connect any MCP-compatible assistant

Usage:
  npx @bitbonsai/mcpvault [vault-path]

Arguments:
  [vault-path]    Optional path to your Obsidian vault directory
                  Defaults to current working directory when omitted

Options:
  --version, -v   Show version number
  --help, -h      Show this help message

Examples:
  npx @bitbonsai/mcpvault
  npx @bitbonsai/mcpvault ~/Documents/MyVault
  npx @bitbonsai/mcpvault ./Vault
  npx @bitbonsai/mcpvault /path/to/obsidian/vault
  npx @bitbonsai/mcpvault "/path/with spaces/Obsidian Vault"
`);
  process.exit(0);
}

// Join trailing args to support vault paths with spaces.
// When omitted, default to current working directory.
const vaultPathArg = cliArgs.join(' ').trim();
const vaultPath = resolve(vaultPathArg || process.cwd());

// Backend warnings — vault fingerprint mismatches, the Local REST API plugin
// version floor — go to stderr, tagged so they are attributable in a host's
// log. stdout is the MCP protocol stream on stdio transport; a stray line there
// corrupts the session.
const server = createServer(vaultPath, {
  version: VERSION,
  onWarn: (message: string) => process.stderr.write(`[mcpvault] ${message}\n`),
});
const transport = new StdioServerTransport();
await server.connect(transport);

// Exit when the client disconnects (stdin EOF) or the process is asked to
// terminate. Hosts that don't send an MCP shutdown request otherwise leave
// this process running forever, orphaned once stdin closes (#159).
let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    await server.close();
  } catch {
    // Best-effort: exit regardless of transport close errors.
  }
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
