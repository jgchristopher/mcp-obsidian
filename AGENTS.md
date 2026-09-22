# Agent Instructions

## Project Overview

MCPVault is a Model Context Protocol (MCP) server that provides a universal AI bridge for Obsidian vaults. It enables any MCP-compatible AI assistant (Claude, ChatGPT, Gemini, etc.) to safely read and write notes in Obsidian vaults while preserving YAML frontmatter and enforcing security boundaries.

## Commands

```bash
# MCP server
npm run build          # Compile TypeScript to dist/
npm test               # Run test suite (Vitest)
npm run test:watch     # Tests in watch mode
npm start /path/vault  # Run server locally with tsx

# Single test
npm test -- path/to/test.test.ts
npm test -- -t "test name pattern"

# Live REST tests (skipped unless the key is set — see "Local REST API backend")
OBSIDIAN_API_KEY=… OBSIDIAN_VAULT_PATH=/path/to/vault npm test -- src/backend/rest/live

# Publishing
npm run publish:dry     # Dry run
npm run publish:beta    # Publish with beta tag
npm run publish:latest  # Publish as latest

# MCP Inspector
npx @modelcontextprotocol/inspector npm start /path/to/vault
```

## Architecture

### File Structure

```
server.ts              # Entry point — CLI args, stdio transport, shutdown
src/
  createServer.ts      # Tool registration and request handlers (all 26 tools)
  filesystem.ts        # FileSystemService — all file operations with security
  frontmatter.ts       # FrontmatterHandler — YAML parsing via gray-matter
  pathfilter.ts        # PathFilter — security layer for path validation
  search.ts            # SearchService — full-text search with token-optimized output
  uri.ts               # Obsidian URI generation
  types.ts             # All TypeScript interfaces
  wikilink/            # [[wiki link]] resolution and its tool
  backend/             # VaultBackend seam (see "Local REST API backend")
    types.ts           # VaultBackend interface, BackendFailure taxonomy
    routing.ts         # RoutingBackend — REST-preferred routing, fallback policy
    health.ts          # Health — reachability flag + vault fingerprint guard
    live.ts            # LiveBackend — the five Obsidian-only tools
    documentMap.ts     # buildDocumentMap — headings, block refs, frontmatter keys
    parity.ts          # Tool-to-REST mapping table
    periodic/          # Daily-note resolution from .obsidian/daily-notes.json
    filesystem/        # FileSystemBackend — adapter over FileSystemService
    rest/              # RestBackend, RestClient, config
    contract.test.ts   # One behavioral contract, run against both backends
    testing/           # fixture-server.ts (REST double) + seed.ts (paired vault)
  *.test.ts            # Co-located test files
scripts/               # backend-bench, parity-smoke, preflight, triage
```

### Core Components

**server.ts** — Entry point, ~90 lines. Handles CLI args (--help, --version, vault path), builds the stdio transport, and exits on stdin EOF / SIGTERM / SIGINT (graceful `server.close()`), otherwise hosts orphan the process (#159). It registers no tools itself.

**createServer** (`src/createServer.ts`) — Registers all 25 MCP tools, initializes services, routes tool calls. Auto-trims whitespace from all path arguments. Builds a `RoutingBackend` when `OBSIDIAN_API_KEY` is set and a plain `FileSystemBackend` otherwise.

**FileSystemService** (`src/filesystem.ts`) — Orchestrates file ops with security. Path resolution and traversal prevention. Implements: read, write, patch, delete, move, list, batch read, frontmatter update, tag management, vault stats. Uses native `fs/promises`.

**FrontmatterHandler** (`src/frontmatter.ts`) — Parses/stringifies YAML frontmatter via `gray-matter`. Validates structure (blocks functions, symbols, invalid types). Preserves original content.

**PathFilter** (`src/pathfilter.ts`) — Blocks `.obsidian/`, `.git/`, `node_modules/`, system files, and **any segment starting with `.` at any depth** — so `.env` and `.secrets.md` are refused even though `.md` is an allowed extension. Note tools allow `.md`, `.markdown`, `.txt`; directory listings may include other file types by filename. Checks path components independently.

**SearchService** (`src/search.ts`) — Content and frontmatter search with multi-word matching and BM25 relevance reranking. Returns token-optimized results with minified field names: `{p, t, ex, mc, ln, uri}`. Max 20 results.

### 25 MCP Tools

Grouped by what serves them. The **Routed** group goes through `VaultBackend`,
so REST answers it when `OBSIDIAN_API_KEY` is set and the filesystem answers it
otherwise. The other two groups always take one path, no matter the config.

**Routed — REST-preferred, filesystem fallback (15)**

| Tool | Description |
|------|-------------|
| read_note | Read a single note with frontmatter |
| write_note | Create or overwrite (supports overwrite, append, prepend modes) |
| patch_note | Efficient partial update via find-and-replace |
| list_directory | List files and folders in the vault |
| delete_note | Delete a note (requires path confirmation) |
| move_note | Move or rename a note |
| move_file | Move or rename any file (binary-safe, file-only, requires path confirmation) |
| read_multiple_notes | Batch read up to 10 notes |
| update_frontmatter | Safely update YAML frontmatter |
| get_notes_info | Get metadata without reading content |
| get_frontmatter | Extract frontmatter only |
| manage_tags | Add, remove, or list tags |
| list_all_tags | List all tags across the vault with occurrence counts |
| get_periodic_note | Resolve a daily note from `.obsidian/daily-notes.json` (daily only; other periods need the periodic-notes plugin) |
| create_periodic_note | Return today's daily note, creating it from the configured template first. Obsidian's own `daily-notes` command when Obsidian is running, core-token rendering here when it is not. Idempotent |
| get_document_map | Headings, block refs, and frontmatter keys for a note |

**Filesystem-only — never reaches REST (5)**

| Tool | Description | Why |
|------|-------------|-----|
| search_notes | Full-text search across vault content | REST would change the result set based on whether Obsidian is open |
| get_vault_stats | Vault statistics: total notes, folders, size, recent files | Whole-vault walk; REST could only serve it as N calls |
| wiki_link | Resolve Obsidian [[wiki links]] (incl. path-qualified [[folder/Note]]) and return the note | Same |
| get_recent_changes | Recently modified notes, by mtime | Reuses the vault scan; the Python equivalent needs Dataview and returns 400 here |
| get_recent_periodic_notes | Recent daily notes | Filesystem-native by design |

**Live-only — requires a running Obsidian, no fallback (5)**

| Tool | Description |
|------|-------------|
| list_commands | Registered Obsidian commands |
| execute_command | Run a registered command by id |
| get_active_file | The note currently open in the UI |
| open_file | Open a note in the Obsidian UI |
| search_vault_advanced | Query Obsidian's index with a JsonLogic expression (Dataview DQL is not supported) |

These five throw `ObsidianUnavailableError` when REST is unreachable. Note that
`open_file` takes a path but is **not** covered by the fingerprint guard, which
only protects `VaultBackend` — it can navigate the UI in a vault other than the
server's `vaultPath`.

### Design Patterns

- **Service layer**: Each service has single responsibility, dependency-injected into server.ts, independently testable
- **Security-first**: All paths validated through PathFilter, `resolvePath()` prevents traversal, confirmation required for destructive ops
- **Token optimization**: Minified field names by default (`fm` not `frontmatter`), optional `prettyPrint` parameter, compact search format
- **Error handling**: Structured results with `success` boolean, failed batch ops return partial results (`ok` + `err` arrays)

### Key Implementation Details

- **Paths**: Always relative to vault root. Leading slashes stripped. Whitespace trimmed automatically.
- **Frontmatter**: Always use FrontmatterHandler for read/write. `originalContent` field has raw file content. Empty frontmatter = no YAML block.
- **Write modes**: overwrite (default), append (content to end, merge frontmatter), prepend (content to beginning, merge frontmatter)
- **Patch**: Exact string match including whitespace/newlines. `replaceAll: false` (default) fails on multiple matches to prevent accidents.
- **Version**: Read from `package.json` at runtime. Used in MCP server init and the --version flag.

## Local REST API backend

`src/backend/` holds a `VaultBackend` seam so vault operations can be served by
the filesystem or by the Obsidian Local REST API plugin. `createServer` builds a
`RoutingBackend` when `OBSIDIAN_API_KEY` is set and a plain `FileSystemBackend`
otherwise — with the key unset, construction is identical to the pre-REST build.

### Routing policy

`RoutingBackend` prefers REST and falls back by failure kind, asymmetrically:

| Failure | Read | Write |
|---|---|---|
| `never-sent` | filesystem | filesystem (nothing was applied) |
| `unknown-state` | filesystem | **throws** — never re-applied |
| `unsupported` | filesystem | filesystem (refused before sending) |
| any HTTP status | no fallback — it is Obsidian's authoritative answer | same |

Reads are listed explicitly in `READ_OPERATIONS`; anything absent is treated as
a write. An operation added to `VaultBackend` and forgotten there loses fallback
rather than gaining a duplicate write.

### Vault fingerprint guard

The plugin binds to whichever vault Obsidian has open; MCPVault binds to its
`vaultPath` argument. `Health` compares the two by their **sorted set of
root-level `.md` filenames** and refuses REST when they disagree. Revalidation
is time-based (60s TTL), not failure-triggered: Obsidian is normally open, so a
failure-triggered check would run once at startup and never catch a mid-session
vault switch. Reachability is a boolean plus a timestamp (30s), not a circuit
breaker — a closed Obsidian refuses on loopback immediately.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `OBSIDIAN_API_KEY` | unset | **Unset disables REST entirely.** `resolveRestConfig()` returns `null` and behavior is identical to a build with no REST code |
| `OBSIDIAN_HOST` | `127.0.0.1` | |
| `OBSIDIAN_PORT` | `27123` | Not 27124 — see the trap below |
| `OBSIDIAN_PROTOCOL` | `https` | |
| `OBSIDIAN_VERIFY_SSL` | `false` | The plugin ships a self-signed certificate |
| `OBSIDIAN_VAULT_PATH` | unset | Live tests only; the vault the running Obsidian has open |

Names mirror the Python `mcp-obsidian` server exactly, so an existing MCP client
entry migrates by copy-paste. A malformed port, protocol, or boolean throws at
startup rather than defaulting: a typo should stop the server, not silently pin
it to filesystem fallback.

**Plugin version floor: >= 4.1.7**, read from `versions.self` in `GET /`. BRAT is
in play on the target vault, so versions move without warning. A lower version
warns and continues; it never refuses to start.

### Conditional-skip idiom

`src/backend/rest/live.test.ts` is the repo's first conditionally skipped suite:
`describe.skipIf(!config)` gated on `OBSIDIAN_API_KEY`. It is a drift detector
against a real Obsidian, never a substitute for the fixture-backed suite —
nothing that proves backend equivalence may live behind the guard, because the
phase 3 contract suite must report zero skips.

## Testing

Vitest with globals enabled, node environment. Test files co-located as `*.test.ts`.

When writing tests:
- Test both success and error cases
- Test path security (traversal, access denied)
- Test frontmatter parsing edge cases
- Use `Promise.allSettled` patterns for batch operations
- REST-backed code tests against `src/backend/testing/fixture-server.ts`, an
  in-process `node:http` double with injectable socket failures. CI has no
  Obsidian, so anything gated on a live plugin proves nothing there.

## Security

When modifying file operations:
- Always validate paths through PathFilter
- Always use `resolvePath()` to prevent traversal
- Never expose system directories or configuration
- Validate frontmatter before writing
- Require confirmation for destructive operations

## Config Files

- `tsconfig.json` — Main TypeScript config (strict mode, ES2022 target, module/moduleResolution `nodenext`)
- `tsconfig.build.json` — Build config (excludes tests, outputs to `dist/`)
- `vitest.config.ts` — Test config (globals, node environment)

## Fork

This repo is a fork. `origin` is `jgchristopher/mcp-obsidian`; `upstream` is
`bitbonsai/mcpvault`, which it branched from at `6bef558` (v0.12.5). Upstream
has moved on by ~180 commits and is on 0.16.0; the REST backend, the nine
extra tools, and `docs/ideation/` are this fork's and exist nowhere upstream.

The hazard is **convergent implementation**, not merge conflicts. Both trees
solved the same problems in differently-named files, so an upstream fix often
applies to code here under another name and `git merge` will never say so —
upstream's fence fixes landed in a `getNoteOutline` this fork lacks, while the
same bugs sat in `src/backend/documentMap.ts`. Before dismissing an upstream
commit as inapplicable, look for this fork's equivalent of the file it touches.

Nothing here deploys a website. mcpvault.org is upstream's domain, served from
upstream's repo.

## Gotchas

- `dist/` is committed. Every src change needs `npm run build` + commit dist in the SAME change; src-only merges leave dist stale (happened twice: fde15eb engine swap, PR #151).
- TypeScript toolchain upgrades change dist output (TS7 altered `.d.ts.map` sourcemaps only) — rebuild + commit dist after any TS bump or the dirty tree blocks automation that requires clean main.
- Claude Code discovers skills only under `.claude/skills/`; repo keeps them in `skills/`. Committed symlink `.claude/skills/triage -> ../../skills/triage` bridges it — same pattern for any new skill.
- `pathFilter.isAllowed` + `normalizePath` must guard EVERY new tool's path input (upstream PR #146 blocker: a `readNoteLines` tool, which this fork does not carry, skipped them = read `.obsidian/` files). Mirror `readNote`'s guard block.
- Outline/heading parsing must be fence-aware: `#` lines inside ``` blocks are not headings. `src/backend/documentMap.ts` is the only fence parser in the tree — `patch_note` is exact-string find-and-replace and parses nothing. Its headings follow CommonMark: up to 3 spaces of indent, optional text (bare `#`), and a closer only on whitespace after the run. The required space before the text is what keeps an Obsidian tag like `#project` from matching. Heading paths feed the REST `PATCH` `Target` header verbatim, so a mis-parsed heading is a reachable write target, not just a wrong listing.
- The REST port default is **27123**, not the 27124 the plugin's OpenAPI document implies. Those are shipped defaults; the real ports come from the vault's plugin settings, and on jcOS HTTPS listens on 27123 with the insecure server disabled. A 27124 default fails every connection and looks exactly like "REST just never helps".
- Never touch `NODE_TLS_REJECT_UNAUTHORIZED`. It disables certificate validation for every outbound request in the process. The plugin's self-signed cert is handled by `rejectUnauthorized` on `RestClient`'s own agent — the only permitted site (`grep -rn rejectUnauthorized src/backend/rest/`).
- The fingerprint compares **only root-level `.md` filenames**. The plugin builds `/vault/` from `getFiles()` so it omits empty directories, while `PathFilter` drops dotfiles and restricted directories — comparing full listings mismatches on a correctly configured machine and silently pins the server to filesystem-only.
- `src/backend/contract.test.ts` must never contain a `skipIf`. Its REST arm runs against the in-process fixture; gating it on a live Obsidian would let CI report success while proving nothing about backend equivalence.
- Backend warnings go to **stderr** (`onWarn`, defaulting to `console.error`). stdout carries the MCP protocol on stdio transport; one stray line corrupts the session.
- `RestClient` classifies transport failures on the request's `finish` event, never on `error.code`. `ETIMEDOUT` fires on both sides of the send boundary, and misreading a post-send timeout as `never-sent` is what duplicates an `append`. Node suppresses `finish` when the socket already errored, which is what makes the flag trustworthy.
- Request timeouts use an explicit deadline timer, not `req.setTimeout`. Node arms the socket's idle timer only after `connect`, so a blackholed host would hang forever and the pre-send timeout would never fire.
