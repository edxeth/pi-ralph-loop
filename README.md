# pi-ralph-loop

Ralph Wiggum loop extension for [pi](https://github.com/badlogic/pi-mono) — iterative task execution with fresh context windows.

## What It Does

Runs a task in a loop, creating a **fresh session** (new context window) for each iteration. This avoids context rot — the degradation LLMs experience as conversation history grows.

The loop stops when:
- The agent outputs `<promise>COMPLETE</promise>`
- Maximum iterations are reached
- The user cancels (Ctrl+C or `/ralph-stop`)

## Commands

### `/ralph-loop <task> [--max-iterations=N]`

Start a Ralph loop. The task is sent as a user message at the start of each fresh session.

```
/ralph-loop "@prd.md Find the FIRST unchecked task, implement it, check it off, commit." --max-iterations=20
```

Default max iterations: 100.

### `/ralph-resume [--force]`

Resume a saved loop from `.ralph/loop.md`.

- For failed, cancelled, stopped, or max-iteration runs, `/ralph-resume` works normally.
- For completed runs, use `/ralph-resume --force`.
- If you run it from the same session recorded in `session_id`, Ralph resumes that iteration in the current chat by sending `continue`.
- If you run it from any other session, Ralph restarts the saved iteration in a fresh session using the original task body from `.ralph/loop.md`.

### `/ralph-restart`

Restart the saved loop from iteration 1 in a fresh session, reusing the prompt and `max_iterations` from `.ralph/loop.md` and resetting the other frontmatter fields for a new run.

### `/ralph-stop`

Stop the loop after the current iteration finishes.

### `/ralph-status`

Show the current loop status (iteration, elapsed time, errors).

## Active Loop Safety

While a loop is running, the extension blocks `/resume`, `/new`, `/fork`, and `/tree` in that pi instance. These commands mutate the active session or branch and can interrupt the loop.

If you want to inspect previous iterations while Ralph keeps running, open a second `pi` instance and browse sessions there.

## State File

Loop state is persisted in `.ralph/loop.md` with YAML frontmatter:

```yaml
---
running: true
iteration: 3
max_iterations: 20
started_at: "2026-03-02T23:38:07.000Z"
completed_at: null
stop_reason: null
session_id: "abc123"
last_session_file: "~/.pi/agent/sessions/..."
error_count: 0
transitioning: false
cancel_requested: false
stop_requested: false
---

<your task prompt here>
```

## Bundle-mode Ralph workflow

Use bundle mode when a plan was generated into `.ralph/` artifacts, usually from PRD/SPEC planning docs:

1. Write or select source planning docs, such as `.pi/plans/prds/<id>.md` and `.pi/plans/specs/<id>.md`.
2. Run the bundled skill `/skill:ralph-plan-writer` to generate the execution bundle: `.ralph/plan.md`, `.ralph/items.json`, `.ralph/prompt.md`, and `.ralph/progress.md`.
3. Start Ralph with the generated prompt:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=20
```

Bundle mode is enabled only when the task is a prompt reference to `.ralph/prompt.md`, including `@.ralph/prompt.md` and `@./.ralph/prompt.md`. Other `/ralph-loop` prompts keep the regular non-bundle behavior.

The runtime validates the bundle before starting and rejects unsafe state, including missing required files, malformed `.ralph/items.json`, symlinked required bundle files, and bundle paths that resolve outside the workspace.

### Bundle runtime contract

`.ralph/items.json` is the source of truth for item status. It must contain `version: 1` and a non-empty `items` array where each item has `category`, `description`, `steps`, `passes`, and `regression_notes`.

An optional top-level `runtime_contract` can declare enforcement metadata:

```json
{
  "runtime_contract": {
    "source_docs": [".pi/plans/prds/2c5fc97a.md"],
    "verification_gates": [
      { "name": "tests", "command": "npm test" },
      { "name": "typecheck", "command": "npx tsc --noEmit" }
    ],
    "require_progress_append": true,
    "require_one_item_per_iteration": true,
    "require_clean_source_docs": true,
    "commit_policy": "exactly_one"
  }
}
```

Before each bundle iteration, Ralph snapshots item text/status, `.ralph/progress.md`, configured source docs, and git HEAD. A valid `<promise>NEXT</promise>` is accepted only when exactly one item moves from `passes:false` to `passes:true`, existing item text is unchanged, progress was appended, configured source docs are unchanged, configured verification gates pass, and the configured `commit_policy` passes. Supported commit policies are `none`, `optional`, `exactly_one`, and `at_least_one`. If an iteration starts without a git HEAD, initializing git and creating commits can satisfy `exactly_one` or `at_least_one`. A valid `<promise>COMPLETE</promise>` additionally requires every item to have `passes:true`, protected source docs to stay unchanged, configured verification gates to pass, and commit policy to pass.

Rejected NEXT or COMPLETE promises send a corrective prompt in the same session and do not create a fresh session. If bundle invariants fail repeatedly in the same iteration, Ralph stops with `stop_reason: "error"` instead of correcting forever. Accepted NEXT resets the rejection count and creates the next fresh Pi session.

## Documentation

- [Live end-to-end testing with pi](docs/live-e2e-testing.md)

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/pi-ralph-loop/`.

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/home/devkit/.pi/agent/extensions/pi-ralph-loop"
  ]
}
```

## How It Works

1. User runs `/ralph-loop "task" --max-iterations=N`
2. Ralph persists loop state to `.ralph/loop.md`
3. Ralph creates a fresh session via `ctx.newSession()`
4. After the new session starts, Ralph continues the loop directly
5. The session is named `Ralph loop iteration N/M`
6. The task is sent via `pi.sendUserMessage(...)`
7. Ralph waits for completion and reads the assistant control tag
8. `<promise>NEXT</promise>` advances to the next fresh session
9. `<promise>COMPLETE</promise>` stops successfully
10. The loop also stops on max iterations, user cancel, or persistent errors

## Testing

```bash
npm test
npm run test:live
```

- `npm test` covers parser, state persistence, command/event wiring, and loop orchestration.
- `npm run test:live` runs live RPC integration tests against pi.
- See [docs/live-e2e-testing.md](docs/live-e2e-testing.md) for the contributor workflow and manual smoke test.

## Error Handling

- **Provider errors**: Ralph waits for Pi's own retry handling and does not inject its own overlapping `continue`; if the error persists, the loop stops safely for inspection and intentional resume
- **Missing terminal stopReason after tool use**: Handled the same way
- **User abort (Ctrl+C)**: Loop stops, does not start new iteration
- **Session shutdown (Ctrl+C×2)**: Loop stops immediately
- **Session transitions**: Loop state survives Ralph's internal `/new` session hops safely
- **Stale state**: Detected on startup and reset automatically
