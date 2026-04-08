# Progress

## Current status

The extension is implemented, tested, and published.

## Current behavior

- `/ralph-loop` starts a persisted Ralph run
- each iteration uses a **fresh pi session**
- session transitions are handled through persisted state plus an internal continuation command
- `<promise>NEXT</promise>` advances the loop
- `<promise>COMPLETE</promise>` finishes the loop
- `/ralph-stop`, `/ralph-resume`, and `/ralph-restart` are supported

## Current validation state

Regression coverage exists for:

- parser behavior
- state persistence
- command wiring
- event wiring
- loop-engine control flow
- live pi RPC integration

Main commands:

```bash
npm test
npm run test:live
```

## Notes for contributors

- treat `README.md` and `docs/live-e2e-testing.md` as the repo-local documentation baseline
- use the **current installed pi docs** from your active pi coding agent environment
- do not rely on temporary `/tmp/...` documentation paths
- do not assume a fixed historical pi version unless the repo explicitly pins one
