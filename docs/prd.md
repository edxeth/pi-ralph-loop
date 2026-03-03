# PRD: pi-ralph-loop Extension

## Objective

Build a pi coding agent extension in TypeScript that implements the Ralph Wiggum loop pattern as a first-class `/ralph-loop` command. The extension creates **fresh context windows** (new sessions) for each loop iteration — the critical architectural decision that makes Ralph effective (avoiding the "dumb zone" of context rot). It tracks loop state in a `.pi/ralph-loop.md` frontmatter file, detects the `<promise>COMPLETE</promise>` completion signal, handles user cancellation cleanly, retries on provider errors, and names each session for easy identification.

## Context References

Read ALL of the following files before implementing. They contain the extension API, Ralph methodology, and pi internals needed to build this correctly.

### Pi Platform Documentation (MANDATORY)

- `@/tmp/pi-mono/README.md` — Monorepo overview, package map
- `@/tmp/pi-mono/packages/coding-agent/docs/extensions.md` — **PRIMARY REFERENCE**: Extension API, events, commands, hooks, tools, UI, state management, custom rendering
- `@/tmp/pi-mono/packages/coding-agent/docs/sdk.md` — SDK internals: `createAgentSession`, `AgentSession`, events, session management, prompting
- `@/tmp/pi-mono/packages/coding-agent/docs/session.md` — Session file format (JSONL), message types (`AssistantMessage.stopReason`, `AgentMessage` union), `SessionManager` API, tree structure
- `@/tmp/pi-mono/packages/coding-agent/docs/settings.md` — Settings structure, retry config, extensions/packages arrays
- `@/tmp/pi-mono/packages/coding-agent/docs/packages.md` — Package structure, `pi` manifest in `package.json`, peer dependencies, publishing
- `@/tmp/pi-mono/packages/coding-agent/docs/prompt-templates.md` — Prompt template format (frontmatter + body)

### Pi Extension Examples (MANDATORY — study patterns)

- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/send-user-message.ts` — How to use `pi.sendUserMessage()` with delivery modes
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/session-name.ts` — How to use `pi.setSessionName()` / `pi.getSessionName()`
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/shutdown-command.ts` — How to use `ctx.shutdown()`
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts` — Complex extension with state, status, widgets, commands, flags, shortcuts
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/status-line.ts` — Footer status indicators
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/confirm-destructive.ts` — Session lifecycle hooks
- `@/tmp/pi-mono/packages/coding-agent/examples/extensions/file-trigger.ts` — Using `pi.sendMessage()` to trigger turns

### Ralph Wiggum Methodology (MANDATORY — understand the "why")

- `@/home/devkit/.pi/agent/prompts/resources/ralph-wiggum/geoffrey-huntley/001-intro-to-ralph-loop.md` — Origin story: loops as an orchestrator pattern, single task per loop, monolithic agent
- `@/home/devkit/.pi/agent/prompts/resources/ralph-wiggum/geoffrey-huntley/001-ralph-as-engineer.md` — Ralph is a technique (bash loop), eventual consistency, tuning the loop, "Ralph is deterministically bad in an undeterministic world"
- `@/home/devkit/.pi/agent/prompts/resources/ralph-wiggum/anthropic/001-long-running-agents.md` — Anthropic's research: initializer + coding agent, feature lists (JSON with `passes`), incremental progress, progress files, testing gates, `<promise>COMPLETE</promise>`
- `@/home/devkit/.pi/agent/prompts/resources/ralph-wiggum/matt-pocock/001-tips-for-ralph-loops.md` — 11 practical tips: HITL vs AFK, progress tracking, feedback loops, small steps, prioritization, quality standards, iteration caps
- `@/home/devkit/.pi/agent/prompts/resources/ralph-wiggum/matt-pocock/002-anthropic-plugin-sucks.md` — **CRITICAL**: Why the Anthropic plugin fails — it keeps iterations in ONE session, causing context rot. Ralph REQUIRES fresh context windows per iteration.

### Ralph Planning Prompt (reference for understanding expected outputs)

- `@/home/devkit/.pi/agent/prompts/ralph-plan.md` — The `/ralph-plan` prompt template that generates planning bundles (PRD, items, prompt, progress files)

### Existing Implementation (study ONLY to learn what to AVOID)

- `@/tmp/pi-hooks/ralph-loop/ralph-loop.ts` — 2000+ line over-engineered implementation that spawns pi as RPC subprocesses, builds custom TUI rendering, maintains its own agent discovery system, and forces users into a parallel command vocabulary. It types every pi import as `any`. This is the anti-pattern. Our extension leverages pi's native interface instead of fighting it.
- `@/tmp/pi-hooks/ralph-loop/agents.ts` — Custom agent discovery system (NOT needed — we use pi's native sessions, not subagent spawning)
- `@/tmp/pi-hooks/repeat/repeat.ts` — Example of an extension registering commands with custom UI (useful for structural patterns)

---

## Scope In

1. `/ralph-loop` command with task prompt and `--max-iterations=N` option
2. `.pi/ralph-loop.md` state file with YAML frontmatter + task prompt body
3. Fresh session per iteration via `ctx.newSession()`
4. `<promise>COMPLETE</promise>` detection in assistant messages via `agent_end` or post-`waitForIdle()` inspection
5. Session naming: `Ralph loop iteration N/M`
6. User cancellation handling (Ctrl+C × 2 / `session_shutdown` → stop the loop)
7. Provider/model error retry (up to 3 continuation nudges with `"continue"`)
8. `/ralph-stop` command to halt the loop explicitly
9. `/ralph-status` command to show current loop state
10. Footer status indicator during loop execution
11. Clean extension structure as a pi package

## Scope Out

- **Subagent/RPC subprocess spawning** — this is the old approach's cardinal sin; we use `ctx.newSession()` + `pi.sendUserMessage()` instead
- **Custom TUI rendering** — pi's native interactive mode renders sessions perfectly; no custom `ToolExecutionComponent` wrappers needed
- **Parallel command vocabulary** — no `/ralph-steer`, `/ralph-follow`, `/ralph-pause`, `/ralph-resume`, `/ralph-clear`; the user steers pi normally via its native interface
- **Agent discovery system** — no reading `.md` files from custom agent directories; we run in-process
- Docker sandbox integration
- Multi-agent orchestration
- Custom compaction strategies
- Web UI / RPC mode support (interactive mode only for v1)
- Planning/PRD generation (that's `/ralph-plan`'s job)

## Constraints

- Must use pi's extension API only — no subprocess spawning of `pi`
- Must create **new sessions** (fresh context windows) per iteration, not reuse the same session
- Must be a directory-style extension at `/home/devkit/.pi/agent/extensions/pi-ralph-loop/`
- Must work with pi v0.55.x
- TypeScript, loaded via jiti (no build step needed)
- Peer dependencies: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`

## Prioritization Strategy

1. Core loop mechanics (command, new session, send prompt, wait, check completion)
2. State file management (`.pi/ralph-loop.md`)
3. Cancellation safety (the hardest correctness problem)
4. Error retry logic
5. UI polish (status bar, session naming, notifications)
6. `/ralph-stop` and `/ralph-status` commands

## Completion Definition

- The extension loads without errors in pi v0.55.x
- `/ralph-loop "task" --max-iterations=3` creates fresh sessions, iterates, and stops on `<promise>COMPLETE</promise>`
- Ctrl+C during streaming or `session_shutdown` stops the loop without starting a new iteration
- Provider errors are retried up to 3 times with a `"continue"` nudge
- `.pi/ralph-loop.md` accurately reflects the loop state at all times
- Sessions are named `Ralph loop iteration N/M`
- `/ralph-stop` halts the loop from another terminal or between iterations
- `/ralph-status` shows current loop progress
- Desloppify scan produces a clean score

---

## Design Philosophy

### Lean Into Pi, Don't Fight It

The existing `pi-hooks/ralph-loop` implementation (2000+ lines) is a cautionary tale of over-engineering. It:

- **Spawns pi as RPC subprocesses** — reimplementing session management, message parsing, process lifecycle, stdin/stdout buffering, and signal handling that pi already does natively.
- **Maintains its own agent discovery system** — reading `.md` files from custom directories, parsing frontmatter, resolving tool configurations — all redundant when pi's extension API provides `ctx.newSession()`, `pi.sendUserMessage()`, and `ctx.waitForIdle()`.
- **Forces users to learn a parallel command vocabulary** — `/ralph-steer`, `/ralph-follow`, `/ralph-pause`, `/ralph-resume`, `/ralph-clear` — when pi already has steering (`deliverAs: "steer"`), follow-up (`deliverAs: "followUp"`), and abort (Ctrl+C) built into its native interface.
- **Builds custom TUI rendering** — `ToolExecutionComponent`, `AssistantMessageComponent`, `DynamicBorder`, scroll containers — when pi's interactive mode already renders everything beautifully. The user can just *watch pi work* in a normal session.
- **Has `any`-typed everything** — the `types.d.ts` declares every pi import as `any`, defeating TypeScript's purpose entirely.

**Our approach is the opposite.** The entire extension should be ~200–400 lines total. We use pi's native session system, native message rendering, native user interaction, and native error handling. The user sees a normal pi session for each iteration — because it IS a normal pi session. The only difference is that when one session finishes, we automatically start another with the same prompt.

The extension adds exactly three commands (`/ralph-loop`, `/ralph-stop`, `/ralph-status`), a footer status indicator, and a state file. That's it. Everything else is pi being pi.

### The User Experience

When a user runs `/ralph-loop`, they should see **exactly what they'd see if they manually typed the prompt, waited, then hit `/new` and typed it again.** The sessions show up in `/resume` with clear names. The messages render normally. Ctrl+C works as expected. There is no custom UI layer, no separate rendering pipeline, no hidden subprocess tree. Just pi, running in a loop.

## Architecture

### Why Fresh Sessions Matter

From Matt Pocock's analysis (`002-anthropic-plugin-sucks.md`):

> The Anthropic plugin keeps everything inside a single Claude Code session. Instead of exiting and restarting, the plugin uses a "stop hook" that intercepts Claude's exit attempts and feeds the same prompt back into the session. The loop happens entirely within one session.

This causes **context rot** — LLMs get exponentially worse as context fills up. The "smart zone" is roughly the first 40% of context. Our extension MUST create new sessions for each iteration.

### Extension Structure

```
/home/devkit/.pi/agent/extensions/pi-ralph-loop/
├── index.ts          # Entry point: exports default function(pi: ExtensionAPI)
├── loop-engine.ts    # Core loop logic: iteration, state transitions, retries
├── state.ts          # .pi/ralph-loop.md file I/O (read/write frontmatter + body)
├── parser.ts         # Argument parsing for /ralph-loop command
├── types.ts          # TypeScript interfaces and types
├── package.json      # Package manifest with pi.extensions entry
└── README.md         # Usage documentation
```

### Data Flow

```
User types: /ralph-loop "task..." --max-iterations=10
  │
  ├─► parser.ts: parse task + options
  ├─► state.ts: write .pi/ralph-loop.md (running=true, iteration=1)
  │
  ▼
loop-engine.ts: ITERATION LOOP
  │
  ├─► ctx.newSession()                    ← Fresh context window!
  ├─► pi.setSessionName("Ralph loop iteration 1/10")
  ├─► pi.sendUserMessage(taskPrompt)      ← Send the task
  ├─► ctx.waitForIdle()                   ← Wait for completion
  │
  ├─► CHECK: Was user cancelled?          ← session_shutdown flag
  │   └─► YES: update state, break
  │
  ├─► CHECK: Provider error?              ← stopReason === "error"
  │   └─► YES: retry up to 3× with "continue" nudge
  │
  ├─► CHECK: <promise>COMPLETE</promise>? ← scan assistant messages
  │   ├─► YES: update state (running=false, completed_at), break
  │   └─► NO: increment iteration, continue loop
  │
  └─► state.ts: update .pi/ralph-loop.md (iteration++)
```

---

## File Specifications

### `.pi/ralph-loop.md` — State File

**Location:** `<cwd>/.pi/ralph-loop.md` (project-scoped, under the `.pi/` directory)

**Format:** YAML frontmatter + markdown body

```markdown
---
running: true
iteration: 1
max_iterations: 10
started_at: "2026-03-02T23:38:07.000Z"
completed_at: null
stop_reason: null
session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
last_session_file: "~/.pi/agent/sessions/--home--devkit--projects--myproject/1740960000000_abc123.jsonl"
error_count: 0
---

@prd.md
@progress.md
1. Read prd.md - find the FIRST unchecked task
2. Implement ONLY that ONE task
3. Check it off in prd.md: change '- [ ]' to '- [x]'
4. Append what you did to progress.md
5. Make a git commit
6. STOP. Do not continue to the next task.
If ALL tasks in prd.md are checked off, output <promise>COMPLETE</promise>
CRITICAL: You must STOP after ONE task.
```

**Frontmatter fields:**

| Field | Type | Description |
|---|---|---|
| `running` | boolean | Whether the loop is currently active |
| `iteration` | number | Current iteration number (1-indexed) |
| `max_iterations` | number | Maximum iterations allowed |
| `started_at` | string (ISO 8601 UTC) | When the loop was started |
| `completed_at` | string \| null | When the loop finished (null while running) |
| `stop_reason` | string \| null | Why the loop stopped: `"complete"`, `"max_iterations"`, `"user_cancelled"`, `"error"`, `"manual_stop"` |
| `session_id` | string | The session UUID from `ctx.sessionManager.getSessionId()` for the current/last iteration |
| `last_session_file` | string \| null | Path to the last session `.jsonl` file |
| `error_count` | number | Cumulative provider error count across all iterations |

**Body:** The raw task prompt, exactly as the user provided it. This is re-sent as the user message at the start of each new iteration.

### `index.ts` — Extension Entry Point

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1. Register /ralph-loop command
  // 2. Register /ralph-stop command
  // 3. Register /ralph-status command
  // 4. Subscribe to session_shutdown event (set cancellation flag)
  // 5. Manage loop state (cancelled flag, current loop reference)
}
```

### `types.ts` — Type Definitions

```typescript
export interface RalphLoopState {
  running: boolean;
  iteration: number;
  max_iterations: number;
  started_at: string;
  completed_at: string | null;
  stop_reason: StopReason | null;
  session_id: string;
  last_session_file: string | null;
  error_count: number;
}

export type StopReason =
  | "complete"          // <promise>COMPLETE</promise> detected
  | "max_iterations"    // Reached max_iterations limit
  | "user_cancelled"    // User pressed Ctrl+C twice / session_shutdown
  | "error"             // Unrecoverable provider error (after 3 retries)
  | "manual_stop";      // /ralph-stop command

export interface ParsedArgs {
  task: string;
  maxIterations: number;
}
```

### `parser.ts` — Argument Parsing

Parse the `/ralph-loop` command input. Expected formats:

```
/ralph-loop "task text here" --max-iterations=10
/ralph-loop "task text here" --max-iterations 10
/ralph-loop "task text here"                        ← defaults to 100
/ralph-loop                                         ← error: task required
```

**Rules:**
- Task can be quoted (single or double quotes) or unquoted (everything before `--`)
- `--max-iterations` defaults to `100` if omitted
- Task is required — show a notification error if missing
- Preserve `@file.md` references in the task text exactly as-is (pi will expand them)

### `state.ts` — State File Management

**Functions:**

- `readState(cwd: string): RalphLoopState | null` — Read and parse `.pi/ralph-loop.md`, return `null` if doesn't exist or is malformed
- `writeState(cwd: string, state: RalphLoopState, taskBody: string): void` — Write the state file with frontmatter + body
- `updateState(cwd: string, updates: Partial<RalphLoopState>): void` — Read, merge updates, write back (preserving body)
- `getTaskBody(cwd: string): string | null` — Read just the body (after frontmatter) from the state file

**Implementation notes:**
- Use simple string manipulation for YAML frontmatter (avoid pulling in a YAML library)
- The frontmatter format is simple enough: `key: value` lines between `---` delimiters
- Handle `null` values by writing `null` (no quotes)
- Handle string values by wrapping in double quotes
- Handle boolean/number values without quotes
- Create `.pi/` directory if it doesn't exist

### `loop-engine.ts` — Core Loop Logic

This is the heart of the extension. It runs inside the `/ralph-loop` command handler.

**Function signature:**

```typescript
export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: string,
  maxIterations: number,
  cancelledRef: { value: boolean },
  stoppedRef: { value: boolean },
): Promise<void>
```

**Algorithm:**

```
1. Write initial state: running=true, iteration=1, started_at=now
2. Notify user: "Ralph loop started (max N iterations)"
3. Set footer status: "🔁 Ralph 1/N"

4. FOR iteration = 1 to maxIterations:
   a. IF cancelledRef.value OR stoppedRef.value → break with appropriate stop_reason
   
   b. Update state: iteration = current
   
   c. Create new session:
      result = await ctx.newSession()
      IF result.cancelled → break (extension cancelled the new session)
   
   d. Name the session:
      pi.setSessionName(`Ralph loop iteration ${iteration}/${maxIterations}`)
   
   e. Update state: session_id, last_session_file
   
   f. Send the task prompt:
      pi.sendUserMessage(task)
   
   g. Wait for the agent to finish:
      await ctx.waitForIdle()
   
   h. IF cancelledRef.value OR stoppedRef.value → break
   
   i. Check for errors (inspect last assistant message):
      - Get messages from ctx.sessionManager.getBranch()
      - Find last assistant message
      - IF stopReason === "error":
        - Increment error_count
        - IF error_count for THIS iteration < 3:
          - Send "continue" as a follow-up nudge
          - await ctx.waitForIdle()
          - Go back to step (h) — recheck
        - ELSE: break with stop_reason="error"
   
   j. Check for completion promise:
      - Scan ALL assistant messages in the current session for "<promise>COMPLETE</promise>"
      - IF found:
        - Update state: running=false, completed_at=now, stop_reason="complete"
        - Notify: "Ralph loop complete after N iterations!"
        - Break
   
   k. Update footer status: "🔁 Ralph {iteration+1}/N"
   
   l. Brief delay (500ms) to let state settle

5. IF loop ended without "complete":
   - Determine stop_reason from flags (max_iterations, user_cancelled, manual_stop, error)
   - Update state: running=false, completed_at=now, stop_reason
   - Notify user with appropriate message

6. Clear footer status
```

**Error retry sub-loop detail:**

When `stopReason === "error"` on the last assistant message, it usually means a provider/API error (rate limit, network issue, etc.). Instead of immediately failing the loop:

1. Wait 2 seconds (backoff)
2. Send `pi.sendUserMessage("continue")` to nudge the agent
3. `await ctx.waitForIdle()` again
4. Re-inspect the last assistant message
5. Repeat up to 3 times per iteration
6. If still erroring after 3 retries, set `stop_reason = "error"` and end the loop

**Completion promise detection:**

```typescript
function containsCompletionPromise(entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text.includes("<promise>COMPLETE</promise>")) {
        return true;
      }
    }
  }
  return false;
}
```

---

## Commands

### `/ralph-loop <task> [--max-iterations=N]`

**Description:** Start a Ralph loop — run the given task iteratively in fresh context windows until `<promise>COMPLETE</promise>` is emitted or the maximum iteration count is reached.

**Handler flow:**
1. Check if a loop is already running → error notification if so
2. Parse arguments via `parser.ts`
3. Validate: task must be non-empty, max_iterations must be positive integer
4. Call `runLoop()` from `loop-engine.ts`

**Autocomplete for `--max-iterations`:**
Optionally provide completions: `5`, `10`, `20`, `50`, `100`.

### `/ralph-stop`

**Description:** Stop the currently running Ralph loop after the current iteration finishes.

**Handler:**
1. If no loop running → notification "No Ralph loop is running"
2. Set `stoppedRef.value = true`
3. Notify: "Ralph loop will stop after the current iteration"

### `/ralph-status`

**Description:** Show the current Ralph loop status.

**Handler:**
1. Read `.pi/ralph-loop.md` state file
2. If no state file or not running → "No active Ralph loop"
3. If running → show: iteration, max_iterations, started_at, error_count, session name

---

## Event Subscriptions

### `session_shutdown`

**Purpose:** Detect when pi is exiting (Ctrl+C × 2 or Ctrl+D or SIGTERM). This MUST stop the loop.

```typescript
pi.on("session_shutdown", async (_event, _ctx) => {
  cancelledRef.value = true;
});
```

**Why this works:** The `session_shutdown` event fires when pi is truly exiting. A single Ctrl+C during streaming only aborts the current agent turn (which causes `waitForIdle()` to resolve). But a double Ctrl+C or Ctrl+D triggers shutdown.

### `agent_end` (for abort detection)

**Purpose:** Detect when the agent finishes a turn. Check `stopReason === "aborted"` on the last assistant message to know if the user pressed Ctrl+C to abort the current turn.

When a user aborts a single turn (Ctrl+C once), we want to distinguish between:
- **User explicitly aborting the turn** → should stop the loop (since we're automating, user intervention means "stop")
- **Normal completion** → check for promise and continue

**Implementation:**

After `ctx.waitForIdle()` resolves, inspect the last assistant message in the session. If `stopReason === "aborted"`, treat it as a user cancellation and stop the loop. This is the key safety mechanism that prevents the "cancel starts a new iteration" bug.

```typescript
function wasAborted(ctx: ExtensionCommandContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    return entry.message.stopReason === "aborted";
  }
  return false;
}
```

If `wasAborted()` returns `true`, set `stop_reason = "user_cancelled"` and break the loop.

---

## UI

### Footer Status

During loop execution, show a persistent status in the footer:

```typescript
ctx.ui.setStatus("ralph-loop", theme.fg("accent", `🔁 Ralph ${iteration}/${maxIterations}`));
```

Clear it when the loop ends:

```typescript
ctx.ui.setStatus("ralph-loop", undefined);
```

### Notifications

| Event | Type | Message |
|---|---|---|
| Loop started | `"info"` | `"🔁 Ralph loop started (max N iterations)"` |
| Iteration started | `"info"` | `"🔁 Ralph iteration N/M"` |
| Error retry | `"warning"` | `"⚠️ Provider error, retrying (attempt K/3)..."` |
| Loop completed | `"info"` | `"✅ Ralph loop complete after N iterations!"` |
| Loop stopped (max) | `"warning"` | `"🔁 Ralph loop reached max iterations (N)"` |
| Loop cancelled | `"info"` | `"🛑 Ralph loop cancelled by user at iteration N"` |
| Loop error | `"error"` | `"❌ Ralph loop failed after N iterations: <error>"` |
| Manual stop | `"info"` | `"🛑 Ralph loop stopping after current iteration"` |
| Already running | `"error"` | `"A Ralph loop is already running"` |

---

## Package Configuration

### `package.json`

```json
{
  "name": "pi-ralph-loop",
  "version": "1.0.0",
  "description": "Ralph Wiggum loop extension for pi — iterative task execution with fresh context windows",
  "type": "module",
  "keywords": ["pi-package", "ralph-loop", "ralph-wiggum"],
  "license": "MIT",
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

### Settings Integration

After building, add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/home/devkit/.pi/agent/extensions/pi-ralph-loop"
  ]
}
```

Or use the existing packages array with a local path source.

---

## Testing Plan

### Test 1: Basic 2-Iteration Loop

```
/ralph-loop "Create a file called hello.txt with 'Hello World'. Then output <promise>COMPLETE</promise>" --max-iterations=3
```

**Expected:** Creates hello.txt in iteration 1, emits completion promise, loop stops at iteration 1. State file shows `running: false`, `stop_reason: complete`, `completed_at` is set.

### Test 2: Multi-Iteration Without Completion

```
/ralph-loop "Echo the current date to date.log and append a newline. Do NOT output any promises." --max-iterations=2
```

**Expected:** Runs 2 iterations, each in a fresh session. State file shows `running: false`, `stop_reason: max_iterations`, `iteration: 2`.

### Test 3: User Cancellation (Ctrl+C during streaming)

```
/ralph-loop "Write a very long essay about quantum physics. Be extremely verbose." --max-iterations=5
```

During streaming, press Ctrl+C once to abort the turn.

**Expected:** Loop stops, does NOT start a new iteration. State shows `stop_reason: user_cancelled`.

### Test 4: `/ralph-stop` Command

```
/ralph-loop "Create a file called iteration-N.txt for the current iteration number. Never output <promise>COMPLETE</promise>." --max-iterations=20
```

While running, type `/ralph-stop` in the editor.

**Expected:** Current iteration finishes, then loop stops. State shows `stop_reason: manual_stop`.

### Test 5: Session Naming

After running a loop, check `/resume` to verify sessions are named `Ralph loop iteration 1/N`, `Ralph loop iteration 2/N`, etc.

### Test 6: State File Accuracy

During a loop, read `.pi/ralph-loop.md` in another terminal. Verify:
- `running: true` during execution
- `iteration` increments correctly
- `session_id` and `last_session_file` update per iteration
- `started_at` is set once at the beginning
- `completed_at` is `null` during execution, set when done

### Test 7: Headless Test (Print Mode)

```bash
pi -p "/ralph-loop \"echo hello && echo '<promise>COMPLETE</promise>'\" --max-iterations=2"
```

Verify it works in non-interactive mode (UI methods are no-ops but logic works).

### Test 8: Desloppify

```bash
cd /home/devkit/.pi/agent/extensions/pi-ralph-loop
pip install --upgrade "desloppify[full]"
desloppify update-skill claude
desloppify scan --path .
desloppify next
# Fix all issues until clean
```

---

## Edge Cases

1. **Loop already running:** If `/ralph-loop` is invoked while a loop is active, reject with notification.
2. **State file from a previous run:** If `.pi/ralph-loop.md` exists with `running: true` from a crashed session, detect on startup (via `session_start` event) and reset `running` to `false`.
3. **Empty task:** Reject with a clear error message.
4. **`ctx.newSession()` cancelled by another extension:** Treat as a cancellation, stop the loop.
5. **No assistant messages after `waitForIdle()`:** Possible if session is empty — treat as an error.
6. **The task contains `<promise>COMPLETE</promise>` literally:** This is fine — the check is on assistant messages only, not the user prompt.
7. **`@file` references in the task:** Preserve as-is. Pi's prompt expansion handles `@file` references when the user message is sent via `sendUserMessage()`.
8. **Very long task text:** No truncation — pass through as-is.
9. **`max_iterations=0` or negative:** Reject with validation error.
10. **Pi exits abnormally (SIGKILL):** State file may show `running: true`. On next `session_start`, detect and reset.

---

## Implementation Notes

### Key API Methods Used

From `ExtensionAPI` (available in extension factory and closures):

| Method | Purpose |
|---|---|
| `pi.registerCommand(name, options)` | Register `/ralph-loop`, `/ralph-stop`, `/ralph-status` |
| `pi.on(event, handler)` | Subscribe to `session_shutdown`, `session_start` |
| `pi.sendUserMessage(content)` | Send the task prompt as a user message (triggers a turn) |
| `pi.setSessionName(name)` | Name sessions for `/resume` selector |
| `pi.getSessionName()` | Check current session name |
| `pi.appendEntry(customType, data)` | Persist extension state in session |

From `ExtensionCommandContext` (available ONLY in command handlers):

| Method | Purpose |
|---|---|
| `ctx.newSession(options?)` | Create a fresh session (new context window) |
| `ctx.waitForIdle()` | Wait for agent to finish streaming |
| `ctx.sessionManager.getBranch()` | Get entries in the current branch (for inspecting messages) |
| `ctx.sessionManager.getSessionId()` | Get current session UUID |
| `ctx.sessionManager.getSessionFile()` | Get current session file path |
| `ctx.ui.notify(msg, type)` | Show notifications |
| `ctx.ui.setStatus(key, text)` | Set footer status |
| `ctx.cwd` | Current working directory (for state file location) |
| `ctx.hasUI` | Check if interactive mode is active |
| `ctx.isIdle()` | Check if agent is currently idle |

### Shared Mutable Refs

The command handler spawns a long-running loop. Other parts of the extension (event handlers, other commands) need to signal the loop. Use simple mutable reference objects:

```typescript
const cancelledRef = { value: false };
const stoppedRef = { value: false };
```

These are closed over by the `session_shutdown` handler and the `/ralph-stop` command, and checked inside the loop.

### Thread Safety

Pi is single-threaded (Node.js event loop). No mutex needed. The `cancelledRef` and `stoppedRef` flags are set synchronously in event handlers and checked between async operations in the loop.

### Session Lifecycle During Loop

Each iteration:
1. `ctx.newSession()` → This switches the session. The old session is saved to disk automatically.
2. `pi.setSessionName()` → Names the new session.
3. `pi.sendUserMessage(task)` → Sends the prompt. This triggers the agent loop.
4. `ctx.waitForIdle()` → Blocks (async) until the agent finishes all turns.
5. `ctx.sessionManager.getBranch()` → Inspects messages in the completed session.

After `ctx.newSession()`, all `ctx.sessionManager.*` calls operate on the NEW session.

### Error Detection via `stopReason`

From `session.md`, `AssistantMessage.stopReason` can be:
- `"stop"` — Normal completion
- `"length"` — Max tokens reached
- `"toolUse"` — Model wants to call tools (intermediate)
- `"error"` — Provider/API error
- `"aborted"` — User abort (Ctrl+C)

For our purposes:
- `"error"` → trigger retry logic
- `"aborted"` → stop the loop (user intervention)
- `"stop"` or `"length"` → check for completion promise, continue if not found

---

## Anti-Patterns to Avoid

1. **DO NOT keep iterations in the same session.** This defeats the entire purpose of Ralph. Each iteration MUST get a fresh context window via `ctx.newSession()`.

2. **DO NOT use `pi.sendMessage()` with `triggerTurn: true` for the loop prompt.** Use `pi.sendUserMessage()` instead — it creates a proper user message.

3. **DO NOT call `ctx.newSession()` from event handlers.** It's only available on `ExtensionCommandContext` (command handlers). The loop MUST run inside the `/ralph-loop` command handler.

4. **DO NOT ignore the abort flag.** Always check `cancelledRef`/`stoppedRef` between operations. After every `await`, re-check.

5. **DO NOT parse YAML with regex for complex cases.** Keep the frontmatter format simple (flat key-value pairs, no nested objects, no arrays) so string manipulation works reliably.

6. **DO NOT block the event loop.** All file I/O should be synchronous (for simplicity) but brief. The `await` points are `ctx.newSession()`, `ctx.waitForIdle()`, and `sleep()`.

---

## Quality Standards (Desloppify)

After implementation, run:

```bash
pip install --upgrade "desloppify[full]"
desloppify update-skill claude
desloppify scan --path /home/devkit/.pi/agent/extensions/pi-ralph-loop
desloppify next
```

Follow each `next` recommendation. Fix issues properly — no gaming. Target the highest possible strict score by:

- Clear, descriptive variable names
- No `any` types (use proper TypeScript types)
- Error handling for all I/O operations
- No dead code
- Consistent formatting
- JSDoc comments on exported functions
- No magic numbers (use named constants)
