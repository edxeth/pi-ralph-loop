# Live end-to-end testing with pi

Use this when changing the Ralph loop runtime, session-transition behavior, or anything touching command/event wiring.

## Required model

Always use:

- model: `ccs-openai-alt/gpt-5.4-mini`
- thinking: `medium`

This is the project standard for live pi validation.

## Prerequisites

- `gh`/repo access is not required for the tests themselves
- pi must be installed and usable from this machine
- the account/environment must have access to `ccs-openai-alt/gpt-5.4-mini`

## Main commands

Run local regression tests first:

```bash
npm test
```

Run live pi integration tests:

```bash
npm run test:live
```

The live test suite already pins:

- `--model ccs-openai-alt/gpt-5.4-mini`
- `--thinking medium`

## What the live suite verifies

Current live coverage checks that Ralph:

- advances on `<promise>NEXT</promise>`
- completes on `<promise>COMPLETE</promise>`
- stops on `max_iterations`
- works through real pi RPC mode with the extension loaded

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
