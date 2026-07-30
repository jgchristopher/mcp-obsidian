# Implementation Spec: MCPVault REST Backend - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Insert a `VaultBackend` interface between the tool handlers in `createServer.ts` and `FileSystemService`, then implement that interface once, as an adapter over the service that already exists. No REST code lands in this phase and no observable behavior changes. The phase exists so that phases 2 and 3 have a seam to plug into.

The interface covers exactly the 13 routed operations from the contract. It deliberately does **not** cover `search_notes`, `get_vault_stats`, or `wiki_link`, which stay wired directly to `SearchService`, `FileSystemService`, and `handleWikiLinkTool` as they are today. Keeping non-routed tools out of the interface means the contract suite in phase 3 has nothing to prove about them, and the interface stays small enough to implement twice.

`FileSystemBackend` is an adapter, not a rewrite. Every method delegates to the existing `FileSystemService` instance and returns its result unchanged. The 110 tests in `filesystem.test.ts` construct `FileSystemService` directly and must keep passing untouched, which is the regression check that the adapter is transparent.

The `BackendFailure` taxonomy is capped at three variants because routing switches on exactly three cases. Adding a fourth variant is only allowed alongside the routing branch that reads it, otherwise the taxonomy accumulates members nothing consumes.

## Feedback Strategy

**Inner-loop command**: `npm test -- src/backend`

**Playground**: Vitest suite. Create `src/backend/filesystem/index.test.ts` with a `describe` block and one smoke test asserting `readNote` round-trips before writing the adapter.

**Why this approach**: Everything in this phase is a data/logic layer with no network and no UI, so a scoped test runner is the tightest available loop and runs in well under a second.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/backend/types.ts` | `VaultBackend` interface, `BackendFailure` union, `BackendError` class |
| `src/backend/filesystem/index.ts` | `FileSystemBackend` adapter over `FileSystemService` |
| `src/backend/filesystem/index.test.ts` | Adapter tests proving delegation is transparent |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/createServer.ts` | Construct a `FileSystemBackend` and route the 13 backend-covered cases through it. Leave `search_notes`, `get_vault_stats`, and `wiki_link` calling their services directly. Add an optional `backend` field to `CreateServerOptions` so phase 3 can inject a router without touching handlers again. |
| `src/createServer.test.ts` | Add handler-level tests through the MCP client for each routed operation. See the coverage note below. |

### Deleted Files

None.

## Implementation Details

### VaultBackend interface and failure taxonomy

**Overview**: One interface describing the routed operations, plus the three-way failure classification that phase 3's routing policy switches on.

```typescript
import type {
  ParsedNote, NoteWriteParams, PatchNoteParams, PatchNoteResult,
  DeleteNoteParams, DeleteResult, DirectoryListing, MoveNoteParams,
  MoveFileParams, MoveResult, BatchReadParams, BatchReadResult,
  UpdateFrontmatterParams, NoteInfo, TagManagementParams, TagManagementResult,
} from "../types.js";

export type BackendFailure =
  /** Request provably never reached Obsidian. Safe to fall back for any operation. */
  | { kind: "never-sent"; cause: Error }
  /** Request may have been received and applied. Reads may fall back; writes must not. */
  | { kind: "unknown-state"; cause: Error }
  /** This backend cannot serve this operation at all. */
  | { kind: "unsupported"; operation: string };

export class BackendError extends Error {
  constructor(readonly failure: BackendFailure, message: string) {
    super(message);
    this.name = "BackendError";
  }
}

export interface VaultBackend {
  readonly name: "filesystem" | "rest";

  readNote(path: string): Promise<ParsedNote>;
  readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
  getNotesInfo(paths: string[]): Promise<NoteInfo[]>;

  writeNote(params: NoteWriteParams): Promise<{ success: boolean; path: string; message: string }>;
  patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
  deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;

  moveNote(params: MoveNoteParams): Promise<MoveResult>;
  moveFile(params: MoveFileParams): Promise<MoveResult>;

  listDirectory(path: string): Promise<DirectoryListing>;

  getFrontmatter(path: string): Promise<Record<string, any>>;
  updateFrontmatter(params: UpdateFrontmatterParams): Promise<{ success: boolean; path: string; message: string }>;

  manageTags(params: TagManagementParams): Promise<TagManagementResult>;
  listAllTags(): Promise<Array<{ name: string; count: number }>>;
}
```

**Key decisions**:

- Reuse the existing types in `src/types.ts` verbatim rather than defining backend-specific shapes. The contract suite in phase 3 asserts both backends return the same shapes, which is only meaningful if the shapes are shared.
- `name` is a literal union rather than a string so routing code and test assertions can discriminate without magic values.
- `unsupported` exists so phase 4's REST-only tools have a defined failure rather than throwing a bare `Error`.

**Implementation steps**:

1. Create `src/backend/types.ts` with the union, error class, and interface above.
2. Confirm every referenced type is exported from `src/types.ts` (all 16 are).
3. Run `npm run build` to confirm the types compile before any implementation exists.

_No feedback loop: this is a type-only file, covered by typecheck._

### FileSystemBackend adapter

**Pattern to follow**: `src/createServer.ts:26-28` for how services are currently constructed and injected.

**Overview**: Implements `VaultBackend` by delegating every call to an injected `FileSystemService`. Contains no logic of its own.

```typescript
export class FileSystemBackend implements VaultBackend {
  readonly name = "filesystem" as const;

  constructor(private readonly fileSystem: FileSystemService) {}

  readNote(path: string) {
    return this.fileSystem.readNote(path);
  }

  listAllTags() {
    return this.fileSystem.listAllTags();
  }
  // ...one delegating method per interface member
}
```

**Key decisions**:

- Takes a constructed `FileSystemService` rather than a vault path, so `createServer` keeps owning service construction and the adapter stays trivially testable.
- No error translation. Filesystem errors propagate exactly as they do today, which is what keeps behavior unchanged. `BackendFailure` is only produced by the REST backend in phase 2.
- Method names mirror the interface, not the service, so any signature drift in `FileSystemService` surfaces as a compile error here rather than at a call site.

**Implementation steps**:

1. Create `src/backend/filesystem/index.test.ts` with the standard `mkdtemp` setup block copied from `src/filesystem.test.ts:8-22`, using prefix `mcpvault-backend-`.
2. Write one smoke test: write a note through the adapter, read it back, assert content round-trips.
3. Implement `FileSystemBackend` with one delegating method per interface member.
4. Add a test per operation asserting the adapter returns exactly what the underlying service returns for the same input.

**Feedback loop**:

- **Playground**: `src/backend/filesystem/index.test.ts` against a `mkdtemp` vault, matching the existing suite's pattern.
- **Experiment**: For each operation, call it through both `FileSystemBackend` and the raw `FileSystemService` with identical inputs and assert deep equality. Cover a note with frontmatter, a note without, a missing path, and a path outside the vault.
- **Check command**: `npm test -- src/backend/filesystem`

### Handler rewiring in createServer

**Pattern to follow**: the existing `switch` at `src/createServer.ts:263-431`.

**Overview**: The 13 routed cases call `backend.*` instead of `fileSystem.*`. Three cases are left alone.

```typescript
export interface CreateServerOptions {
  name?: string;
  version?: string;
  pathFilter?: PathFilter;
  frontmatterHandler?: FrontmatterHandler;
  /** Injected in phase 3. Defaults to FileSystemBackend. */
  backend?: VaultBackend;
}

const fileSystem = new FileSystemService(resolvedVaultPath, pathFilter, frontmatterHandler);
const backend = options.backend ?? new FileSystemBackend(fileSystem);
```

**Key decisions**:

- The `backend` option defaults to the filesystem adapter, so every existing caller including `server.ts` keeps working with no change.
- `fileSystem` stays in scope because `get_vault_stats` still uses it directly. Do not remove it.
- Routed cases: `read_note`, `write_note`, `patch_note`, `list_directory`, `delete_note`, `move_note`, `move_file`, `read_multiple_notes`, `update_frontmatter`, `get_notes_info`, `get_frontmatter`, `manage_tags`, `list_all_tags`. Unrouted: `search_notes`, `get_vault_stats`, `wiki_link`.

**Implementation steps**:

1. Add the `backend` option and the default construction.
2. Rewrite the 13 cases to call `backend.*`. Argument shapes are unchanged.
3. Leave the 3 unrouted cases untouched.
4. Run the full suite and confirm nothing regressed.

**Feedback loop**:

- **Playground**: `src/createServer.test.ts`, which already pairs an MCP `Client` with the server over `InMemoryTransport.createLinkedPair()` (`src/createServer.test.ts:6-7,32`).
- **Experiment**: Call each of the 13 routed tools through the MCP client against a `mkdtemp` vault. Assert the response payload for a happy path, a missing-file path, and a path-traversal attempt per operation.
- **Check command**: `npm test -- src/createServer`

## Coverage note

The phase note in the contract flags this and the spec must not soften it: **the existing suite is a weak regression check for this rewiring.** Of 245 tests, only the 10 in `createServer.test.ts` and 5 in `integration.test.ts` exercise the handler layer at all. The 110 filesystem tests construct `FileSystemService` directly and never touch `createServer`, so they would keep passing even if a handler were wired to the wrong backend method.

That is why adding handler-level tests for all 13 routed operations is a deliverable of this phase, not an optional extra. Without them, phase 3 has no way to tell a routing bug from a handler bug.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/filesystem/index.test.ts` | Adapter delegates transparently for all 13 operations |

**Key test cases**:

- Read a note with frontmatter, without frontmatter, and one that does not exist
- Write in each of `overwrite`, `append`, and `prepend` modes
- Patch with a single match, multiple matches and `replaceAll: false` (must fail), and `replaceAll: true`
- Delete with a matching `confirmPath` and a mismatched one
- Move where the destination exists and `overwrite` is false
- `listAllTags` on an empty vault returns an empty array rather than throwing

### Integration Tests

| Test File | Coverage |
| --- | --- |
| `src/createServer.test.ts` | All 13 routed tools reachable and correct through the MCP client |

**Key scenarios**:

- Each routed tool returns a well-formed MCP response for a valid input
- A path outside the vault is rejected identically to today for every routed tool
- `search_notes`, `get_vault_stats`, and `wiki_link` behave exactly as before

### Manual Testing

- [ ] `npx @modelcontextprotocol/inspector npm start ~/Obsidian/jcOS` lists 16 tools, unchanged
- [ ] Read and write a scratch note through the inspector and confirm the file on disk

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| `FileSystemService` throws (missing file, denied path) | Propagate unchanged. The adapter adds no translation, which is what preserves current behavior. |
| An interface method has no service equivalent | Compile error. Every method must map to an existing service method in this phase. |
| A caller passes `backend: undefined` explicitly | `??` falls through to the default `FileSystemBackend`, same as omitting it. |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| `FileSystemBackend` | Silent argument reordering | Adapter method passes params in a different order than the service expects | Wrong file read or written, tests may still pass if params share a type | Delegate with named-object params wherever the service accepts them; deep-equality tests against the raw service |
| Handler rewiring | A case left pointing at `fileSystem` | Manual edit across 13 cases | That tool never routes in phase 3 and silently stays filesystem-only forever | Handler-level test per routed operation; phase 3 contract suite would not catch this |
| Handler rewiring | An unrouted case wired to the backend by mistake | `search_notes` looks routable | Result sets change when Obsidian is open, the exact outcome the contract excludes | Assert in `createServer.test.ts` that the backend is never consulted for the 3 unrouted tools, using a spy backend |

## Validation Commands

```bash
# Type checking (build is the typecheck in this repo)
npm run build

# Scoped unit tests
npm test -- src/backend

# Handler-level tests
npm test -- src/createServer

# Full suite: must pass with zero edits to pre-existing test files
npm test
git diff --stat main -- 'src/**/*.test.ts'
```

## Rollout Considerations

- **Feature flag**: None. This phase is behaviorally inert.
- **Rollback plan**: The commit is self-contained; reverting it restores direct service calls with no data migration.

## Open Items

None. All interface members map to existing `FileSystemService` methods.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
