# Live end-to-end testing with pi

Use this when changing the Ralph loop runtime, session-transition behavior, or anything touching command/event wiring.

## Model selection

Contributors do **not** need to use one fixed model.

Use any working model you have access to.
If a maintainer asks for a specific model for a validation pass, follow that request for that pass only.

## Prerequisites

- `gh`/repo access is not required for the tests themselves
- pi must be installed and usable from this machine
- you must have access to whichever pi model you choose for the live run

## Main commands

Run local regression tests first:

```bash
npm test
```

Run live pi integration tests:

```bash
npm run test:live
```

Override the live-test model if needed:

```bash
PI_RALPH_TEST_MODEL="your-provider/your-model" \
PI_RALPH_TEST_THINKING="medium" \
npm run test:live
```

The live suite accepts:

- `PI_RALPH_TEST_MODEL`
- `PI_RALPH_TEST_THINKING`

If those are unset, the test file falls back to its current local defaults.

## What the live suite verifies

Current live coverage checks that Ralph:

- advances on `<promise>NEXT</promise>`
- completes on `<promise>COMPLETE</promise>`
- stops on `max_iterations`
- works through real pi RPC mode with the extension loaded
- preserves accepted NEXT fresh-session lifecycle in bundle mode
- keeps rejected bundle NEXT promises in the same session

Bundle-mode live tests use a temporary `PI_CODING_AGENT_DIR` and should be run through the user's real TIA-wrapped entrypoint when validating release behavior. Use explicit `tia pi`, not plain `pi`, for manual integration checks.

## Manual smoke test

Useful after larger refactors:

```text
/ralph-loop "Read .ralph/loop.md to get the current iteration number. If iteration is less than 3, reply with exactly two lines: Iteration <n> and <promise>NEXT</promise>. If iteration is 3 or greater, reply with exactly two lines: Iteration <n> and <promise>COMPLETE</promise>. Do not use code fences or extra text." --max-iterations=5
```

Expected:

- iteration 1 -> NEXT
- iteration 2 -> NEXT
- iteration 3 -> COMPLETE

## Contributor workflow

For AI-assisted contributors working on this repo:

1. change code
2. run `npm test`
3. run `npm run test:live`
4. if loop/session behavior changed, also run the manual smoke test above
5. only then consider the change validated

## When to add more live tests

Add or update live tests whenever you change:

- session handoff behavior
- `/ralph-resume`, `/ralph-restart`, or `/ralph-stop`
- promise-tag parsing
- retry/error behavior
- persisted loop state shape
