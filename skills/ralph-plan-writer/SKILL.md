---
name: ralph-plan-writer
description: Write a Ralph loop-compatible plan.
disable-model-invocation: true
---

# Ralph Plan Writer

Write a Ralph Wiggum loop-compatible plan, but do not execute it.

## Activation semantics

When this skill is invoked, loaded, pasted, or appears immediately before a user request, treat the user's next concrete request as the goal for a Ralph bundle.

Imperatives like "build X", "fix Y", or "create Z" define the goal. They are not permission to execute the work.

Do not install dependencies, scaffold projects, edit app code, start services, or implement the goal. Only inspect enough repo state and docs to write the Ralph bundle.

Never execute the generated plan or goal in this conversation. The bundle is meant to run in a separate Pi session with fresh context through `/ralph-loop`.

If the user explicitly asks to execute instead of plan, say this skill only writes the bundle and the work should run separately.

## Technique doctrine

Geoffrey Huntley created the Ralph Wiggum loop technique. Treat Huntley's Ralph philosophy as the primary source: Ralph is a loop you program. Keep it monolithic: one repository, one bundle prompt, one runtime agent, one verified item per iteration. Do not turn the loop into agent microservices, a long chat, or a compaction-dependent session.

The supporting long-running-agent material documents the same harness failure modes: agents one-shot too much work, lose handoff context, declare the project done early, or mark work passing without end-to-end proof. Ralph counters those failures with durable files, git checkpoints, verification gates, and promise tags.

The plan writer acts as the initializer. It distills the user's goal, source docs, repo state, verification path, and system preflight into a small runtime protocol. The runtime agent starts fresh each iteration, reads durable state, chooses one unfinished item, proves it, appends progress, commits, and exits.

Exit after one verified item because live context decays. A session starts in a hot context zone where the agent knows its local move; after enough edits, tool output, failed attempts, and stale reasoning, that same context becomes a dumb context zone. A fresh iteration drops the live noise and forces the next agent to reload durable facts from files, git history, progress, and item state.

When you can predict a failure mode, tune the loop before launch. Add a smaller item, verification gate, startup check, assumption, or blocker. Do not spend loop iterations discovering preventable host, permission, scope, or test failures.

Generate exactly four files:

1. `.ralph/plan.md`
2. `.ralph/items.json`
3. `.ralph/prompt.md`
4. `.ralph/progress.md`

The exact prompt reference in the final response enables bundle mode. Bundle mode validates the four files, snapshots item/progress/source-doc/git state before each iteration, rejects invalid NEXT/COMPLETE promises, and starts the next fresh session only after the contract passes. Do not offer to start implementing the plan in the current session.

## Missing goal

A concrete imperative request counts as a goal. Example: "Build a todo app" means write a Ralph bundle for building it, not build it now.

If the user did not provide a concrete goal, ask exactly:

```text
What should I plan for the Ralph loop?
```

## Before writing the bundle

Do not generate a Ralph bundle from vague context. If the goal, PRD, SPEC, repo state, or verification path is unclear, gather more information before writing the four files.

Use the tools and skills available in the current session: inspect the codebase, read related docs, check package scripts and tests, inspect recent git history, research third-party APIs or platform behavior when needed, and ask the user when ambiguity affects scope or correctness. Iterating on assumptions and plan shape before writing `.ralph/` files is good; the final bundle must be self-contained and stable.

## Source docs

Treat PRD/SPEC documents as immutable source planning docs unless the user asks you to edit them.

Read every user-provided PRD/SPEC path before generating files. Follow linked in-repo planning files that affect implementation. Classify by content, not filename: PRD-like content gives product intent; SPEC-like content gives implementation constraints; mixed docs can give both.

Use source docs to create a new AFK Ralph bundle. `.ralph/plan.md` and `.ralph/items.json` own execution. Prefer the user's requested outcome over planning-tool boilerplate. Do not inline source document contents into the Ralph files.

Default to distilled-only bundles: read PRD/SPEC files while writing the bundle, then leave `runtime_contract.source_docs` empty. Use `source_docs` only when the user asks for provenance/protection mode.

When translating source docs into a Ralph-compatible plan:

1. Inventory source paths and relevant linked planning files.
2. Extract durable facts: objective, users, scope, non-goals, acceptance criteria, constraints, interfaces, edge cases, dependencies, and verification signals.
3. Drop planning-tool workflow metadata unless the user requested it.
4. Convert acceptance criteria and constraints into Ralph items with one observable outcome and concrete end-to-end `steps`.
5. Choose verification gates from usable repo commands and source verification signals. Do not invent commands.
6. Record conflicts, assumptions, and omitted workflow metadata in `.ralph/plan.md` only when they affect AFK safety or item scope. Ask the user when a conflict would change scope.

## Conditional references

Read platform/topology references only when the plan touches system-level setup, permissions, host/runtime boundaries, packaging, services, installers, devices, GUI automation, or cross-OS execution. Do not read them for ordinary app-code plans.

| Reference | Use when |
| --- | --- |
| `references/platforms/windows.md` | Windows host/runtime, PowerShell/cmd, UAC/admin, Win32 apps, WebView2, tray/hotkeys, services, installers, or Windows packaging |
| `references/platforms/linux.md` | Linux host/runtime setup, distro packages, services, daemons, devices, display/audio, containers, `sudo`, root, or Linux packaging |
| `references/platforms/macos.md` | macOS host/runtime setup, Homebrew, Xcode tools, codesign/notarization, GUI permissions, launchd, app bundles, or Apple runtime constraints |
| `references/topologies/windows-wsl-interop.md` | WSL, UNC paths, `wsl.exe`, `wslpath`, Windows tools launched from WSL, Windows↔WSL localhost behavior, inherited elevation, or mixed Windows/WSL execution |

When you need Ralph Wiggum loop background, feel uncertain about the technique, want deeper source grounding, are revising this skill, or are auditing Ralph doctrine, read `philosophy/` files in numbered order:

1. `philosophy/001-intro-to-ralph-loop-by-geoffrey-huntley.md`
2. `philosophy/002-ralph-as-engineer-by-geoffrey-huntley.md`
3. `philosophy/003-long-running-agents-by-anthropic.md`
4. `philosophy/004-tips-for-ralph-loops-by-matt-pocock.md`
5. `philosophy/005-anthropic-plugin-sucks-by-matt-pocock.md`
6. `philosophy/006-ralph-biggest-name-in-ai-by-venturebeat.md`

## System preflight

System-level Ralph loops must not discover basic host, permission, or runtime blockers after the loop starts. Before writing the bundle, resolve:

- execution host OS, target runtime OS, and authoritative verification host
- required privilege model: admin, `sudo`, root, forbidden, or pre-provisioned outside the loop
- package manager, installer, daemon, service, device, GUI permission, signing, or packaging requirements
- path translation, staging, localhost, or cross-boundary handoff needs
- verification commands that can run unattended without passwords, dialogs, UAC prompts, or missing hardware

Run only safe preflight checks during planning. Do not install packages, mutate services, start privileged workflows, or trigger interactive permission prompts unless the user explicitly approves that planning action.

If unresolved system uncertainty could make the Ralph loop spin, do not write the four `.ralph/` files. Inspect more, research more, or ask the user. Encode confirmed constraints in `.ralph/plan.md`; add startup checks to `.ralph/prompt.md` only for facts the runtime agent must revalidate.

## Item design

Each item must describe one behavior-visible outcome with concrete verification steps. Keep it small enough for one clean commit and one full verification pass.

Build items from acceptance criteria and technical constraints, not source-document task order. Convert source checklist entries into the smallest verifiable behavior slices. Omit workflow metadata.

Do not hard-code item order. The runtime agent chooses one unfinished item after reading the plan, item list, progress, git history, and repo state.

Prefer items that reduce architectural risk, integration risk, blocked work, unverified assumptions, or regressions.

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
    "commit_policy": "exactly_one",
    "git_root": "."
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
- Keep `source_docs` empty for distilled-only bundles.
- Put PRD/SPEC paths in `source_docs` only for provenance/protection mode.
- Put every required verification command in `verification_gates`.
- Use empty `verification_gates` only when the repo has no executable verification command. Record that limit in `.ralph/plan.md` and `.ralph/prompt.md`.
- Set `require_progress_append` and `require_one_item_per_iteration` to `true`.
- Omit `require_clean_source_docs` by default.
- Set `require_clean_source_docs` to `true` only for explicit provenance/protection mode with non-empty `source_docs`.
- Set `commit_policy` to one of: `none`, `optional`, `exactly_one`, `at_least_one`.
- Use `exactly_one` for normal one-item feature loops.
- Use `at_least_one` when an item may need checkpoint commits.
- Use `optional` for exploratory or patch-only loops.
- Use `none` for read-only, audit, or reporting loops where commits would be wrong.
- Set `git_root` when commits should be counted outside the `.ralph/` workspace root. Use `"."` when the bundle root owns git. Use a relative subdirectory such as `"discord-clone"` when the runtime agent initializes and commits inside that app directory.
- For greenfield loops with commit enforcement, tell the runtime agent to initialize git in `runtime_contract.git_root` during the first iteration.
- Do not delete items after creation.
- Do not rewrite `description` or `steps` after creation.
- Move `passes` to `true` only after end-to-end verification.
- If a passing item regresses, set `passes` back to `false` and explain in `regression_notes`.

## `.ralph/progress.md`

Create this file empty. The runtime agent will append one handoff entry per iteration.

## `.ralph/prompt.md`

Make the prompt self-contained for a fresh context window. Do not assume the runtime model knows Ralph by name.

Instruct the runtime agent to:

- read `.ralph/plan.md`, `.ralph/items.json`, and `.ralph/progress.md` first
- ignore PRD/SPEC source files unless `runtime_contract.source_docs` lists paths
- when `source_docs` lists paths, treat them as protected secondary evidence; read them only when the selected item needs clarification
- inspect recent git history and current repo state
- choose one unfinished item using `.ralph/plan.md` prioritization
- treat `.ralph/items.json` as the only authoritative Ralph item list
- ignore any secondary task source, todo list, issue queue, planner state, chat memory, or harness-local task tracker when choosing Ralph work
- use secondary planners or harness-local task trackers, if present, only for the already-selected item and never to choose or start another item
- follow `.ralph/plan.md` and `.ralph/items.json` when source docs conflict with the generated bundle
- work only on that item
- run every required verification gate
- update `.ralph/items.json` by changing `passes` and `regression_notes` only
- append one `.ralph/progress.md` entry with the item, decision rationale, changed files, verification results, and next-iteration notes
- preserve files listed in `runtime_contract.source_docs` unless the user allowed edits
- follow `runtime_contract.commit_policy`; initialize git in `runtime_contract.git_root` during the first iteration when commits are required and no git repo exists
- end with one promise tag on the last non-empty line

Promise rules:

- Emit `<promise>NEXT</promise>` only after one item passes, all required checks pass, progress was appended, listed source docs stayed clean when `source_docs` is non-empty, and the commit policy was satisfied.
- Emit `<promise>COMPLETE</promise>` only after every item passes and all required checks pass. If COMPLETE only verifies an already-finished bundle, it does not need to append progress.

Terminal boundary rules:

- Treat a valid promise tag as the handoff to the loop harness, not as a progress report.
- As soon as the selected item is marked passing in the current invocation, stop implementation work. From that point, only finalize the same iteration.
- Finalizing the same iteration means only: run required verification gates, update `.ralph/items.json`, append `.ralph/progress.md`, satisfy `runtime_contract.commit_policy`, verify the commit state when commits are required, and emit the required promise tag.
- While finalizing the same iteration, do not choose another item, plan another item, inspect files for another item, edit source files for another item, update any secondary task tracker for another item, or explain what comes next.
- The final response for a successful one-item iteration must be exactly one promise tag on the last non-empty line.

Boundary example:

```text
Wrong: Item 1 passed. Next I will work on Item 2.
Right: <promise>NEXT</promise>
```

Ban bypasses in the runtime prompt: no skipped checks, weakened tests, `--no-verify`, `|| true`, suppressed failures, deleted tests, or success claims without command evidence.

## Runtime enforcement to account for

The extension rejects NEXT if zero or multiple items move from `passes:false` to `passes:true`, immutable item fields change, progress append checks fail, listed source docs change when `source_docs` is non-empty, configured verification gates fail, or the configured commit policy fails in `runtime_contract.git_root`.

The extension rejects COMPLETE if any item has `passes:false`, immutable item fields change, progress checks fail, listed source docs change when `source_docs` is non-empty, verification gates fail, or the configured commit policy fails in `runtime_contract.git_root`.

Rejected promises continue in the same session with a corrective prompt. Accepted NEXT starts the next fresh session. The current runtime agent must not start the next item itself. Accepted COMPLETE ends the loop.

## Final response

After writing the four files, respond with exactly this shape and no extra commentary:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=n
```

Choose a bounded `n` from the item count and expected iteration risk.
