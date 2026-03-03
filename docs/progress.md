# Implementation Progress

## Status: v1.0 Complete

All PRD items implemented and tested.

## Completed Items

- [x] `/ralph-loop` command with task prompt and `--max-iterations=N`
- [x] `.pi/ralph-loop.md` state file with YAML frontmatter + task body
- [x] Fresh session per iteration via `ctx.newSession()`
- [x] `<promise>COMPLETE</promise>` detection in assistant messages
- [x] Session naming: `Ralph loop iteration N/M`
- [x] User cancellation handling via `session_shutdown` event
- [x] Abort detection via `stopReason === "aborted"` after `waitForIdle()`
- [x] Provider error retry (up to 3 "continue" nudges with 2s backoff)
- [x] `/ralph-stop` command
- [x] `/ralph-status` command
- [x] Footer status indicator during loop execution
- [x] Stale state detection on `session_start` (crash recovery)
- [x] Argument parsing with quoted/unquoted tasks and `--max-iterations`

## Architecture

```
index.ts        — Entry point: 3 commands, 2 event handlers, shared mutable refs
loop-engine.ts  — Core loop: iteration, idle-wait, completion check, retry
state.ts        — .pi/ralph-loop.md read/write (simple YAML frontmatter)
parser.ts       — /ralph-loop argument parsing
types.ts        — TypeScript interfaces
```

Total: ~700 lines across 5 files. No `any` types. No subprocess spawning.

## Testing Notes

### Test 1: Single-iteration completion (JSON mode)

```
pi --mode json --no-session <<< '/ralph-loop "Write hello to hello.txt then output <promise>COMPLETE</promise>" --max-iterations=2'
```

**Result:** `stop_reason: "complete"`, `iteration: 1`. Agent wrote hello.txt and emitted the promise tag. Loop stopped after 1 iteration.

### Test 2: Multi-iteration without completion (JSON mode)

```
pi --mode json --no-session <<< '/ralph-loop "Echo the current date to date.log. Do NOT output any promises." --max-iterations=2'
```

**Result:** `stop_reason: "max_iterations"`, `iteration: 2`. Two separate `agent_end` events in JSON output, each with the identical task prompt as the first user message. Message counts per iteration were independent (4 each), confirming fresh context windows with no accumulated history.

### Test 3: Session verification

Extracted user prompts from both `agent_end` events and compared:
- Iteration 1 prompt === Iteration 2 prompt === original task
- Each iteration had its own message array (no context leakage)

## Bugs Found & Fixed

### Race condition: `waitForIdle()` returning before agent starts

**Symptom:** Loop blew through all iterations instantly. `stop_reason: "max_iterations"` even though the agent hadn't processed any prompts yet. The agent's actual work happened _after_ the loop had already finished.

**Root cause:** `pi.sendUserMessage(task)` triggers a turn asynchronously. If `ctx.waitForIdle()` is called before the agent begins processing, it returns immediately because the agent _is_ momentarily idle (hasn't started yet).

**Fix:** Added a spin-wait after `sendUserMessage()`:

```typescript
pi.sendUserMessage(task);
while (ctx.isIdle() && !shouldStop(cancelledRef, stoppedRef)) {
  await sleep(100);
}
await ctx.waitForIdle();
```

This polls `ctx.isIdle()` in 100ms intervals until the agent transitions to non-idle (streaming), then waits for it to finish. Applied to both the main task send and the error-retry "continue" nudge.

### Emoji removal

User feedback: emojis in notifications were "childish". Stripped all emoji prefixes from notification messages and footer status. The notification `type` parameter (`"info"`, `"warning"`, `"error"`) already conveys severity.

### Race condition: non-terminal assistant state treated as completed iteration

**Symptom:** Some loop iterations ended mid-work and the loop started the next iteration. Session logs showed the last assistant message with `stopReason: "toolUse"` followed by a tool result, but no final assistant message (`stop`/`error`/`aborted`).

**Root cause:** The earlier fix only waited until *any* assistant message appeared after `waitForIdle()`. That was too weak. In failure cases after a tool call, the last persisted assistant message can remain non-terminal (`toolUse`), and the loop incorrectly advanced.

**Fix (final):**
- Added `getLastAssistantStopReason()`.
- `waitForSessionSettle()` now waits for a **terminal** assistant stopReason: `stop`, `length`, `error`, or `aborted`.
- Increased settle timeout to 10s.
- `sendAndWaitForCompletion()` now returns `boolean`.
- If settle times out (stopReason stuck at `toolUse`), the loop marks the iteration as `error` and stops instead of advancing.

This prevents premature session switching and ensures one iteration only advances when the previous one has terminally completed.

## Testing Difficulties

### Print mode (`pi -p`) doesn't work for loop testing

`pi -p '/ralph-loop "..."'` executes the command handler, but `pi.sendUserMessage()` inside it does not trigger agent turns. Print mode only processes the initial `-p` prompt. The loop creates sessions and writes state, but no agent work happens. State file shows `max_iterations` reached with `iteration: 2` instantly.

### Interactive TUI input via `interactive_shell` is unreliable

Multiple attempts to type `/ralph-loop ...` into pi's TUI via the `interactive_shell` tool failed:

1. **`inputPaste`** — bracketed paste mode (`^[[200~...^[[201~`) was shown literally in some cases instead of being processed as a paste event.
2. **`input` with `\n`** — the `\n` was treated as a literal newline in the editor (multiline mode), not as Enter to submit.
3. **`input` followed by `inputKeys: ["enter"]`** — the `/` at the start triggered pi's command autocomplete, and the rapid character injection interfered. The `/` was consumed by autocomplete, so the text was submitted as a regular user prompt (without the `/` prefix).
4. **`input` with `escape` then `enter`** — Escape dismissed autocomplete but the `/` was already gone.

**Working approach:** `pi --mode json` with heredoc stdin. Extension commands are recognized and executed in JSON mode, and `sendUserMessage()` triggers proper agent turns.

### JSON mode sessions aren't persisted to disk

In JSON mode, `ctx.sessionManager.getSessionFile()` returns `null`. Sessions are in-memory. This means `last_session_file` in the state file is always `null` during JSON-mode testing. This is expected — the sessions exist during the run but aren't written to `.jsonl` files. Interactive mode would persist them.
