# Implementation Spec: MCPVault REST Backend - Phase 5

**Contract**: ./contract.md
**Estimated Effort**: S
**Phase kind**: Human gate. Requires a running Obsidian on the jcOS vault.

## Technical Approach

The build is finished by the end of phase 4. This phase proves the thing actually replaces what it is meant to replace, and then performs the replacement.

Parity is checked twice on purpose, because the two checks catch different failures. A mapping test asserts that each of the 13 `obsidian-jcos` tools has a MCPVault counterpart that is genuinely registered, which catches a rename or a missed registration at build time and keeps working forever. A live smoke script calls each counterpart against the real jcOS vault, which catches the case where a tool is registered and mapped but does not work against a real Obsidian and a real vault. The mapping test alone would pass on a server where every tool throws.

The cutover edits `~/.claude.json`, which is the user's global configuration and holds the only copy of the API key. It is backed up before any modification, and the new entry is verified working before the old one is deleted. Deleting first would lose the key.

## Feedback Strategy

**Inner-loop command**: `npm test -- src/backend/parity`

**Playground**: The parity mapping test for the mechanical half; the MCP Inspector against the live vault for the human half.

**Why this approach**: The mapping is pure data and belongs in the fast test loop. The live behavior cannot be checked any way except by calling it against a real Obsidian, which is why this phase is a gate rather than automation.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/backend/parity.ts` | The 13-entry mapping table, exported so both the test and the script consume one source |
| `src/backend/parity.test.ts` | Asserts every mapped target is registered in `ListTools` |
| `scripts/parity-smoke.ts` | Calls each counterpart against the live vault, exits non-zero on any failure |
| `scripts/backend-bench.ts` | Prints REST and filesystem timings for three representative operations |

### Modified Files

| File Path | Changes |
| --- | --- |
| `~/.claude.json` | Replace the `obsidian-jcos` entry with a MCPVault entry carrying the same five `OBSIDIAN_` values. Not in the repo; performed as a gate step. |
| `README.md` | Document the REST backend, the five env vars, the 27123 port trap, and the plugin version floor |

### Deleted Files

None in the repo.

## Implementation Details

### Parity mapping

**Overview**: One table, two consumers.

```typescript
export interface ParityMapping {
  python: string;      // obsidian-jcos tool name
  mcpvault: string;    // MCPVault tool name
  note?: string;       // how the call differs, when it does
}

export const PARITY_MAPPINGS: ParityMapping[] = [
  { python: "obsidian_list_files_in_vault",       mcpvault: "list_directory",           note: "path: \"\" for vault root" },
  { python: "obsidian_list_files_in_dir",         mcpvault: "list_directory" },
  { python: "obsidian_get_file_contents",         mcpvault: "read_note" },
  { python: "obsidian_batch_get_file_contents",   mcpvault: "read_multiple_notes" },
  { python: "obsidian_simple_search",             mcpvault: "search_notes" },
  { python: "obsidian_complex_search",            mcpvault: "search_vault_advanced",    note: "JsonLogic only; Dataview absent in this vault" },
  { python: "obsidian_patch_content",             mcpvault: "patch_note" },
  { python: "obsidian_append_content",            mcpvault: "write_note",               note: "mode: \"append\"" },
  { python: "obsidian_put_content",               mcpvault: "write_note",               note: "mode: \"overwrite\"" },
  { python: "obsidian_delete_file",               mcpvault: "delete_note",              note: "requires confirmPath" },
  { python: "obsidian_get_periodic_note",         mcpvault: "get_periodic_note",        note: "daily only" },
  { python: "obsidian_get_recent_periodic_notes", mcpvault: "get_recent_periodic_notes" },
  { python: "obsidian_get_recent_changes",        mcpvault: "get_recent_changes",       note: "filesystem-native; the Python version needs Dataview and returns 400 here" },
];
```

**Key decisions**:

- The test asserts each `mcpvault` value appears in the actual `ListTools` response from `createServer`, not in a hand-maintained list. A table compared against itself would agree while the tools were renamed out from under it. `src/createServer.test.ts` already shows the client pairing needed to fetch that response.
- The table is exported so `parity-smoke.ts` iterates the same 13 entries. One source, no drift between the mechanical check and the live check.
- Three entries carry notes because the call shape genuinely differs. Recording that in the table is what makes "parity" an honest claim rather than a name match.

**Feedback loop**:

- **Playground**: `src/backend/parity.test.ts` with the in-memory MCP client pair.
- **Experiment**: Assert all 13 targets are registered; assert the count is exactly 13; assert a deliberately corrupted entry fails, proving the check has teeth.
- **Check command**: `npm test -- src/backend/parity`

### Live smoke script

**Overview**: Exercises each counterpart against the real jcOS vault and reports a pass/fail table.

```bash
npx tsx scripts/parity-smoke.ts
```

**Key decisions**:

- **Exit code is the contract, not the printed text.** Exits 0 only when all 13 pass, non-zero otherwise. Screen-scraping for the word PASS is a human read, and success criterion 9 needs a mechanical result.
- All writes go to a single scratch note under a dedicated folder, and the script deletes it on the way out. No test touches an existing note.
- Refuses to run when `OBSIDIAN_API_KEY` is unset or `GET /` is unreachable, with a message saying to start Obsidian. A smoke run that silently exercised only the filesystem would prove nothing about the thing being retired.
- Prints the counterpart name and the note from the mapping table alongside each result, so a failure says which behavior differed.

**Feedback loop**:

- **Playground**: The script itself, run against the live vault.
- **Experiment**: Full run with Obsidian open, expecting 13 passes and exit 0. Then quit Obsidian and re-run, expecting the guard to refuse rather than to report false passes.
- **Check command**: `npx tsx scripts/parity-smoke.ts; echo "exit=$?"`

### Benchmark script

**Overview**: Prints REST and filesystem timings for `read_note`, `write_note`, and `list_directory`.

**Key decisions**:

- Informational only. Nothing asserts a threshold, and no CI job runs it. This repo already tuned a wall-clock assertion from 100ms to 200ms for CI stability and then deleted the test entirely, and CI here runs a three-version Node matrix on shared runners, so a timing gate would buy noise.
- Reports median over a modest run count rather than a single sample, since a single HTTPS round trip is dominated by connection setup.
- Its output is what informs the open question from phase 3 about whether a 60-second fingerprint TTL is the right trade.

### Cutover

**Overview**: Replace the `obsidian-jcos` entry with a MCPVault entry, carrying the credentials across before deleting anything.

```jsonc
"obsidian-jcos": {
  "command": "node",
  "args": [
    "/Users/johnchristopher/Developer/ai_assistant_tools/mcp-obsidian/main/dist/server.js",
    "/Users/johnchristopher/Obsidian/jcOS"
  ],
  "env": {
    "OBSIDIAN_API_KEY": "<carried over from the existing entry>",
    "OBSIDIAN_HOST": "127.0.0.1",
    "OBSIDIAN_PORT": "27123",
    "OBSIDIAN_PROTOCOL": "https",
    "OBSIDIAN_VERIFY_SSL": "false"
  }
}
```

**Key decisions**:

- **Back up `~/.claude.json` before touching it.** It is the user's global config for every project, and the `obsidian-jcos` env block is the only place the API key is stored.
- **Carry the five values across first, verify, then delete.** Deleting the old entry first loses the key.
- Keeping the server name `obsidian-jcos` means any saved prompts or skills referring to those tools keep resolving. The command behind the name changes; the name does not.
- `OBSIDIAN_PORT` is `27123`, which is this vault's HTTPS port. The insecure server is disabled and 27124 is not listening. Writing 27124 here would leave the server permanently in filesystem fallback with no error.
- The path depends on this worktree staying put. Record that as a known dependency in the README, since moving or deleting the checkout breaks the entry.

**Implementation steps**:

1. `cp ~/.claude.json ~/.claude.json.bak-$(date +%Y%m%d)`
2. `npm run build`
3. Run `npx tsx scripts/parity-smoke.ts` with Obsidian open; require exit 0
4. Add the new entry under a temporary name alongside the existing one
5. Restart the client and confirm 25 tools and one successful live REST call
6. Delete the original `obsidian-jcos` entry and rename the new one to take its place
7. Restart and confirm `grep -c obsidian-jcos ~/.claude.json` returns 1 pointing at the MCPVault build

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/parity.test.ts` | All 13 mapped targets registered; count is exactly 13 |

### Manual Testing

- [ ] Obsidian running on jcOS; `npx tsx scripts/parity-smoke.ts` exits 0 with 13 passes
- [ ] `npx tsx scripts/backend-bench.ts` prints both backends for all three operations
- [ ] MCP Inspector lists 25 tools
- [ ] `get_periodic_note` returns today's daily note through REST
- [ ] Quit Obsidian; `get_periodic_note` still resolves; `execute_command` fails with the named error
- [ ] Switch Obsidian to another vault, wait past the fingerprint TTL, attempt a write, confirm refusal
- [ ] `~/.claude.json` backed up before editing
- [ ] `grep -c obsidian-jcos ~/.claude.json` returns 1 and it points at `dist/server.js`
- [ ] A scheduled skill that writes to the vault runs successfully after cutover

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Smoke script run with Obsidian closed | Refuse to run, naming the missing dependency. Never report passes from the filesystem path. |
| A mapping fails the smoke run | Print which one and what differed; exit non-zero; do not proceed to cutover |
| New config entry does not start | Restore from the backup and investigate before deleting the old entry |
| Fingerprint mismatch warning after cutover | Obsidian is on a different vault than jcOS. Switch it back; REST re-enables on the next TTL expiry. |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Cutover | API key lost | Old entry deleted before the new one carries the value | REST silently disabled; server degrades to filesystem-only with no obvious cause | Back up first, carry values across, verify, then delete |
| Cutover | Wrong port written | Assuming the conventional 27124 | Permanent filesystem fallback with no error surfaced | 27123 stated explicitly here and in the README |
| Cutover | Worktree moved later | Checkout relocated or deleted | The MCP server fails to start for every session | Documented as a known dependency of the absolute-path approach |
| Smoke script | False pass from the filesystem | Script runs with REST unreachable and falls back | Retirement approved on evidence that proves nothing | Guard refuses to run unless `GET /` succeeds |
| Parity table | Agrees with itself | Test compares the table to a hardcoded list | Renamed or unregistered tools pass | Assert against the live `ListTools` response |

## Validation Commands

```bash
npm run build
npm test

npm test -- src/backend/parity
npx tsx scripts/parity-smoke.ts; echo "exit=$?"
npx tsx scripts/backend-bench.ts

# Cutover verification
grep -c obsidian-jcos ~/.claude.json    # 1, pointing at dist/server.js
grep -n mcpvault ~/.claude.json         # local dist path with five OBSIDIAN_ vars
ls ~/.claude.json.bak-*                 # backup exists
```

## Rollout Considerations

- **Rollback plan**: Restore `~/.claude.json` from the dated backup. The Python server is still installed via uvx and its pinned commit still resolves, so reverting is a config change with no reinstall.
- **Monitoring**: Watch stderr for fingerprint and version-floor warnings during the first days after cutover.
- **Deferred**: Once stable, `docs/superpowers/specs/2026-07-30-rest-backend-design.md` is superseded by this contract and can be marked as such rather than maintained in parallel.

## Open Items

- [ ] Decide whether to keep the `obsidian-jcos` server name permanently or rename it to `mcpvault-jcos`, which would require updating any skill that names the tools explicitly.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
