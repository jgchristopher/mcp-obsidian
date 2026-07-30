# Local REST API Backend with Filesystem Fallback

Date: 2026-07-30
Status: Approved, ready for implementation planning
Branch: `feat/rest-backend` (fork-local, not intended for upstream)

## Problem

MCPVault reads and writes Obsidian vaults through the filesystem. That works
headless but cannot reach anything that only exists inside a running Obsidian:
periodic note resolution, registered commands, the currently open file, or
link-preserving moves.

The Obsidian Local REST API plugin exposes all of it. The goal is to use that
plugin when it is reachable and degrade to the filesystem when it is not,
without the tool surface changing underneath the caller.

## Context

Verified against the live environment on 2026-07-30:

- Plugin is `obsidian-local-rest-api` v4.1.7, branded "Local REST API with MCP".
- Reachable at `https://127.0.0.1:27123` with a self-signed certificate.
- The plugin also serves its own MCP endpoint at `/mcp`. We are not using it.
  REST is documented by a stable OpenAPI spec, returns richer note payloads
  (frontmatter, tags, links, backlinks in one response), and needs no session
  handshake. The MCP endpoint offers no capability REST lacks.
- `/vault/{filename}` supports a WebDAV-style `MOVE` verb with a `Destination`
  header. The spec states it preserves file history and updates internal links.
- `PATCH /vault/{filename}` targets `heading`, `block`, or `frontmatter` via
  `Operation`, `Target-Type`, and `Target` headers.
- Vault `jcOS` has core `daily-notes` configured as folder `Daily_Notes`,
  format `YYYY/MM/YYYY-MM-DD`. It does not have the `periodic-notes`
  community plugin.

### Known limitation, not caused by this design

Only the `daily` period resolves in the `jcOS` vault today. `weekly` returns
404 and `monthly`, `quarterly`, and `yearly` return 400, because the
`periodic-notes` community plugin is absent. The tool accepts all five periods
and the remaining four begin working once that plugin is installed. No part of
this design changes that.

## Architecture

A `VaultBackend` interface is inserted between the tool handlers in
`createServer.ts` and the services that do the work. Tool handlers call the
backend and never learn which one answered.

```
createServer.ts  (16 tool handlers + 7 new)
        |
        v
   VaultBackend                    one interface
        |
   RoutingBackend                  the only place fallback logic lives
      +-- RestBackend        -> Local REST API
      +-- FileSystemBackend  -> existing FileSystemService
```

### File layout

```
src/backend/
  types.ts              VaultBackend interface, BackendFailure taxonomy
  routing.ts            REST-preferred routing, fallback policy
  health.ts             availability cache, circuit breaker
  filesystem/
    index.ts            FileSystemBackend, adapter over FileSystemService
    periodic.ts         .obsidian config read, headless periodic resolution
    dateFormat.ts       moment-token subset
  rest/
    index.ts            RestBackend, VaultBackend mapped to REST endpoints
    client.ts           HTTP, auth, TLS, transport-error classification
```

`FileSystemService`, `PathFilter`, `FrontmatterHandler`, and `SearchService`
keep their current responsibilities. `FileSystemBackend` adapts rather than
replaces, so the existing filesystem test suite stays valid and untouched.

## Routing policy

REST is attempted first for every operation except `search_notes`. The
fallback rule depends on whether the request provably left the machine.

| Failure | Meaning | Reads | Writes |
|---|---|---|---|
| `ECONNREFUSED`, `ENOTFOUND`, TLS handshake rejected | never sent | fall back | fall back |
| `ETIMEDOUT` after send, socket hangup mid-response | state unknown | fall back | surface error |
| Any HTTP response, including 404, 400, 500 | authoritative | propagate | propagate |

Reads are idempotent, so retrying them against the filesystem is always safe.

Writes are not. A timeout after the request was written means Obsidian may
have applied the change before becoming unreachable. Falling back would apply
it a second time, which is most damaging in `append` mode and least likely to
be noticed. Those cases return an explicit error naming the path and stating
that the write state is unverified.

An HTTP response of any status means Obsidian received and processed the
request. That is an answer, not a failure, so it propagates unchanged. A 404
from REST is a real "note does not exist" and must not trigger a second
lookup.

### Health caching

The first never-sent failure marks REST down for 30 seconds and subsequent
calls skip the attempt entirely. A closed Obsidian then costs one connection
attempt per 30 seconds rather than one per call. The next call after the TTL
expires retries REST and restores it on success.

Request timeout is 5 seconds.

## Search

`search_notes` is pinned to the filesystem and never routes through REST.

MCPVault ranks results with BM25 over its own index. Obsidian's
`/search/simple/` applies its own ranking. Routing this tool would mean the
same query returns a different result set depending on whether Obsidian
happened to be open, which is a silent behavior change during scheduled runs
and hard to trace back to its cause.

Obsidian's query capability is still worth exposing, so it becomes a distinct
tool rather than a hidden alternate path.

## Tool surface

Existing 16 tools keep their names, arguments, and response shapes. Routing is
invisible to callers.

Seven new tools. Two of them have a working filesystem path and route like any
other read. The other five depend on a running Obsidian and return a clear
error naming that dependency when it is unreachable.

| Tool | Backend | Endpoint | Notes |
|---|---|---|---|
| `get_periodic_note` | routed | `/periodic/{period}/`, dated variant | Filesystem fallback resolves from Obsidian config, see below |
| `get_document_map` | routed | `GET /vault/{filename}` | Heading paths, block refs, frontmatter keys. Derived by parsing note content, so the filesystem serves it identically when Obsidian is closed |
| `list_commands` | REST only | `GET /commands/` | Discover command ids |
| `execute_command` | REST only | `POST /commands/{commandId}/` | Widest blast radius, reaches every installed plugin |
| `get_active_file` | REST only | `GET /active/` | Path of the note open in Obsidian |
| `open_file` | REST only | `POST /open/{filename}` | UI side effect only, does not modify the vault |
| `search_vault_advanced` | REST only | `POST /search/` | JsonLogic and Dataview queries against Obsidian's index |

`get_document_map` is deliberately not REST-only. Heading and block structure
is a pure function of file content, so gating it behind a running Obsidian
would break it headless for no reason. Both backends parse the same markdown
and the contract suite asserts they produce identical maps.

## Periodic notes

`get_periodic_note(period, date?)` resolves through REST when available, using
`/periodic/{period}/` for the current period and the dated form for a specific
date.

The filesystem fallback reads Obsidian's own configuration so it stays correct
when settings change. `daily-notes.json` supplies the daily folder and format.
`periodic-notes.json` supplies the rest when that plugin is present.

Date formatting implements a subset of moment tokens: `YYYY`, `YY`, `MM`, `M`,
`DD`, `D`, `ddd`, `dddd`, `w`, `ww`, `Q`, `MMM`, `MMMM`. No new dependency.

The format string may contain directory separators. The `jcOS` configuration
is `YYYY/MM/YYYY-MM-DD` in folder `Daily_Notes`, which resolves to
`Daily_Notes/2026/07/2026-07-30.md`. Any implementation that assumes a flat
folder produces the wrong path, so this case is a required test.

## Configuration

Environment variables match the Python `mcp-obsidian` server exactly, so
migrating an existing config is copy-paste.

| Variable | Default | Effect |
|---|---|---|
| `OBSIDIAN_API_KEY` | unset | Unset disables REST entirely |
| `OBSIDIAN_HOST` | `127.0.0.1` | |
| `OBSIDIAN_PORT` | `27124` | The `jcOS` setup uses `27123` |
| `OBSIDIAN_PROTOCOL` | `https` | |
| `OBSIDIAN_VERIFY_SSL` | `false` | Plugin ships a self-signed certificate |

With `OBSIDIAN_API_KEY` unset, the server behaves exactly as it does today.
The feature is additive and off by default.

## Security

Two constraints are non-negotiable.

**TLS scope.** `OBSIDIAN_VERIFY_SSL=false` sets `rejectUnauthorized: false` on
a dedicated `https.Agent` used only by this client. It must never set
`NODE_TLS_REJECT_UNAUTHORIZED`, which disables certificate validation for
every outbound request in the process.

**Config allowlist.** `PathFilter` continues to block `.obsidian/`. The
periodic resolver receives a separate read-only accessor matching exactly two
filenames, `daily-notes.json` and `periodic-notes.json`. No tool argument can
reach it. `read_note` against a crafted `.obsidian` path is rejected exactly
as it is today.

Additional notes:

- The API key is read from the environment and never written to logs, error
  messages, or tool responses.
- `execute_command` can invoke anything any installed plugin registers. Its
  tool description states this plainly so the calling model treats it as
  consequential.

## Testing

**Backend contract suite.** One parameterized test file defines what any
`VaultBackend` must do, executed against both implementations. This is what
makes two backends affordable to maintain. Divergence between REST and
filesystem behavior becomes a test failure instead of a production surprise.

**Routing policy tests.** A fake backend throws each classified failure in
turn. Locks down the read/write asymmetry, specifically that a write timeout
surfaces an error and never falls back.

**Client classification tests.** `ECONNREFUSED`, DNS failure, TLS rejection,
post-send timeout, and HTTP 404/400/500 each map to the correct
`BackendFailure` kind.

**Date format tests.** Token coverage plus the nested `YYYY/MM/YYYY-MM-DD`
case.

**Health cache tests.** Circuit opens after a never-sent failure, suppresses
attempts during the TTL, and recovers after it expires.

**Live integration tests.** Skipped when `OBSIDIAN_API_KEY` is unset so CI
stays green without a running Obsidian.

## Risks

| Risk | Mitigation |
|---|---|
| REST and filesystem write semantics diverge on frontmatter or parent directory creation | Contract suite asserts identical observable behavior |
| Write timeout duplicates content | Writes never fall back on unknown-state failures |
| `.obsidian` allowlist widens over time into a general config reader | Exact filename match, read-only, unreachable from tool arguments |
| `execute_command` misused by a calling model | Explicit tool description, REST-only so it fails closed when Obsidian is shut |
| Fork diverges from an active upstream | Feature is additive and isolated under `src/backend/`, which keeps rebases tractable |

## Out of scope

- Using the plugin's `/mcp` endpoint as a transport.
- Making weekly and longer periods work without the `periodic-notes` plugin.
- Routing `search_notes` through REST.
- Upstream contribution to `bitbonsai/mcpvault`.
