---
name: ralph-plan-writer
description: Creates a Ralph execution bundle from a user goal and optional source planning docs such as PRDs and SPECs. Use when the user wants a Ralph loop plan, a fresh-context execution bundle, `.ralph/plan.md`, `.ralph/items.json`, `.ralph/prompt.md`, `.ralph/progress.md`, or asks to derive a Ralph/AFK/autonomous loop from a PRD, SPEC, or implementation goal.
disable-model-invocation: true
---

# Ralph Plan Writer

Write a Ralph Wiggum loop-compatible plan, but do not execute it.

A Ralph Wiggum loop is a fresh-context coding loop. The runner sends the same bundle prompt into a new agent session each iteration. The agent does not continue from chat memory. It rebuilds context from files and git history, completes one verified item, records the handoff, makes one commit, then emits a promise tag that tells the runner whether to continue or stop.

The point is not repetition for its own sake. The point is to make progress through durable repo state instead of a long live conversation. The item list holds scope. The progress file carries handoff notes. Git commits create checkpoints. Verification gates give the agent feedback it cannot argue with. Promise tags give the runner a small control protocol.

Do not design the loop around a long session or compaction. A long session collects stale plans, failed attempts, noisy tool output, and abandoned reasoning. Compaction compresses that mess after the fact and can erase details the next step needs. Ralph keeps the active reasoning surface clean by starting fresh and rereading only the durable facts.

Generate exactly four files:

1. `.ralph/plan.md`
2. `.ralph/items.json`
3. `.ralph/prompt.md`
4. `.ralph/progress.md`

The exact prompt reference in the final response enables bundle mode. Bundle mode validates the four files, snapshots item/progress/source-doc/git state before each iteration, rejects invalid NEXT/COMPLETE promises, and starts the next fresh session only after the contract passes.

## Missing goal

If the user did not provide a concrete goal, ask exactly:

```text
What should I plan for the Ralph loop?
```

## Why Ralph uses fresh iterations

Modern models may have 200K to 1M token windows, but more tokens still mean more competing context. Ralph treats files as the memory boundary so each iteration starts clean, reads the current facts, picks one item, proves it, commits it, and exits with a promise tag.

## Source docs

Treat PRD/SPEC documents as immutable source planning docs unless the user asks you to edit them.

Read every PRD/SPEC path the user provides or references before generating files. Use PRDs for product intent, user-facing scope, and priorities. Use SPECs for implementation constraints, technical boundaries, and verification details.

List source doc paths in `.ralph/items.json` under `runtime_contract.source_docs`. Use `[]` for goal-only bundles.

## Conditional references

Read platform/topology references only when the task involves that platform or topology:

| Reference | Use when |
| --- | --- |
| `references/platforms/windows.md` | Windows host, Windows app/runtime, PowerShell/cmd, Win32 apps, WebView2, tray/hotkey behavior, UAC, Windows packaging, or Windows-only tooling |
| `references/platforms/linux.md` | Linux distros, package managers, services, device/runtime dependencies, display/audio stacks, `sudo`, root, or Linux packaging |
| `references/platforms/macos.md` | macOS packaging, Homebrew, Xcode tools, codesign/notarization, accessibility permissions, launchd, or Apple runtime constraints |
| `references/topologies/windows-wsl-interop.md` | WSL, UNC paths, `wsl.exe`, `wslpath`, Windows tools launched from WSL, Windows↔WSL localhost behavior, inherited elevation, or mixed Windows/WSL execution |

Read `foundations/` when you need more Ralph Wiggum loop background, feel uncertain about the technique, want deeper source grounding, are revising this skill, or are auditing Ralph doctrine.

## Platform facts

When platform or topology matters, resolve:

- execution host OS
- target app/runtime OS
- authoritative verification environment
- privilege model: `admin`, `sudo`, `root`, or forbidden
- path translation, staging, or cross-boundary handoff needs

Ask or inspect when those facts are unclear. Record confirmed constraints in `.ralph/plan.md`. Add only necessary startup checks to `.ralph/prompt.md`.

## Item design

Each item must describe one behavior-visible outcome with concrete verification steps. Keep it small enough for one clean commit and one full verification pass.

Do not hard-code a fixed item order. The runtime agent should act like a senior engineer choosing a card from a kanban board after reading the plan, item list, progress, git history, and repo state.

Good reasons to choose an item: architectural risk, integration risk, unblocking later work, validating an assumption, recent repo changes that make the item cheaper, or cleaning up a regression before new feature work.

## `.ralph/plan.md`

Use this header skeleton:

```md
# Execution Plan: [GOAL]

## Source Inputs

## Objective

## Scope In

## Scope Out

## Constraints

## Prioritization Strategy

## Completion Definition
```

Include source input type, assumptions, platform/topology constraints when relevant, and completion criteria. Reference `.ralph/items.json` as the source of truth for item status.

## `.ralph/items.json`

Generate valid JSON with this shape:

```json
{
  "version": 1,
  "runtime_contract": {
    "source_docs": [],
    "verification_gates": [
      { "name": "[gate name]", "command": "[repo verification command]" }
    ],
    "require_progress_append": true,
    "require_one_item_per_iteration": true,
    "require_clean_source_docs": true,
    "commit_policy": "exactly_one"
  },
  "items": [
    {
      "category": "functional",
      "description": "[feature description]",
      "steps": ["[end-to-end user step 1]", "[end-to-end user step 2]"],
      "passes": false,
      "regression_notes": ""
    }
  ]
}
```

Rules:

- Include `runtime_contract`.
- Put every source PRD/SPEC path in `source_docs`. Use `[]` for goal-only bundles.
- Put every required verification command in `verification_gates`.
- Use empty `verification_gates` only when the repo has no executable verification command. Record that limitation in `.ralph/plan.md` and `.ralph/prompt.md`.
- Set `require_progress_append`, `require_one_item_per_iteration`, and `require_clean_source_docs` to `true`.
- Set `commit_policy` to one of: `none`, `optional`, `exactly_one`, `at_least_one`.
- Use `exactly_one` for normal one-item feature loops.
- Use `at_least_one` when an item may need checkpoint commits.
- Use `optional` for exploratory or patch-only loops.
- Use `none` for read-only, audit, or reporting loops where commits would be wrong.
- For greenfield loops with commit enforcement, tell the runtime agent to initialize git during the first iteration.
- Do not delete items after creation.
- Do not rewrite `description` or `steps` after creation.
- Move `passes` to `true` only after end-to-end verification.
- If a passing item regresses, set `passes` back to `false` and explain in `regression_notes`.

## `.ralph/progress.md`

Create this file empty. The runtime agent will append one handoff entry per iteration.

## `.ralph/prompt.md`

Make the prompt self-contained for a fresh context window. Do not assume the runtime model knows Ralph by name.

It must instruct the runtime agent to:

- read `.ralph/plan.md`, `.ralph/items.json`, and `.ralph/progress.md` first
- inspect recent git history and current repo state
- choose one unfinished item using engineering judgment
- work only on that item
- run every required verification gate
- update `.ralph/items.json` by changing `passes` and `regression_notes` only
- append one `.ralph/progress.md` entry with the item, decision rationale, changed files, verification results, and next-iteration notes
- preserve source PRD/SPEC docs unless the user allowed edits
- follow `runtime_contract.commit_policy`; initialize git during the first iteration when commits are required and no git repo exists
- end with one promise tag on the last non-empty line

Promise rules:

- Emit `<promise>NEXT</promise>` only after one item passes, all required checks pass, progress was appended, protected source docs stayed clean, and the commit policy was satisfied.
- Emit `<promise>COMPLETE</promise>` only after every item passes and all required checks pass. If COMPLETE only verifies an already-finished bundle, it does not need to append progress.

Ban bypasses in the runtime prompt: no skipped checks, no weakened tests, no `--no-verify`, no `|| true`, no suppressed failures, no deleted tests, and no success claims without executed command evidence.

## Runtime enforcement to account for

The extension rejects NEXT if zero or multiple items move from `passes:false` to `passes:true`, immutable item fields change, progress append checks fail, protected source docs change, configured verification gates fail, or the configured commit policy fails.

The extension rejects COMPLETE if any item has `passes:false`, immutable item fields change, progress/source-doc checks fail, verification gates fail, or the configured commit policy fails.

Rejected promises continue in the same session with a corrective prompt. Accepted NEXT starts the next fresh session. Accepted COMPLETE ends the loop.

## Final response

After writing the four files, respond with exactly this shape and no extra commentary:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=n
```

Choose a bounded `n` from the item count and expected iteration risk.
