
## 2026-05-05 18:03 UTC — Expand repository validation so TypeScript typechecking covers source and tests without changing runtime behavior.
- Decisions: Included tests in tsconfig typechecking and enabled allowImportingTsExtensions to match existing .ts test imports; changed npm test reporter only to expose normal Node test output in this harness.
- Files changed: tsconfig.json, package.json, .gitignore, .ralph/items.json.
- Verification: npm test (pass, 20 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Implement the bundle parser and validator item.

## 2026-05-05 18:15 UTC — Add a bundle parser and validator for .ralph/plan.md, .ralph/items.json, .ralph/prompt.md, and .ralph/progress.md.
- Decisions: Added a small bundle.ts module for required file discovery, symlink/workspace/readability checks, items.json schema validation, and optional runtime_contract parsing without wiring runtime behavior yet.
- Files changed: bundle.ts, tests/bundle.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 24 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Detect bundle mode for @.ralph/prompt.md while preserving non-bundle /ralph-loop behavior.

## 2026-05-05 18:10 UTC — Detect bundle mode when /ralph-loop is started with @.ralph/prompt.md or an equivalent prompt reference.
- Decisions: Normalize @.ralph/prompt.md and @./.ralph/prompt.md after argument parsing, validate the bundle, and load .ralph/prompt.md while leaving other prompts in non-bundle mode.
- Files changed: commands.ts, tests/commands.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: command npm test (pass, 28 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Extend persisted loop state for backward-compatible bundle-mode metadata and active-loop locking.

## 2026-05-05 18:15 UTC — Extend persisted loop state for backward-compatible bundle-mode metadata and active-loop locking.
- Decisions: Added bundle-mode metadata fields to persisted state with legacy defaults, generated loop tokens for new and old state reads, and kept active running-state rejection at command start.
- Files changed: types.ts, state.ts, loop-engine.ts, commands.ts, tests/state.test.ts, tests/commands.test.ts, tests/events.test.ts, tests/index.test.ts, tests/loop-engine.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 30 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Record pre-iteration snapshots for bundle mode.

## 2026-05-05 18:18 UTC — Record pre-iteration snapshots for bundle items, progress file state, source docs, and git HEAD when bundle mode is active.
- Decisions: Added a small snapshot helper that hashes immutable item/pass state, progress content, configured source docs, and git HEAD; bundle-mode loop starts and resumed/session-started iterations persist snapshot fields before sending prompts.
- Files changed: bundle.ts, loop-engine.ts, tests/commands.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 30 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Implement structural NEXT gate evaluation.

## 2026-05-05 18:23 UTC — Implement structural NEXT gate evaluation for exactly one completed item and immutable item fields.
- Decisions: Added a persisted item snapshot payload and a bundle NEXT gate that runs before fresh-session transition; rejection currently reports the failed invariant and leaves the iteration active.
- Files changed: bundle.ts, loop-engine.ts, state.ts, types.ts, tests/loop-engine.test.ts, tests/commands.test.ts, tests/events.test.ts, tests/index.test.ts, tests/state.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm run test (pass, 34 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Implement structural COMPLETE gate evaluation.

## 2026-05-05 18:27 UTC — Implement structural COMPLETE gate evaluation so completion is accepted only when every item passes and immutable fields are intact.
- Decisions: Reused the bundle item snapshot parsing and immutable-field checks for COMPLETE, then required every current item to have passes=true before finalization.
- Files changed: bundle.ts, loop-engine.ts, tests/loop-engine.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: command npm test (pass, 37 passed/2 skipped); npx tsc --noEmit (pass).
- Next: Add rejection prompt handling that sends corrective prompts in the current session.

## 2026-05-05 18:31 UTC — Add rejection prompt handling that keeps the current iteration active and does not create a fresh session.
- Decisions: Added a shared bundle rejection prompt path for NEXT and COMPLETE that names the failed invariant, sends the corrective prompt in the current session, and leaves iteration/session-transition state untouched.
- Files changed: loop-engine.ts, tests/loop-engine.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test via script PTY (pass, 37 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Enforce append-only progress and source-doc hash protection in bundle mode.

## 2026-05-05 18:44 UTC — Enforce append-only .ralph/progress.md behavior and configured source-document hash protection in bundle mode.
- Decisions: Stored the progress prefix in bundle snapshots and added shared NEXT/COMPLETE file gates for progress append-only and configured source-doc hashes.
- Files changed: bundle.ts, loop-engine.ts, state.ts, types.ts, tests/commands.test.ts, tests/events.test.ts, tests/index.test.ts, tests/loop-engine.test.ts, tests/state.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 41 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Add bounded verification gate execution or document its deferral.

## 2026-05-05 18:48 UTC — Add bounded explicit verification gate execution for runtime_contract.verification_gates or document deferral if it cannot stay small.
- Decisions: Implemented explicit configured-gate execution from the workspace root with timeout/output caps and reused the rejection path for NEXT and COMPLETE failures.
- Files changed: bundle.ts, loop-engine.ts, tests/loop-engine.test.ts, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 44 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Document the PRD/SPEC to ralph-plan to /ralph-loop workflow and bundle-mode runtime contract.

## 2026-05-05 18:50 UTC — Document the PRD/SPEC to ralph-plan to /ralph-loop workflow and the bundle-mode runtime contract.
- Decisions: Documented generated-bundle workflow, bundle-mode prompt detection, required files, runtime_contract metadata, NEXT/COMPLETE enforcement, and rejection behavior; noted bundle live lifecycle coverage in live-test docs.
- Files changed: README.md, docs/live-e2e-testing.md, .ralph/items.json, .ralph/progress.md.
- Verification: npm test (pass, 44 passed/2 skipped), npx tsc --noEmit (pass).
- Next: Run full regression, typecheck, and live Pi smoke validation through explicit tia pi.
