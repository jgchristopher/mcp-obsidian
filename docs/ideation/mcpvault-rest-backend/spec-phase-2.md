# Implementation Spec: MCPVault REST Backend - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Build the REST half of the seam: an HTTP client, a `VaultBackend` implementation over the Local REST API, and the in-repo fixture server that lets both of them be tested in CI. Routing is explicitly **not** in this phase. `RestBackend` is constructed and exercised directly by tests here; nothing chooses between it and the filesystem until phase 3.

The client is built on `node:https`, not `fetch`. Node's global `fetch` ignores an `https.Agent`, so there is no way to scope `rejectUnauthorized: false` to this client through it, and the alternative (an undici `dispatcher`) means adding a runtime dependency to a package whose entire dependency list is four entries. `node:https` gives full agent control with nothing new installed.

The most consequential code in this phase is the error classifier. It decides whether a failure is `never-sent` or `unknown-state`, and phase 3's write-safety rule is only as correct as that decision. The rule is mechanical: if the request bytes were never written to the socket, it is `never-sent`; once the request has been flushed, any failure is `unknown-state`, because Obsidian may have applied the change before the connection died. Track this with a flag set on the request's `finish` event rather than by inspecting error codes alone, since `ETIMEDOUT` can occur on either side of that line.

The fixture server exists because the repo has no HTTP client, no mocking library, and no `vi.mock` usage anywhere, while CI runs on ubuntu with no Obsidian installed. Without it the REST arm of phase 3's contract suite cannot execute at all.

## Feedback Strategy

**Inner-loop command**: `npm test -- src/backend/rest`

**Playground**: Vitest suite driving `RestBackend` against the in-process `node:http` fixture server. Stand the fixture up in `beforeEach` on an ephemeral port before writing any client code.

**Why this approach**: The whole phase is network I/O against a server we control. An in-process fixture gives deterministic status codes, injectable socket failures, and no dependency on a running Obsidian, so the loop stays under a second and works identically on CI.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/backend/rest/client.ts` | `RestClient`: `node:https` transport, auth header, scoped agent, error classification |
| `src/backend/rest/client.test.ts` | Classification tests for every failure shape |
| `src/backend/rest/index.ts` | `RestBackend`: `VaultBackend` mapped onto REST endpoints |
| `src/backend/rest/index.test.ts` | Per-operation tests against the fixture |
| `src/backend/rest/config.ts` | Env var parsing, defaults, and the plugin version floor check |
| `src/backend/rest/config.test.ts` | Default and override resolution, including the 27123 trap |
| `src/backend/testing/fixture-server.ts` | In-process `node:http` stand-in for the Local REST API |
| `src/backend/testing/fixture-server.test.ts` | Self-test that the fixture behaves as claimed |

### Modified Files

| File Path | Changes |
| --- | --- |
| `AGENTS.md` | Document the new env vars, the plugin version floor, and the conditional-skip idiom introduced for live tests |

### Deleted Files

None.

## Implementation Details

### Configuration

**Overview**: Resolves five environment variables into a validated config, or returns `null` when REST is disabled.

```typescript
export interface RestConfig {
  apiKey: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  verifySsl: boolean;
}

/** Returns null when OBSIDIAN_API_KEY is unset, which disables REST entirely. */
export function resolveRestConfig(env = process.env): RestConfig | null;
```

| Variable | Default | Notes |
| --- | --- | --- |
| `OBSIDIAN_API_KEY` | unset | Unset returns `null`; REST never activates and behavior matches today exactly |
| `OBSIDIAN_HOST` | `127.0.0.1` | |
| `OBSIDIAN_PORT` | `27123` | See the trap below |
| `OBSIDIAN_PROTOCOL` | `https` | |
| `OBSIDIAN_VERIFY_SSL` | `false` | Plugin ships a self-signed certificate |

**Key decisions**:

- The port default is `27123`, not the `27124` most documentation implies. Verified from this vault's plugin config (`.obsidian/plugins/obsidian-local-rest-api/data.json`): `port: 27123`, `insecurePort: 27124`, `enableInsecureServer: false`, `enableSecureServer: true`. HTTPS listens on 27123 here and the insecure server is off, so a `27124` default would fail every connection and silently pin the server to permanent filesystem fallback. That failure is invisible without this note, which is why it is a spec-level decision rather than a constant.
- Names mirror the Python server exactly so migrating the `obsidian-jcos` entry in phase 5 is copy-paste.
- A malformed `OBSIDIAN_PORT` throws at startup rather than defaulting. A typo should stop the server, not silently disable REST.
- Record a plugin version floor of **>= 4.1.7**, checked against `manifest.version` from `GET /`. BRAT is installed in this vault, so plugin versions move without warning. On a lower version, log a warning and continue rather than refusing to start.

_No feedback loop: config parsing is covered by its own unit tests and typecheck._

### RestClient

**Overview**: One request method, one agent, and the error classifier everything downstream depends on.

```typescript
import { Agent, request } from "node:https";

export class RestClient {
  private readonly agent: Agent;

  constructor(private readonly config: RestConfig) {
    this.agent = new Agent({
      rejectUnauthorized: config.verifySsl,
      keepAlive: true,
    });
  }

  async send(opts: {
    method: string;              // includes the WebDAV verb "MOVE"
    path: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;          // default 5000
  }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}
```

**Key decisions**:

- `rejectUnauthorized` is set on this agent only. `NODE_TLS_REJECT_UNAUTHORIZED` must never be touched, because it disables certificate validation for every outbound request in the process. Success criterion 8 greps for both the absence of the env var and the presence of `rejectUnauthorized` confined to this constructor.
- Classification hinges on a `requestSent` flag set in the request's `finish` handler:

```typescript
let requestSent = false;
req.on("finish", () => { requestSent = true; });

req.on("error", (cause) => {
  reject(new BackendError(
    requestSent ? { kind: "unknown-state", cause } : { kind: "never-sent", cause },
    `REST request failed: ${cause.message}`,
  ));
});
```

  `ECONNREFUSED` and DNS failures fire before `finish`, so they classify as `never-sent`. A timeout after the body was flushed classifies as `unknown-state`. Do not classify on `error.code` alone: `ETIMEDOUT` legitimately occurs on both sides of the send boundary and phase 3's write-safety rule depends on telling them apart.
- Any HTTP response, including 404, 400, and 500, resolves rather than rejects. A status code is an authoritative answer from Obsidian, and only a rejection triggers fallback.
- `MOVE` is passed through as a plain method string. `node:https` does not validate verbs, so the WebDAV-style operation needs no special handling.

**Implementation steps**:

1. Write `src/backend/testing/fixture-server.ts` first (see below) so the client has something to talk to.
2. Create `client.test.ts` with a fixture on an ephemeral port and one smoke test asserting a 200 round-trips.
3. Implement `send` with the agent, auth header, and timeout.
4. Add the `requestSent` flag and the classifier.
5. Add a test per failure shape.

**Feedback loop**:

- **Playground**: `src/backend/rest/client.test.ts` with the fixture server bound to port 0 in `beforeEach` and closed in `afterEach`.
- **Experiment**: Drive each branch deterministically — a 200, a 404, a 500, a connection to a closed port (`never-sent`), a fixture that destroys the socket before responding (`unknown-state`), and a fixture that accepts the request then never replies (timeout, `unknown-state`).
- **Check command**: `npm test -- src/backend/rest/client`

### Fixture server

**Overview**: A `node:http` server that mimics the Local REST API well enough to exercise `RestBackend`, plus hooks for injecting the failures a real server will not produce on demand.

```typescript
export interface FixtureOptions {
  /** Seeded vault contents, path -> file body. */
  files?: Record<string, string>;
  /** Force a status for the next request to a matching path. */
  failWith?: { path: string; status: number };
  /** Simulate a socket death after the request is received but before a reply. */
  killSocketOn?: string;
  /** Accept the request and never respond, to exercise post-send timeouts. */
  hangOn?: string;
}

export function startFixture(opts?: FixtureOptions): Promise<{
  port: number;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
}>;
```

**Key decisions**:

- Plain `node:http`, not `https`. Tests set `protocol: "http"` in the config, which exercises the same code path minus TLS. TLS itself is covered by the grep-based criterion and one live smoke in phase 5, not by generating certificates in unit tests.
- Records every request so tests can assert the client sent the right verb, path, and headers, which is how `MOVE` with a `Destination` header gets verified without a real Obsidian.
- Implements only the endpoints `RestBackend` calls. It is a test double, not a reimplementation of the plugin.
- Lives under `src/backend/testing/` and is therefore compiled into `dist/`. That is acceptable: the package ships `dist/**/*` wholesale today and the fixture has no runtime dependencies. Do not import it from any production path.

**Implementation steps**:

1. Implement request recording and static file serving from the seeded `files` map.
2. Implement `GET /vault/`, `GET /vault/{path}`, `PUT`, `POST`, `PATCH`, `DELETE`, `MOVE`, and `GET /tags/`.
3. Add the three failure injectors.
4. Write `fixture-server.test.ts` proving each injector produces the intended client-side symptom.

**Feedback loop**:

- **Playground**: `src/backend/testing/fixture-server.test.ts`, driven with raw `node:https`/`node:http` requests so it is validated independently of `RestClient`.
- **Experiment**: Seed two files, assert `GET /vault/` lists both; assert `failWith` returns the given status; assert `killSocketOn` produces a socket error client-side; assert `hangOn` produces no response within 200ms.
- **Check command**: `npm test -- src/backend/testing`

### RestBackend

**Overview**: Implements `VaultBackend` by mapping each routed operation onto a REST endpoint.

| Operation | Request |
| --- | --- |
| `readNote` | `GET /vault/{path}` with `Accept: application/vnd.olrapi.note+json` |
| `readMultipleNotes` | N concurrent `readNote` calls, partial failures collected into `failed` |
| `getNotesInfo` | N concurrent reads, projecting `stat` from the note payload |
| `writeNote` | `PUT /vault/{path}` for overwrite, `POST` for append |
| `patchNote` | `PATCH /vault/{path}` with `Operation`, `Target-Type`, `Target` headers |
| `deleteNote` | `DELETE /vault/{path}` |
| `moveNote` / `moveFile` | `MOVE /vault/{path}` with a `Destination` header |
| `listDirectory` | `GET /vault/{dir}/` |
| `getFrontmatter` | `GET /vault/{path}`, projecting `frontmatter` |
| `updateFrontmatter` | `PATCH` with `Target-Type: frontmatter` |
| `manageTags` | Read, modify, write back through the same note endpoint |
| `listAllTags` | `GET /tags/` |

**Key decisions**:

- `readNote` uses the `vnd.olrapi.note+json` accept header, which returns `content`, `frontmatter`, `tags`, `stat`, `links`, and `backlinks` in one response. Verified live. This is why `readNote`, `getFrontmatter`, and `getNotesInfo` all cost one request rather than three round-trips plus local parsing.
- `prepend` mode has no REST equivalent. Implement it as read-then-`PUT`, and accept that it is not atomic. Note this in the failure modes table rather than hiding it.
- Non-ASCII paths must be percent-encoded, and the `Destination` header for `MOVE` percent-encoded separately. The OpenAPI spec calls this out explicitly for both.
- `listAllTags` maps `GET /tags/`, which returns `{name, count}` objects backed by Obsidian's own index. Verified live. This is a genuine single-call win over the filesystem walk, which is why the tool routes rather than staying filesystem-only.
- Every method translates a non-2xx response into the same error shape `FileSystemService` produces for the equivalent condition. Phase 3's contract suite asserts this, so divergence here surfaces as a test failure there.

**Implementation steps**:

1. Create `index.test.ts` with a fixture seeded with two notes and one smoke test through `readNote`.
2. Implement the single-path operations: read, write, patch, delete, list.
3. Implement `MOVE`, asserting via the fixture's request log that the `Destination` header is present and encoded.
4. Implement the batch operations on top of `readNote` with `Promise.allSettled`, matching the existing partial-result convention in `BatchReadResult`.
5. Implement `listAllTags` and `manageTags`.

**Feedback loop**:

- **Playground**: `src/backend/rest/index.test.ts` against a seeded fixture.
- **Experiment**: Per operation, one happy path plus its failure status. Specifically: read a missing note (404), write to a nested path that does not exist yet, patch targeting a heading that is absent (400), move onto an existing destination (409), and a batch read of three paths where the middle one is missing.
- **Check command**: `npm test -- src/backend/rest`

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/rest/config.test.ts` | Defaults, overrides, `null` when the key is unset, throw on a malformed port |
| `src/backend/rest/client.test.ts` | Every classification branch, timeout handling, auth header, agent scoping |
| `src/backend/testing/fixture-server.test.ts` | Each failure injector produces its intended symptom |
| `src/backend/rest/index.test.ts` | All 13 routed operations against the fixture |

**Key test cases**:

- `resolveRestConfig({})` returns `null`
- Port defaults to `27123`, not `27124`
- `ECONNREFUSED` against a closed port classifies `never-sent`
- Socket destroyed after send classifies `unknown-state`
- No response within the timeout, after send, classifies `unknown-state`
- 404, 400, and 500 all resolve rather than reject
- `MOVE` sends a percent-encoded `Destination` header
- `readMultipleNotes` with one missing path returns two successes and one failure

### Integration Tests

| Test File | Coverage |
| --- | --- |
| `src/backend/rest/live.test.ts` | Optional smoke against a real Obsidian |

Guarded with `describe.skipIf(!process.env.OBSIDIAN_API_KEY)`. This introduces the repo's first conditional-skip idiom; document it in `AGENTS.md`. These tests are a convenience, never a substitute for the fixture-backed suite, because phase 3's criterion requires zero skipped tests in the contract arms.

### Manual Testing

- [ ] With Obsidian running, `OBSIDIAN_API_KEY=… npm test -- src/backend/rest/live` passes
- [ ] Confirm `GET /` reports `manifest.version` >= 4.1.7

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Connection refused | `BackendError` with `never-sent`. Phase 3 falls back for any operation. |
| Timeout before the request is flushed | `never-sent`. Fallback is safe. |
| Timeout after the request is flushed | `unknown-state`. Phase 3 refuses to fall back on writes. |
| TLS handshake rejected | `never-sent`. Nothing reached the server. |
| HTTP 404 / 400 / 500 | Resolve normally. Translated by `RestBackend` into the same error the filesystem raises for that condition. |
| 401 / 403 | Translate into a named configuration error mentioning `OBSIDIAN_API_KEY`, since this is a setup mistake rather than a runtime fault. |
| Plugin version below 4.1.7 | Warn once at startup and continue. |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| `RestClient` | Misclassifying a post-send timeout as `never-sent` | Classifying on `error.code` instead of the `finish` flag | Phase 3 falls back and duplicates a write; an `append` silently doubles content | Classify on the `finish` flag only; dedicated test for both timeout sides |
| `RestClient` | TLS relaxation leaks process-wide | Reaching for `NODE_TLS_REJECT_UNAUTHORIZED` when the agent seems not to apply | Every outbound HTTPS request in the process stops validating certificates | Grep criterion covers `src/`, `server.ts`, and `scripts/`; agent construction is the only permitted site |
| `RestClient` | Socket exhaustion under batch reads | `readMultipleNotes` with a large path list and `keepAlive` | Requests queue and hit the 5s timeout, classified `unknown-state` on reads | Cap agent `maxSockets`; batch reads are idempotent so a read fallback is safe |
| `RestBackend` | Non-atomic prepend | `mode: "prepend"`, which REST cannot express | A concurrent edit between read and write is lost | Documented; single-user vault makes the window negligible, and the filesystem backend remains atomic |
| `RestBackend` | Percent-encoding omitted on non-ASCII paths | A note with accented characters | 404 on a note that exists | Encode path and `Destination` separately; test with `résumé.md` |
| Fixture server | Drifts from real plugin behavior | Plugin updates via BRAT change a response shape | The contract suite passes while production fails | Optional live suite in phase 2 and the mandatory live smoke in phase 5 are the drift detectors |

## Validation Commands

```bash
# Type checking
npm run build

# Scoped tests
npm test -- src/backend/rest
npm test -- src/backend/testing

# Full suite, REST disabled
env -u OBSIDIAN_API_KEY npm test

# TLS scoping criterion
grep -rn NODE_TLS_REJECT_UNAUTHORIZED src/ server.ts scripts/   # expect no matches
grep -rn rejectUnauthorized src/backend/rest/                    # expect only the Agent constructor
```

## Rollout Considerations

- **Feature flag**: `OBSIDIAN_API_KEY` is the de facto flag. Nothing in this phase is reachable from `createServer` yet, so the code is inert regardless.
- **Rollback plan**: Self-contained new files plus one `AGENTS.md` edit. Reverting has no effect on runtime behavior.

## Open Items

- [ ] Decide the agent `maxSockets` value. Start at 8 and revisit if batch reads queue during the phase 5 benchmark.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
