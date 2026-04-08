# Contributor notes

This repository is a pi coding agent extension.

## Important rules

- Do **not** depend on `/tmp/...` documentation paths or local monorepo checkouts.
- Do **not** pin contributor guidance to a specific temporary `pi-mono` clone.
- Do **not** assume an old pi version.
- Use the **currently installed** pi coding agent docs and examples that are available in the contributor's active environment.

## Source of truth for contributors using pi coding agent

Contributors on this repo are expected to use pi coding agent.
That means the active pi system prompt is already the correct source of runtime guidance for:

- where the current pi docs live
- which examples to read
- which extension APIs are available
- how the agent should behave while editing code

So for pi-specific work, contributors should:

1. read this repository's `README.md`
2. read `docs/live-e2e-testing.md`
3. follow the pi coding agent system prompt's current documentation paths for the installed version
4. validate changes with repo tests, especially live pi tests

## Current product goal

Maintain a Ralph-loop extension that:

- runs a task across **fresh pi sessions**
- persists loop state in `.ralph/loop.md`
- advances on `<promise>NEXT</promise>`
- completes on `<promise>COMPLETE</promise>`
- supports stop/resume/restart safely across session transitions

## Current architecture

- `index.ts` — extension entry point
- `commands.ts` — slash command registration and command handlers
- `events.ts` — session lifecycle/event handlers
- `loop-engine.ts` — loop execution and control-flow orchestration
- `state.ts` — persisted loop state I/O
- `parser.ts` — `/ralph-loop` argument parsing
- `types.ts` — shared types
- `tests/` — regression and live integration coverage

## Validation standard

All meaningful changes should run:

```bash
npm test
npm run test:live
```

For live pi validation, use the project standard documented in `docs/live-e2e-testing.md`.
