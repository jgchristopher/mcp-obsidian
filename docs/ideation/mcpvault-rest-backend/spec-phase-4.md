# Implementation Spec: MCPVault REST Backend - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Nine additive tools on a seam that phase 3 already proved. They split three ways by which backend can serve them, and that split determines where each one is wired rather than being a stylistic choice.

Two tools are **routed** and therefore join the `VaultBackend` interface: `get_periodic_note` and `get_document_map`. Extending the interface means the phase 3 contract suite grows to cover them, which is the point.

Two tools are **filesystem-native** and never touch the interface: `get_recent_changes` and `get_recent_periodic_notes`. Both are whole-vault derivations that REST could only serve as N calls returning the same answer, and both must keep working headless.

Five tools are **REST-only**: `list_commands`, `execute_command`, `get_active_file`, `open_file`, and `search_vault_advanced`. These deliberately do **not** go through `RoutingBackend`, because its `unsupported` branch falls back to the filesystem and there is nothing to fall back to. They are served by a separate `ObsidianLiveService` that requires a usable REST client and throws a named error when Obsidian is unreachable. Failing closed with a clear message is the correct behavior; silently degrading is not.

The periodic-note resolver carries the only security-relevant decision in the phase. It reads `.obsidian/daily-notes.json`, a directory `PathFilter` blocks by name at any depth. Rather than adding an allowlist mechanism to a deliberately closed boundary, the resolver reads that one file directly with a hardcoded relative path, bypassing `FileSystemService` entirely. `PathFilter` is not modified and its 51 tests are not touched, so no tool-facing path gains `.obsidian` access.

## Feedback Strategy

**Inner-loop command**: `npm test -- src/backend/periodic`

**Playground**: Vitest suite with a `mkdtemp` vault containing a synthetic `.obsidian/daily-notes.json`, plus the phase 2 fixture for the REST-backed tools.

**Why this approach**: The date resolver is the component that will take the most iterations and is pure logic over a config file and an injected date, so a scoped test runner is the fastest possible check.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/backend/periodic/config.ts` | Reads `.obsidian/daily-notes.json` directly, bypassing `PathFilter` |
| `src/backend/periodic/dateFormat.ts` | Single-pass `YYYY`/`MM`/`DD` resolver that throws on any other token |
| `src/backend/periodic/dateFormat.test.ts` | Token coverage and rejection cases |
| `src/backend/periodic/resolve.ts` | Config plus date into a vault-relative path |
| `src/backend/periodic/resolve.test.ts` | Nested-format resolution and derivation-from-config |
| `src/backend/live.ts` | `ObsidianLiveService` for the five REST-only tools |
| `src/backend/live.test.ts` | Each tool against the fixture, plus the unreachable error |
| `src/backend/documentMap.ts` | Heading, block-ref, and frontmatter-key extraction from note content |
| `src/backend/documentMap.test.ts` | Structure parsing edge cases |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/backend/types.ts` | Add `getPeriodicNote` and `getDocumentMap` to `VaultBackend` |
| `src/backend/filesystem/index.ts` | Implement both new interface members |
| `src/backend/rest/index.ts` | Implement both new interface members |
| `src/backend/contract.test.ts` | Extend coverage to the two new routed operations |
| `src/filesystem.ts` | Extract the existing vault walk from `getVaultStats` into a reusable scan supporting a `days` filter and a higher cap |
| `src/createServer.ts` | Register nine tools and route each to its correct service |

### Deleted Files

None.

## Implementation Details

### Daily-notes config reader

**Overview**: Reads exactly one file at a hardcoded path and returns its folder and format, or `null` when absent.

```typescript
export interface DailyNotesConfig {
  folder: string;   // e.g. "Daily_Notes"
  format: string;   // e.g. "YYYY/MM/YYYY-MM-DD"
}

/**
 * Reads <vaultPath>/.obsidian/daily-notes.json directly via fs/promises.
 * Deliberately does NOT go through FileSystemService or PathFilter:
 * .obsidian is a blocked segment and .json is not an allowed extension,
 * and widening either would open a boundary for every tool-facing path.
 */
export async function readDailyNotesConfig(vaultPath: string): Promise<DailyNotesConfig | null>;
```

**Key decisions**:

- The path is constructed from `vaultPath` and two literal segments. No caller-supplied component reaches it, so there is no traversal surface to guard.
- Missing file returns `null`, and the caller reports that periodic notes are unconfigured. Obsidian defaults to folder `""` and format `YYYY-MM-DD` when the file is absent; applying those defaults silently would resolve a plausible but wrong path, so an explicit `null` is safer.
- Read-only. Nothing in this project writes to `.obsidian`.
- Verified live for jcOS: `{"format": "YYYY/MM/YYYY-MM-DD", "folder": "Daily_Notes", "template": "templates/daily.md"}`. `template` is read but unused.

_No feedback loop: a single file read with two cases, covered by `resolve.test.ts`._

### Date format resolver

**Overview**: Substitutes `YYYY`, `MM`, and `DD` in a format string, throwing a named error on anything else.

```typescript
export class UnsupportedDateTokenError extends Error {
  constructor(readonly token: string, readonly format: string) {
    super(
      `Unsupported date token '${token}' in daily-notes format '${format}'. ` +
      `Only YYYY, MM, and DD are supported.`,
    );
  }
}

/** Single-pass scan. Alphabetic runs are tokens; everything else is a literal. */
export function formatDate(format: string, date: Date): string;
```

**Key decisions**:

- **Single-pass scan, not chained `replace` calls.** Sequential replacement is order-dependent and silently mangles overlapping tokens. A scanner that consumes alphabetic runs and rejects unknown ones is both correct and self-documenting.
- **Only three tokens.** Weekly and longer periods are out of scope because the `periodic-notes` plugin is absent, and the live format uses only these three. Implementing `dddd`, `Do`, `W`, or `Q` would be writing code no in-scope goal exercises.
- **Throw rather than pass through.** An unrecognized token means the resolved path is wrong. A loud failure naming the token beats silently reading or creating the wrong note.
- Separators are preserved verbatim, including `/`. That is what makes the nested `YYYY/MM/YYYY-MM-DD` layout work, and a resolver that assumed a flat folder would be wrong for this vault specifically.

**Implementation steps**:

1. Create `dateFormat.test.ts` with one smoke case: `formatDate("YYYY-MM-DD", new Date("2026-07-30"))` yields `2026-07-30`.
2. Implement the scanner.
3. Add rejection tests for `dddd`, `Do`, `W`, and `Q`.

**Feedback loop**:

- **Playground**: `src/backend/periodic/dateFormat.test.ts`.
- **Experiment**: `YYYY-MM-DD`, the nested `YYYY/MM/YYYY-MM-DD`, a single-digit month and day (`2026-01-05`, asserting zero-padding), a format that is entirely literal, and four unsupported tokens each asserting `UnsupportedDateTokenError`.
- **Check command**: `npm test -- src/backend/periodic/dateFormat`

### Periodic note resolution

```typescript
export async function resolvePeriodicPath(
  vaultPath: string,
  period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly",
  date: Date,
): Promise<string>;
```

**Key decisions**:

- Only `daily` resolves. The other four throw a named error explaining that the `periodic-notes` community plugin is not installed, which is accurate for this vault and actionable. The tool schema still accepts all five so the error is discoverable rather than a schema rejection.
- **The date is always injected, never read from the system clock inside the resolver.** A test asserting `Daily_Notes/2026/07/2026-07-30.md` against `new Date()` would pass on one day and fail forever after. The tool handler supplies `new Date()` when the caller omits a date; the resolver itself never calls it.
- The result is `join(folder, formatDate(format, date)) + ".md"` with forward slashes normalized to vault-relative form.

**Feedback loop**:

- **Playground**: `src/backend/periodic/resolve.test.ts` with a `mkdtemp` vault containing a synthetic `.obsidian/daily-notes.json`.
- **Experiment**: With jcOS's real config values and an injected `2026-07-30`, assert `Daily_Notes/2026/07/2026-07-30.md`. Then rewrite the fixture's config to `{"folder": "Journal", "format": "YYYY-MM-DD"}`, re-resolve the same date, and assert `Journal/2026-07-30.md`. That second assertion is what proves derivation rather than duplication, and it is the part success criterion 3 requires.
- **Check command**: `npm test -- src/backend/periodic`

### Document map

```typescript
export interface DocumentMap {
  headings: Array<{ path: string; level: number; line: number }>;  // path: "H1::H2"
  blockRefs: string[];
  frontmatterKeys: string[];
}

export function buildDocumentMap(content: string, frontmatter: Record<string, any>): DocumentMap;
```

**Key decisions**:

- Both backends call the same `buildDocumentMap` function over content they already hold. REST gets content from the note payload it already fetches, so routing costs one mapping rather than a second request; the filesystem gets it from the parsed note. The contract suite asserts identical output, which is trivially satisfied by sharing the implementation and is still worth asserting, because it locks the shared implementation in place.
- Heading paths use `::` separators, matching the `Target` header format the REST `PATCH` endpoint expects, so the output feeds structural patching directly.
- Fenced code blocks are skipped when scanning for headings. A `#` inside a code fence is not a heading, and daily notes routinely contain shell snippets.

**Feedback loop**:

- **Playground**: `src/backend/documentMap.test.ts`.
- **Experiment**: A note with nested headings three deep, a `#` inside a fenced code block, a block reference `^abc123`, duplicate sibling heading names, and a note with no headings at all.
- **Check command**: `npm test -- src/backend/documentMap`

### Filesystem-native tools

**Pattern to follow**: `src/filesystem.ts:1057` where `getVaultStats` already walks the vault and sorts by mtime for `recentlyModified`.

**Overview**: `get_recent_changes` and `get_recent_periodic_notes`, neither routed nor REST-dependent.

**Key decisions**:

- **Reuse the existing walk.** `getVaultStats` already produces exactly this data with a `recentCount` cap. Extract that walk into a shared private scan taking `limit` and an optional `days` window, then have both `getVaultStats` and `get_recent_changes` call it. Writing a second walker would mean two implementations of the same traversal drifting apart.
- `get_recent_changes` accepts `limit` (default 10, max 100) and `days` (default 90), matching the Python tool's parameters so the parity mapping is a genuine equivalence rather than an approximation.
- This tool is filesystem-native specifically because the Python implementation is a Dataview DQL query and Dataview is not installed here, so `obsidian_get_recent_changes` returns 400 today. The filesystem implementation needs no plugin and works headless.
- `get_recent_periodic_notes` resolves the last N periods through `resolvePeriodicPath` and reads each, skipping dates with no note rather than failing.

### ObsidianLiveService

**Overview**: The five tools with no filesystem equivalent, served directly from a REST client and never routed.

```typescript
export class ObsidianUnavailableError extends Error {
  constructor(tool: string) {
    super(
      `'${tool}' requires a running Obsidian with the Local REST API plugin. ` +
      `Obsidian is not reachable. Start Obsidian and retry.`,
    );
  }
}

export class ObsidianLiveService {
  listCommands(): Promise<Array<{ id: string; name: string }>>;   // GET  /commands/
  executeCommand(id: string): Promise<{ success: boolean }>;      // POST /commands/{id}/
  getActiveFile(): Promise<{ path: string }>;                     // GET  /active/
  openFile(path: string): Promise<{ success: boolean }>;          // POST /open/{path}
  searchVaultAdvanced(query: unknown): Promise<unknown[]>;        // POST /search/
}
```

**Key decisions**:

- **Not part of `VaultBackend`.** Routing these through `RoutingBackend` would hit its `unsupported` branch, which falls back to the filesystem, and there is no filesystem implementation to reach. Failing closed with `ObsidianUnavailableError` is the correct outcome.
- Constructed only when `resolveRestConfig()` returns non-null. With `OBSIDIAN_API_KEY` unset, the five tools are still registered but every call raises the named error, which is more discoverable than hiding them from `ListTools`.
- `searchVaultAdvanced` sends `Content-Type: application/vnd.olrapi.jsonlogic+json` **only**. Dataview DQL is out of scope: verified live, `POST /search/` with the DQL content type returns `400 errorCode 40012` because the Dataview plugin is not installed. The tool description must say JsonLogic and not mention Dataview.
- `execute_command` has the widest blast radius in the project, reaching every installed plugin. Its tool description states this plainly so the calling model treats it as consequential.

**Feedback loop**:

- **Playground**: `src/backend/live.test.ts` against the phase 2 fixture with `/commands/`, `/active/`, `/open/`, and `/search/` stubbed.
- **Experiment**: Each of the five against a healthy fixture, then each against a closed port asserting `ObsidianUnavailableError`. Plus `searchVaultAdvanced` with a well-formed JsonLogic body asserting the content type on the recorded request.
- **Check command**: `npm test -- src/backend/live`

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/periodic/dateFormat.test.ts` | Token substitution, zero-padding, unsupported-token rejection |
| `src/backend/periodic/resolve.test.ts` | Nested-format resolution and derivation from a changed config |
| `src/backend/documentMap.test.ts` | Heading nesting, code fences, block refs, empty notes |
| `src/backend/live.test.ts` | Five REST-only tools, healthy and unreachable |

**Key test cases**:

- Injected `2026-07-30` with jcOS's real config yields `Daily_Notes/2026/07/2026-07-30.md`
- Changing the fixture config's folder and format changes the resolved path
- `weekly` throws a named error citing the missing `periodic-notes` plugin
- `#` inside a fenced code block is not a heading
- `get_recent_changes` honors both `limit` and `days`
- Every REST-only tool raises `ObsidianUnavailableError` against a closed port

### Integration Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/contract.test.ts` | `getPeriodicNote` and `getDocumentMap` on both arms |
| `src/createServer.test.ts` | All nine tools registered and reachable; `ListTools` returns 25 |

### Manual Testing

- [ ] `get_periodic_note` with Obsidian open returns today's note
- [ ] Quit Obsidian; `get_periodic_note` still resolves, `execute_command` fails with the named error
- [ ] `list_commands` returns ids; `execute_command` runs a harmless one such as `app:open-vault`

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| `.obsidian/daily-notes.json` missing | Return `null`; the tool reports periodic notes are unconfigured rather than guessing defaults |
| Unsupported date token | Throw `UnsupportedDateTokenError` naming the token and the format |
| Non-daily period requested | Throw a named error citing the absent `periodic-notes` plugin |
| Resolved periodic note does not exist | Return the resolved path with an explicit `exists: false` rather than throwing; callers routinely want the path in order to create it |
| Any REST-only tool with Obsidian down | Throw `ObsidianUnavailableError` naming the tool |
| Dataview content type attempted | Not reachable; only the JsonLogic content type is ever sent |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Date resolver | Chained-replace corruption | Using sequential `String.replace` instead of a single pass | Wrong path resolved, possibly creating a duplicate note | Single-pass scanner; nested-format test |
| Date resolver | Test bound to the system clock | Asserting a fixed path against `new Date()` | Suite passes today and fails permanently tomorrow | Date is injected everywhere; the resolver never calls `new Date()` |
| Config reader | Boundary widened later | A future tool wants another `.obsidian` file | `PathFilter`'s closed boundary erodes one file at a time | Hardcoded single path, no allowlist parameter to extend |
| `get_recent_changes` | Second walker drifts from `getVaultStats` | Writing a fresh traversal instead of reusing the scan | Two tools disagree about the same vault | Extract and share one scan |
| `get_recent_changes` | Unbounded result on a large vault | `limit` omitted or very large | Oversized response consuming the model's context | Default 10, hard cap 100 |
| `ObsidianLiveService` | Silent degradation | Routed through `RoutingBackend` and hitting the `unsupported` fallback | Tool appears to succeed while doing nothing | Deliberately outside `VaultBackend`; explicit error type |
| `execute_command` | Destructive command invoked | The model picks a plugin command with side effects | Arbitrary vault or app mutation | Tool description states the blast radius; REST-only so it fails closed when Obsidian is shut |

## Validation Commands

```bash
npm run build

npm test -- src/backend/periodic
npm test -- src/backend/documentMap
npm test -- src/backend/live

# Both contract arms still run with the two new routed operations
npm test -- src/backend/contract --reporter=json

env -u OBSIDIAN_API_KEY npm test
```

## Rollout Considerations

- **Feature flag**: None beyond `OBSIDIAN_API_KEY`. The four non-REST-only tools work regardless.
- **Rollback plan**: Tools are additive; removing a registration removes the tool with no data impact.

## Open Items

- [ ] Confirm the `::` heading-path separator matches what the REST `PATCH` `Target` header expects for deeply nested headings, using the live vault during phase 5.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
