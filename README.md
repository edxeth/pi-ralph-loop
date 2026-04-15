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

- **Provider errors**: Retried up to 3 times with a "continue" nudge
- **Missing terminal stopReason after tool use**: Treated as a retryable provider failure and retried up to the same 3-attempt budget with `continue`
- **User abort (Ctrl+C)**: Loop stops, does not start new iteration
- **Session shutdown (Ctrl+C×2)**: Loop stops immediately
- **Session transitions**: Loop state survives Ralph's internal `/new` session hops safely
- **Stale state**: Detected on startup and reset automatically
