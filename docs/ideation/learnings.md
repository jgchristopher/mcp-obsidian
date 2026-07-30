# Ideation Learnings

Generalizable spec-gap and interview patterns mined from completed ideation
projects by `/ideation:retro`. Intake reads this file so recurring gaps inform
future questioning and spec generation. Each entry is dated and cites its
evidence; treat entries as hints, never as a substitute for gate evidence.

## 2026-07-30 — mcpvault-rest-backend

- **Pattern**: Specs asserted the shape of existing APIs from memory, and several assertions were wrong — including one stated under an explicit "Open Items: None".
  **Evidence**: Phase 1, "VaultBackend interface — four signatures do not match FileSystemService": the spec claimed every interface member mapped to an existing service method; four did not, and `getFrontmatter` had no service equivalent at all. Phase 2, "The plugin version lives at versions.self, not manifest.version": the spec's field name would have read `undefined` forever, leaving the version floor as dead code that always passed. Phase 2, "RestBackend — four operations do not use the endpoint the spec assigns them".
  **Spec/interview implication**: Require every claimed signature, endpoint, or response field to cite where it was read (file:line, or the vendored OpenAPI doc). A shape nobody looked up is an Open Item, not an assertion. Treat "Open Items: None" as a claim needing the same evidence as any other — here it was simply false.

- **Pattern**: Success criteria were authored before the code existed and never re-validated; four of eleven were wrong as written.
  **Evidence**: Criterion 3 named `src/backend/filesystem/periodic`, a path the spec itself placed at `src/backend/periodic`. Criterion 6 forbade editing pre-existing tests, which registering nine new tools makes impossible (`createServer.test.ts` hard-asserts the tool count). Criterion 8's `grep` matches the very test asserting the forbidden thing never happens. Criterion 10 contradicted the spec's own reasoned decision to keep the `obsidian-jcos` server name.
  **Spec/interview implication**: Every criterion's check command must be runnable in principle at authoring time. Any criterion naming a path, module, or identifier the spec itself invents is a guess — mark it provisional and reconcile it when the phase that creates the path is written. Cross-check criteria against later specs' decisions before declaring the contract approved.

- **Pattern**: File Changes tables consistently omitted test doubles and shared helpers, which the phase then had to modify anyway.
  **Evidence**: Phase 4, "Fixture server — four endpoints the spec's file table omitted": the spec's own feedback loop required stubs in `fixture-server.ts`, but the file was not in Modified Files. Phase 5 added a third script (`scripts/preflight.ts`) to avoid duplicating a safety guard across two declared scripts. Phase 1 moved handler tests to a new file because the spec's declared target conflicted with a contract goal.
  **Spec/interview implication**: This is a correctness risk, not documentation drift — autopilot serializes same-wave phases by their declared `files`, so an omission can let two phases race on one file. Ask explicitly which **fixtures, test helpers, and shared utilities** a phase touches; those are the rows that get missed. A phase whose feedback loop names a file must list that file.

- **Pattern**: Optional tooling was assumed available, and when it was absent four phases shipped without the review the process specifies.
  **Evidence**: Phases 1–4 each reported falling back to validation-only because no Agent-dispatch tool existed in the workflow sandbox. Phase 5, run where the reviewer was available, returned 1 critical and 3 high findings on cycle 1 — including checks that ran in the wrong order and three independent false-pass paths.
  **Spec/interview implication**: Do not treat the reviewer or scout as guaranteed. Verify dispatch availability before a run rather than discovering it per phase, and when the fallback fires, record which phases went unreviewed so they can be re-reviewed later. The measured cost here was four defects that a single review cycle caught in a comparable phase.

- **Pattern**: A test double silently narrowed which code paths executed, and defects survived precisely in the paths it skipped.
  **Evidence**: Phase 5 drove both scripts against the in-repo fixture server, which keeps its vault in memory. The on-disk teardown therefore never ran, concealing an unconditional `ERR_FS_EISDIR` from `rm(dir, { recursive: false })` that meant the scratch folder was never removed. It surfaced only when the benchmark — which seeds through the filesystem — was run against the same fixture. Two cross-arm checks could not pass under the fixture at all.
  **Spec/interview implication**: A spec that ships a test double must state which real paths the double cannot exercise. Those paths become explicit live or manual checks, not assumed coverage. "Tests pass against the fixture" and "the code works" differ by exactly the set of paths the fixture cannot reach.

- **Pattern**: A guard was specified by naming the failure it should prevent, but the check specified alongside it did not detect that failure.
  **Evidence**: Phase 5's spec listed "false pass from the filesystem" under Failure Modes with the mitigation "guard refuses to run unless `GET /` succeeds". Reachability proves a server is running, not which vault it holds — a running Obsidian on a different vault answers happily while every routed call is served from disk. Closed by comparing `fingerprintRest` against `fingerprintFilesystem`.
  **Spec/interview implication**: When a spec pairs a named failure mode with a mitigating check, verify the check actually detects that mode rather than a correlate of it. Liveness is not identity; reachable is not correct; present is not matching.

- **Pattern**: Verification that asserts a call succeeded can pass against a completely broken system, because this server never rejects.
  **Evidence**: Phase 5, "resolved promises are not passes": `createServer` catches every handler throw and returns `{ isError: true }`; several tools report failure as `success: false` in a resolved, non-error response; `read_multiple_notes` reports per-path failures in an `err` array with no `success` key at all, so a missing note reads as a clean response.
  **Spec/interview implication**: Any verification script against this MCP server must assert an observable effect — content read back, a path present in results — never promise resolution or absence of `isError` alone. Worth stating in the spec's Testing Requirements whenever a phase adds a script that calls tools.

- **Pattern**: Artifacts created outside `src/` fall outside the repo's automatic checks, and duplicated facts in prose drift unnoticed.
  **Evidence**: `scripts/` was in no tsconfig and compiled by no CI job — 900+ lines whose type errors would only appear when someone ran the script. Separately, the registered tool count lived in three places and disagreed in all of them: README said 14, `AGENTS.md` said 16, and 25 were registered.
  **Spec/interview implication**: A phase that creates a new top-level directory must say how it gets typechecked and which CI job covers it. A phase that changes a count, inventory, or capability list stated in prose must list every file repeating that fact in File Changes — ask where else the number lives rather than assuming one home.
