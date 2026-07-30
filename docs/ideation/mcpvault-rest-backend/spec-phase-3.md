# Implementation Spec: MCPVault REST Backend - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

This is the phase that can corrupt data if it is wrong. It joins the two backends from phases 1 and 2 behind a `RoutingBackend` that is itself a `VaultBackend`, so `createServer` receives it through the `backend` option added in phase 1 and no tool handler changes again.

Three mechanisms land here, and they are deliberately separate objects because they answer different questions. `RoutingBackend` decides which backend serves a call and what to do when REST fails. `Reachability` remembers whether REST answered recently, so a closed Obsidian does not cost a connection attempt per call. `VaultFingerprint` decides whether the REST backend is even talking about the same vault. Only the first is on the hot path for every call; the other two are consulted through a cheap timestamp check.

The fingerprint deserves emphasis because the obvious design does not work here. Revalidating after a connection failure sounds sufficient, but Obsidian is almost always open on this machine, so a failure-triggered check would run once at startup and never again. Someone switching vaults inside a running Obsidian would move the REST target while every check stays green. Revalidation is therefore time-based, on a TTL, independent of whether anything has failed.

The fingerprint comparison itself also cannot be naive. The plugin builds `/vault/` from `app.vault.getFiles()`, so it omits empty directories, while MCPVault's listing runs through `PathFilter`, which drops dotfiles and ignored directories at any depth. Comparing full listings would mismatch on a correctly configured machine and permanently disable REST. The comparison is narrowed to the sorted set of **root-level `.md` filenames**, which both sources report identically. Verified against the live vault: `GET /vault/` returns 28 root entries with no nested paths, 5 of them `.md`.

## Feedback Strategy

**Inner-loop command**: `npm test -- src/backend/routing`

**Playground**: Vitest suite driving `RoutingBackend` against a stub backend that throws each `BackendFailure` variant on demand, plus the phase 2 fixture server for end-to-end paths.

**Why this approach**: The routing policy is pure decision logic over failure kinds. A stub backend makes every branch reachable deterministically, which no amount of poking at a real Obsidian would achieve.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/backend/routing.ts` | `RoutingBackend`: REST-preferred routing and the fallback policy |
| `src/backend/routing.test.ts` | Every branch of the read/write asymmetry |
| `src/backend/health.ts` | `Reachability` flag and `VaultFingerprint` comparison |
| `src/backend/health.test.ts` | TTL revalidation, mismatch handling, inconclusive case |
| `src/backend/contract.test.ts` | Shared behavioral contract, run against both backends |
| `src/backend/testing/seed.ts` | Seeds a `mkdtemp` vault and a fixture with identical contents |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/createServer.ts` | Build a `RoutingBackend` when `resolveRestConfig()` returns non-null; otherwise keep the `FileSystemBackend` default from phase 1 |
| `server.ts` | Surface startup warnings for fingerprint mismatch and plugin version floor on stderr |

### Deleted Files

None.

## Implementation Details

### RoutingBackend

**Overview**: Implements `VaultBackend` by delegating to REST when it is usable and to the filesystem otherwise, applying a different fallback rule to reads than to writes.

```typescript
const READ_OPERATIONS = new Set([
  "readNote", "readMultipleNotes", "getNotesInfo",
  "listDirectory", "getFrontmatter", "listAllTags",
]);
// Everything else is a write: writeNote, patchNote, deleteNote,
// moveNote, moveFile, updateFrontmatter, manageTags.

export class RoutingBackend implements VaultBackend {
  readonly name = "rest" as const;

  constructor(
    private readonly rest: VaultBackend,
    private readonly filesystem: VaultBackend,
    private readonly health: Health,
  ) {}

  private async route<T>(op: string, call: (b: VaultBackend) => Promise<T>): Promise<T> {
    if (!(await this.health.restUsable())) return call(this.filesystem);

    try {
      return await call(this.rest);
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;

      const { failure } = e;
      if (failure.kind === "never-sent") {
        this.health.markUnreachable();
        return call(this.filesystem);          // safe for reads and writes
      }
      if (failure.kind === "unknown-state") {
        this.health.markUnreachable();
        if (READ_OPERATIONS.has(op)) return call(this.filesystem);
        throw new Error(
          `Write '${op}' failed with unknown state: Obsidian became unreachable ` +
          `after the request was sent. The change may or may not have been applied. ` +
          `Verify the note before retrying. Cause: ${failure.cause.message}`,
        );
      }
      if (failure.kind === "unsupported") return call(this.filesystem);
      throw e;
    }
  }
}
```

**Key decisions**:

- The read/write split is a static set, not a heuristic. Adding an operation to `VaultBackend` without classifying it should be a visible omission, so the default for an unlisted operation is **write**, the conservative side.
- An HTTP response never reaches this code. `RestClient` resolves on any status, so 404, 400, and 500 propagate as ordinary results or translated errors and never trigger fallback. A 404 is Obsidian saying the note does not exist, and a filesystem retry would be both redundant and, in a mismatched-vault scenario, actively wrong.
- The `unknown-state` write error is deliberately verbose and names the operation and the note. This message is the entire user-facing safety net for the duplicate-write hazard, so it must say what happened and what to check.
- Non-`BackendError` exceptions rethrow untouched. Only classified transport failures participate in fallback.

**Implementation steps**:

1. Create `routing.test.ts` with a stub backend whose every method rejects with a configurable `BackendFailure`, plus a recording filesystem stub.
2. Write one smoke test: a `never-sent` failure on `readNote` reaches the filesystem stub.
3. Implement `route` and wire all 13 operations through it.
4. Add a test per branch, including the assertion that the filesystem stub is **never called** for an `unknown-state` write.

**Feedback loop**:

- **Playground**: `src/backend/routing.test.ts` with the two stubs. No network, no filesystem.
- **Experiment**: The full matrix. For each of `never-sent`, `unknown-state`, and `unsupported`, times a representative read (`readNote`) and a representative write (`writeNote`), assert whether the filesystem stub was called and whether the call threw. Six cases, all deterministic.
- **Check command**: `npm test -- src/backend/routing`

### Reachability and fingerprint

**Overview**: One object answering "should REST serve the next call", combining a reachability flag with a time-bounded vault-identity check.

```typescript
export interface HealthOptions {
  /** How long a fingerprint check stays fresh. Default 60_000. */
  fingerprintTtlMs?: number;
  /** How long an unreachable mark suppresses REST attempts. Default 30_000. */
  unreachableTtlMs?: number;
  onWarn?: (message: string) => void;
}

export class Health {
  /** True only when REST is reachable AND the fingerprint is fresh and matching. */
  async restUsable(): Promise<boolean>;
  markUnreachable(): void;
}

/**
 * Sorted set of root-level .md filenames.
 * Chosen because the plugin omits empty directories (it builds /vault/ from
 * getFiles()) while PathFilter drops dotfiles, so full listings are not
 * comparable across the two sources.
 */
export async function fingerprintRest(client: RestClient): Promise<string[]>;
export async function fingerprintFilesystem(vaultPath: string): Promise<string[]>;
```

**Key decisions**:

- **Time-based revalidation, not failure-triggered.** With Obsidian almost always open, a failure-triggered check would effectively never fire after startup. `restUsable()` re-runs the fingerprint whenever the last check is older than the TTL, so a mid-session vault switch is caught within 60 seconds with no failure required.
- **An inconclusive comparison disables REST.** If both sides report zero root-level `.md` files there is no evidence the vaults match, so the guard fails safe rather than assuming agreement. Log the reason distinctly from a genuine mismatch, since the fix differs.
- **A mismatch is recoverable.** Disabling is not permanent; the next revalidation after the TTL can re-enable REST if the fingerprint matches again. Every call is gated on a fresh-enough check, so this stays safe while surviving a temporary vault switch.
- **A reachability flag, not a circuit breaker.** Obsidian closed means an immediate `ECONNREFUSED` on loopback, so there is nothing to protect against with half-open states or backoff curves. A boolean plus a timestamp is the whole mechanism.
- Fingerprint failures are themselves transport failures. If `GET /vault/` cannot be reached, that is `markUnreachable()`, not a mismatch.

**Implementation steps**:

1. Create `health.test.ts` with an injectable clock so TTL expiry is tested without sleeping.
2. Implement both fingerprint functions and assert they agree against a seeded pair.
3. Implement `Health.restUsable()` with the freshness check.
4. Test the mismatch path, the inconclusive path, and re-enablement after a matching revalidation.

**Feedback loop**:

- **Playground**: `src/backend/health.test.ts` with an injected clock and the phase 2 fixture.
- **Experiment**: Seed the filesystem vault and fixture identically and assert `restUsable()` is true. Then change the fixture's file set without any request failing, advance the clock past the TTL, and assert the next call reports unusable. Repeat with the clock advanced only halfway to confirm the stale result is reused. Cover the both-empty case explicitly.
- **Check command**: `npm test -- src/backend/health`

### Shared contract suite

**Overview**: One set of behavioral assertions executed against both backends, so divergence is a test failure rather than a production surprise.

```typescript
import { startFixture } from "./testing/fixture-server.js";
import { seedBoth } from "./testing/seed.js";

const BACKENDS = [
  { name: "filesystem", make: (env) => new FileSystemBackend(env.fileSystem) },
  { name: "rest",       make: (env) => new RestBackend(env.client) },
];

for (const backend of BACKENDS) {
  describe(`backend contract: ${backend.name}`, () => {
    // identical assertions, no conditional skips
  });
}
```

**Key decisions**:

- **Both arms always run.** The REST arm targets the phase 2 fixture, never a live Obsidian, so nothing is environment-gated. This is what makes success criterion 2 meaningful: a suite that skips the REST arm would exit 0 while proving nothing, which is precisely the failure the suite exists to prevent. There must be **no `skipIf` anywhere in this file.**
- `seedBoth` writes identical content into the `mkdtemp` vault and the fixture, so both arms start from the same state and assertions can be literally identical.
- Assertions cover observable behavior only: returned shapes, error conditions, and resulting vault state. They must not assert timing or internal call counts, which legitimately differ.
- `prepend` is asserted for its result, not its atomicity. REST implements it as read-then-write and the filesystem does not, which is a documented difference in outcome-equivalent behavior.

**Implementation steps**:

1. Write `src/backend/testing/seed.ts` exposing `seedBoth(files)`.
2. Write the contract describe block with one operation covered.
3. Confirm both arms run and both pass before adding the rest.
4. Fill in all 13 operations.
5. Verify with `--reporter=json` that skipped is zero and passed is non-zero for both arms.

**Feedback loop**:

- **Playground**: `src/backend/contract.test.ts` with `seedBoth`.
- **Experiment**: For each operation, the same inputs against both arms with deep-equality assertions on results, plus a vault-state assertion after every write. Include a missing note, a nested path that must be created, a delete with a mismatched `confirmPath`, and a move onto an existing destination.
- **Check command**: `npm test -- src/backend/contract`

### Wiring in createServer

```typescript
const config = resolveRestConfig();
const backend = options.backend ?? (config
  ? new RoutingBackend(
      new RestBackend(new RestClient(config)),
      new FileSystemBackend(fileSystem),
      new Health(config, resolvedVaultPath, { onWarn: (m) => console.error(m) }),
    )
  : new FileSystemBackend(fileSystem));
```

**Key decisions**:

- With `OBSIDIAN_API_KEY` unset, `resolveRestConfig()` returns `null` and construction is byte-identical to phase 1. This is what makes success criterion 6 hold.
- Warnings go to `stderr`, never `stdout`, which carries the MCP protocol stream on stdio transport. Writing a warning to `stdout` would corrupt the session.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/routing.test.ts` | The six-case failure matrix, plus non-`BackendError` passthrough |
| `src/backend/health.test.ts` | TTL freshness, mismatch, inconclusive, re-enablement, transport failure during fingerprint |

**Key test cases**:

- `unknown-state` on `writeNote` throws and the filesystem stub records zero calls
- `unknown-state` on `readNote` falls back and returns the filesystem result
- `never-sent` falls back for both a read and a write
- A 500 response propagates without any fallback
- Fingerprint mismatch with no transport failure makes the next write refuse REST
- Both sides reporting zero root `.md` files disables REST

### Integration Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/contract.test.ts` | All 13 routed operations, both arms, no skips |
| `src/createServer.test.ts` | Server construction with and without `OBSIDIAN_API_KEY` |

### Manual Testing

- [ ] Start against jcOS with Obsidian open; confirm no warnings and reads served by REST
- [ ] Switch Obsidian to a different vault, wait past the TTL, attempt a write, confirm refusal and warning
- [ ] Quit Obsidian entirely, confirm reads and writes continue against the filesystem

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| REST unreachable | Mark unreachable, serve from filesystem, suppress attempts for the unreachable TTL |
| Unknown-state write | Throw a message naming the operation, the note, and that the state is unverified. Never fall back. |
| Fingerprint mismatch | Disable REST, warn on stderr naming both vaults, serve from filesystem, retry on the next TTL expiry |
| Fingerprint inconclusive | Disable REST with a distinct message; the remedy differs from a mismatch |
| Fingerprint request fails | Treat as unreachable, not as mismatch |
| Plugin below 4.1.7 | Warn once on stderr, continue |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| `RoutingBackend` | Duplicate write | An `unknown-state` failure treated as fallback-eligible | An `append` silently doubles content in a real note | Static read set with write as the default; explicit test asserting zero filesystem calls |
| `RoutingBackend` | New operation defaults wrong | An operation added to `VaultBackend` and omitted from `READ_OPERATIONS` | Treated as a write, so a read loses fallback | Conservative default; contract suite covers every interface member |
| `Health` | Guard never fires | Revalidation tied to failure recovery on an always-open Obsidian | Mid-session vault switch goes undetected, writes land in the wrong vault | Time-based TTL revalidation, independent of failures |
| `Health` | False mismatch | Comparing full listings across sources that normalize differently | REST permanently disabled on a correct machine, silently degrading to filesystem-only | Compare only root-level `.md` filenames; assert agreement on a seeded pair |
| `Health` | Stale-window write | Vault switched immediately after a passing check | Up to one TTL of writes reach the wrong vault | Accepted risk, bounded to 60s and documented; shortening the TTL trades requests for exposure |
| Contract suite | Green with one arm skipped | REST arm gated on an env var | The suite's entire purpose is defeated while CI reports success | Fixture-backed, no `skipIf` in the file, criterion asserts zero skipped |

## Validation Commands

```bash
npm run build

npm test -- src/backend/routing
npm test -- src/backend/health

# Both arms must run: non-zero passed, zero skipped
npm test -- src/backend/contract --reporter=json

# Unchanged behavior with REST off
env -u OBSIDIAN_API_KEY npm test
git diff --stat main -- 'src/**/*.test.ts'
```

## Rollout Considerations

- **Feature flag**: `OBSIDIAN_API_KEY`. Unsetting it reverts to filesystem-only at the next server start with no code change.
- **Monitoring**: stderr warnings are the only signal. Check them after the phase 5 cutover.
- **Rollback plan**: Unset `OBSIDIAN_API_KEY` in the MCP config. No data migration, since both backends operate on the same vault.

## Open Items

- [ ] Confirm 60s is the right fingerprint TTL after the phase 5 benchmark shows what an extra `GET /vault/` costs.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
