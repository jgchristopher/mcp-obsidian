# MCPVault REST Backend Contract

**Created**: 2026-07-30
**Readiness**: All 5 gates ready
**Status**: Approved
**Supersedes**: None

## Problem Statement

John runs two overlapping MCP servers against the same Obsidian vault. `obsidian-jcos` is the Python `mcp-obsidian` pinned to commit `4aac5c2`, reaching the vault over the Local REST API plugin. MCPVault reaches vaults over the filesystem. Together they present roughly 29 tools, many of which do the same thing by different routes.

Each server can do something the other cannot, so neither can be dropped. MCPVault has no access to anything that only exists inside a running Obsidian: periodic note resolution, registered commands, the active file, or link-preserving moves. The Python server has that access but cannot work when Obsidian is closed, and one of its tools is already broken here. `obsidian_get_recent_changes` issues a Dataview DQL query, and the Dataview plugin is not installed in the jcOS vault, so that request returns `400 errorCode 40012` today.

A naive merge of the two approaches introduces a data-integrity hazard that neither server has alone. The Local REST API binds to whichever vault Obsidian currently has open, which is jcOS, confirmed by comparing its root listing against the filesystem. MCPVault binds to its `vaultPath` argument. Nothing connects the two, and the plugin exposes no vault identity on its status endpoint. A server launched against one vault while Obsidian holds another would read and write different vaults depending only on whether the app happened to be running, and `write_note` would land content in the wrong vault with no error. Because Obsidian is almost always open here, a guard that only revalidates after a connection failure would effectively never run, so the check must be time-based rather than failure-triggered.

## Goals

1. Remove the `obsidian-jcos` entry from `~/.claude.json` with no capability lost: all 13 of its tools have a working MCPVault equivalent verified against the live jcOS vault.
2. Every routed tool returns equivalent observable results whether REST or the filesystem served it, enforced by a shared contract suite that runs both arms in CI without a live Obsidian.
3. Daily note resolution works with Obsidian closed, deriving folder and format from Obsidian's own daily-notes configuration so the two cannot drift apart.
4. A REST backend bound to a different vault than the server's `vaultPath` can never serve a request, including a vault switch that happens while Obsidian stays running and no connection ever fails.
5. With `OBSIDIAN_API_KEY` unset, behavior is unchanged from today: the existing test suite passes without a single test file being edited.
6. A write whose outcome is unknown because Obsidian became unreachable mid-request never re-applies against the filesystem.
7. Capabilities that exist only inside a running Obsidian become reachable from MCPVault: registered commands, the active file, opening a note in the UI, and Obsidian's own query index.

## Success Criteria

- [ ] Every one of the 13 `obsidian-jcos` tools maps to a MCPVault tool that is actually registered — check: `npm test -- src/backend/parity` — exits 0, asserting each mapped target name appears in the `ListTools` response from `createServer`
- [ ] REST and filesystem backends satisfy the same behavioral contract, with both arms genuinely executed — check: `npm test -- src/backend/contract --reporter=json` — exits 0 with a non-zero passed count and zero skipped for both arms
- [ ] `get_periodic_note('daily')` derives its path from Obsidian's config rather than a duplicated setting — check: `npm test -- src/backend/filesystem/periodic` — exits 0, resolving `Daily_Notes/2026/07/2026-07-30.md` for an injected date of 2026-07-30, and resolving a different path when the fixture's `.obsidian/daily-notes.json` format is changed
- [ ] A vault fingerprint mismatch disables REST and warns, at startup and on time-based revalidation with the connection healthy — check: `npm test -- src/backend/health` — exits 0, including a case where the fingerprint changes mid-session with no transport failure and the next write is refused
- [ ] An unknown-state write failure surfaces an error and performs no filesystem write, while a never-sent failure does fall back — check: `npm test -- src/backend/routing` — exits 0
- [ ] Existing behavior is unchanged when REST is disabled, and no pre-existing test was edited — check: `env -u OBSIDIAN_API_KEY npm test` — exits 0; and `git diff --stat main -- 'src/**/*.test.ts'` — no changes to the 9 pre-existing test files
- [ ] The package compiles on the supported Node matrix — check: `npm run build` — exits 0
- [ ] TLS relaxation is confined to the REST client's own agent — check: `grep -rn NODE_TLS_REJECT_UNAUTHORIZED src/ server.ts scripts/` — no matches; and `grep -rn rejectUnauthorized src/backend/rest/` — matches only inside the `https.Agent` construction
- [ ] Every Python-server equivalent works against the live jcOS vault — check: `npx tsx scripts/parity-smoke.ts` — exits 0 and prints 13 PASS lines, exits non-zero if any mapping fails
- [ ] The cutover actually happened — check: `grep -c obsidian-jcos ~/.claude.json` — returns 0 for the old entry; and `grep -n mcpvault ~/.claude.json` — shows the local dist path with the five `OBSIDIAN_` env vars
- [ ] The backend benchmark runs and reports both backends — check: `npx tsx scripts/backend-bench.ts` — exits 0 and prints REST and filesystem timings for `read_note`, `write_note`, and `list_directory`

## Scope Boundaries

### In Scope

- `VaultBackend` interface with a three-variant `BackendFailure` taxonomy
- `FileSystemBackend` as an adapter over the existing `FileSystemService`
- `RestClient` built on `node:https` with a scoped `Agent`
- In-repo REST test double (`node:http` fixture server)
- `RestBackend` for the 13 routed tools: `read_note`, `read_multiple_notes`, `get_notes_info`, `write_note`, `patch_note`, `delete_note`, `move_note`, `move_file`, `list_directory`, `get_frontmatter`, `update_frontmatter`, `manage_tags`, `list_all_tags`
- `search_notes`, `get_vault_stats`, and `wiki_link` stay filesystem-only
- Vault fingerprint guard with time-based revalidation
- Reachability flag rather than a half-open circuit breaker
- Five-variable configuration with explicit defaults and a plugin version floor of >= 4.1.7
- Shared backend contract test suite
- `get_periodic_note`, routed, with the config reader bypassing `PathFilter` entirely
- Date resolution limited to `YYYY`, `MM`, `DD` with a named error on any other token
- `get_document_map`, routed
- `get_recent_changes`, filesystem-native, reusing the existing vault scan
- `get_recent_periodic_notes`, filesystem-native
- `list_commands`, `execute_command`, `get_active_file`, `open_file`, `search_vault_advanced`
- Parity mapping test and live smoke script
- Backend benchmark script
- Cut `~/.claude.json` over to the local build, carrying the five `OBSIDIAN_` values across before deleting `obsidian-jcos`

### Out of Scope

- Using the plugin's own `/mcp` endpoint as the transport — REST has a stable OpenAPI spec, returns richer note payloads in one response, and needs no session handshake
- Dataview DQL queries in `search_vault_advanced` — the plugin is not installed; the endpoint returns `400 errorCode 40012`
- Weekly, monthly, quarterly, and yearly periodic resolution — the `periodic-notes` plugin is absent, so weekly returns 404 and the rest return 400
- Multi-vault support beyond jcOS — Obsidian serves one vault at a time, so a second instance would be filesystem-only anyway
- Routing `search_notes`, `get_vault_stats`, or `wiki_link` through REST — one would change result sets based on whether the app is open; the other two are whole-vault walks REST could only serve as N calls
- p95 latency assertions in the test suite — this repo already tuned a wall-clock test to 200ms for CI stability and then deleted it
- npm publishing under a personal scope — the config points at a local build path
- Upstream contribution to `bitbonsai/mcpvault` — explicitly chosen as a fork-local feature branch

### Future Considerations

- Install the `periodic-notes` plugin to unlock weekly, monthly, quarterly, and yearly resolution, which the tool already accepts
- Install Dataview to unlock DQL queries in `search_vault_advanced` and richer recent-changes queries
- Extract a shared test-helper module; the `mkdtemp` setup block is currently duplicated in every stateful test file
- Revisit upstream contribution if the backend seam proves stable and rebases stay cheap

## Execution Plan

### Dependency Graph

```
Phase 1: Backend seam and filesystem adapter        (low risk, blocking)
  └── Phase 2: REST client, backend, and test double    (medium risk, blocking)
        └── Phase 3: Routing, reachability, fingerprint guard  (HIGH risk, blocking)
              └── Phase 4: New tools                            (low risk)
                    └── Phase 5: Parity verification and cutover  (GATE, medium risk)
```

A strict chain. No two phases are independent, so there is nothing to parallelize.

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, and gates on failure:

```bash
/ideation:autopilot docs/ideation/mcpvault-rest-backend/contract.md
```

**Or run phases manually** in dependency order:

**Strategy**: Sequential

1. **Phase 1** — Backend seam and filesystem adapter _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/mcpvault-rest-backend/spec-phase-1.md
   ```

2. **Phase 2** — REST client, backend, and test double _(blocked by Phase 1)_

   ```bash
   /ideation:execute-spec docs/ideation/mcpvault-rest-backend/spec-phase-2.md
   ```

3. **Phase 3** — Routing, reachability, and vault fingerprint guard _(blocked by Phase 2)_

   ```bash
   /ideation:execute-spec docs/ideation/mcpvault-rest-backend/spec-phase-3.md
   ```

4. **Phase 4** — New tools _(blocked by Phase 3)_

   ```bash
   /ideation:execute-spec docs/ideation/mcpvault-rest-backend/spec-phase-4.md
   ```

5. **Phase 5** — Parity verification and cutover _(human gate, blocked by Phase 4, requires a running Obsidian on jcOS)_

   ```bash
   /ideation:execute-spec docs/ideation/mcpvault-rest-backend/spec-phase-5.md
   ```

---

_This contract was generated from an existing design document plus a gated interview. Review and approve before proceeding to specification._
