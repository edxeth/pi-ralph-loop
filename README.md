# pi-ralph-loop

`pi-ralph-loop` turns Geoffrey Huntley's Ralph Wiggum loop technique into a Pi extension on steroids.

Ralph, in its purest form, is a bash loop: run a coding agent, let it read the plan, make one useful change, commit, and repeat. That simplicity is the point. Raw bash still leaves you to build the boring parts yourself: resume, stop, status, promise parsing, fresh-session handoff, progress tracking, bundle validation, and safety gates.

This extension gives Ralph a native Pi runtime. It also ships `ralph-plan-writer`, an opinionated skill that turns a goal, PRD, SPEC, or messy implementation idea into a ready-to-run Ralph plan, aka `.ralph/` bundle.

Use the bundled agent skill when you want a Ralph planner out of the box. Use plain `/ralph-loop` when you want to bring your own prompt.

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

## Install

```bash
pi install git:github.com/edxeth/pi-ralph-loop
```

## Why Ralph Wiggum loop works

A coding agent starts each session sharp. It has a local job, a clean prompt, and enough context to move.

Then the transcript fills with tool output, failed attempts, old reasoning, stale plans, and half-true assumptions. The model keeps seeing all of it. Past a point, more context makes the next decision worse.

Ralph exits before that decay dominates. Each iteration does one verified unit of work, writes durable state, commits, and leaves. The next iteration starts fresh and reloads only the facts that survived into files and git history.

That is the trick: throw away live context, keep durable evidence.

## Why this extension exists

A raw Ralph loop can be one shell script. That works until you want to run it overnight.

`pi-ralph-loop` adds the parts AFK runs need:

- fresh Pi sessions per iteration
- `/ralph-stop`, `/ralph-status`, `/ralph-resume`, and `/ralph-restart` commands
- persisted loop state in `.ralph/loop.md`
- promise nudges when the agent forgets the final control tag
- runtime checks for item mutation, progress append, verification gates, commits, and protected source docs
- the bundled `ralph-plan-writer` skill

## Start with the plan writer

```text
/skill:ralph-plan-writer Build the execution bundle for this goal: <goal>
```

The skill asks where the Ralph plan should be created. The selected path becomes the Ralph workspace root: `.ralph/` lives there, work happens there, verification commands run there, and commits are counted there.

It writes:

```text
.ralph/plan.md
.ralph/items.json
.ralph/prompt.md
.ralph/progress.md
```

Then run this from the Ralph workspace root:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=20
```

If the skill was invoked from a different directory, start Pi in the selected Ralph workspace root before running the command.

The plan writer reads the goal, optional PRD/SPEC files, repo state, git history, verification commands, and system constraints. Then it writes the facts Ralph needs into `.ralph/`.

The repo stays the source of truth. PRDs and SPECs help create the bundle; they do not become another document the runtime agent must keep rereading. If you want a custom loop where the agent reads those files every iteration, write that into your own prompt.

### System preflight

The plan writer blocks unsafe system-level loops before they start.

For plans that depend on `sudo`, admin, services, installers, GUI permissions, devices, packaging, Windows/WSL boundaries, or unattended verification, it gathers safe facts first. It may inspect the host, shell, package manager, path translation, tool availability, and non-interactive privilege state.

It must not install packages, mutate services, start privileged workflows, or trigger permission dialogs unless you approve that planning action.

If the loop would spin on an unresolved host, permission, or verification blocker, the skill should not write a `.ralph/` bundle.

## Bring your own Ralph prompt

You can skip the plan writer and run your own loop prompt:

```text
/ralph-loop "@PLAN.md @progress.md Pick one unfinished task, implement it, verify it, update progress, commit, then end with <promise>NEXT</promise>. End with <promise>COMPLETE</promise> when everything is done." --max-iterations=10
```

Your prompt should tell the agent to:

- read the plan and progress file
- choose one item
- make one coherent change
- run the checks
- update progress
- commit
- end with a promise tag on the last non-empty line

That is enough to Ralph. Bundle mode adds stronger runtime checks.

## Promise tags

Ralph reads the last non-empty line of the assistant response.

| Tag | Meaning |
| --- | --- |
| `<promise>NEXT</promise>` | This iteration finished one unit of work. Start the next fresh session. |
| `<promise>COMPLETE</promise>` | The whole loop is done. Stop successfully. |
| `<promise>STOP</promise>` | Stop the loop without calling it complete. |

If the agent omits a tag, Ralph nudges it to continue. After repeated misses, Ralph stops with an error instead of looping forever.

## Bundle mode, if you write it yourself

Skip this section if you use `ralph-plan-writer` or a plain `/ralph-loop` prompt.

Bundle mode starts when the task points at `.ralph/prompt.md`, including `@.ralph/prompt.md` and `@./.ralph/prompt.md`. In that mode Ralph validates `.ralph/items.json` instead of trusting the agent's final message alone.

Minimum `.ralph/items.json`:

```json
{
  "version": 1,
  "items": [
    {
      "category": "functional",
      "description": "User-visible behavior to complete.",
      "steps": ["Run the end-to-end verification."],
      "passes": false,
      "regression_notes": ""
    }
  ]
}
```

Add `runtime_contract` when you want stricter gates:

```json
{
  "runtime_contract": {
    "verification_gates": [
      { "name": "tests", "command": "npm test" }
    ],
    "require_progress_append": true,
    "require_one_item_per_iteration": true,
    "require_commit": true
  }
}
```

Useful `runtime_contract` fields:

| Field | Effect |
| --- | --- |
| `verification_gates` | Commands Ralph runs before accepting `NEXT` or `COMPLETE`. |
| `require_progress_append` | `NEXT` requires `.ralph/progress.md` to grow. |
| `require_one_item_per_iteration` | `NEXT` requires exactly one item to move from `passes:false` to `passes:true`. |
| `require_commit` | When `true`, `NEXT` and `COMPLETE` require git HEAD to change during the iteration. Omit or set `false` when commits are not required. |
| `source_docs` + `require_clean_source_docs` | Optional file-protection gate. Omit unless you want Ralph to reject edits to listed files. |

`NEXT` means one item passed and the required checks passed, meaning it's time to move on to the next loop iteration. `COMPLETE` means every item passed and the required checks passed, hence the task and all its items are completed, no more work left to do. Rejected promises stay in the same session with a corrective prompt.

## Commands

### `/ralph-loop <task> [--max-iterations=N]`

Start a loop. Default max iterations: `100`.

### `/ralph-resume [--force]`

Resume the saved loop from `.ralph/loop.md`. Use `--force` to resume a completed run.

Resume adapts to where it runs. From the same Pi session that owns the saved iteration, it does not re-send the prompt (the agent already has it). Instead it reads the last assistant turn: if a promise was already emitted, it acts on it (`COMPLETE`/`STOP` end the loop, `NEXT` advances to the next fresh iteration); if no promise was emitted yet, it nudges `continue` so the agent finishes the in-progress unit. From any other session, it restarts the saved iteration in a fresh session.

### `/ralph-restart`

Restart the saved loop from iteration 1 with the same prompt and max-iteration limit.

### `/ralph-stop`

Stop after the current iteration finishes.

### `/ralph-status`

Show iteration, elapsed time, and error state.

## Loop state

Ralph writes `.ralph/loop.md`. The YAML frontmatter is runtime state, not a user-authored config file, but these fields help when you inspect or recover a run.

| Field | Meaning |
| --- | --- |
| `running` | Whether Ralph considers the loop active. |
| `iteration` | Current iteration number. |
| `max_iterations` | Iteration cap from `/ralph-loop`. |
| `started_at` / `completed_at` | Run timestamps. |
| `stop_reason` | `complete`, `max_iterations`, `user_cancelled`, `manual_stop`, `error`, or `null`. |
| `session_id` | Pi session that owns the current iteration. |
| `last_session_file` | Last known Pi session file. |
| `error_count` | Provider/session error count. |
| `transitioning` | Ralph is between sessions. |
| `cancel_requested` / `stop_requested` | User stop flags. |
| `bundle_mode` | Whether `.ralph/prompt.md` bundle checks apply. |
| `loop_token` | Run identity used to avoid stale transitions. |
| `bundle_*`, `items_*`, `progress_*`, `source_doc_hashes`, `git_head` | Bundle snapshots used to validate promises. |
| `bundle_rejection_count` | Rejected bundle promises in the current iteration. |
| `limit_reminders` | Context-limit reminder thresholds already sent in the current iteration. |

The prompt body lives below the frontmatter. `/ralph-resume` and `/ralph-restart` reuse it.

## Safety

While a loop runs, the extension blocks `/resume`, `/new`, `/fork`, and `/tree` in that Pi instance. Open another Pi instance to inspect old iterations while Ralph keeps running.

Ralph waits through provider retry handling and missing terminal stop reasons instead of advancing early. User aborts stop the loop before the next iteration starts. Stale state resets on startup.

When a running iteration reaches 75%, 80%, and 85% of the active model context window, Ralph sends a hidden `ralph_limit` Pi custom message reminding the agent to preserve the original instructions and use the existing `NEXT` or `COMPLETE` promise contract when appropriate. Set `RALPH_LIMIT_REMINDERS_DISABLED=1` to opt out.

## Development

```bash
npm test
npm run test:live
```

`npm test` covers parser, state persistence, command/event wiring, bundle gates, and loop orchestration.

`npm run test:live` runs live RPC integration tests against Pi. See [tests/live-e2e-testing.md](tests/live-e2e-testing.md) for the live-test workflow.

## Credits

- [Geoffrey Huntley](https://github.com/ghuntley), creator of the Ralph Wiggum loop technique
- [Matt Pocock](https://github.com/mattpocock), author of Ralph workflow guidance
- [Anthropic](https://github.com/anthropics), long-running-agent harness research

## License

MIT
