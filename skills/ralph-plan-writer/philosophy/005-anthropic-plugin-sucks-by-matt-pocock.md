# Why the Anthropic Ralph plugin sucks (use a bash loop instead)

Ralph is a development methodology based on continuous AI agent loops - a simple bash script that repeatedly feeds Claude a prompt file, allowing it to iteratively improve its work until completion.

## What Is The Anthropic Plugin?

Anthropic shipped an official Ralph plugin for Claude Code that's designed to automate this loop for you.

Instead of running a script manually multiple times, you run the plugin once with a command like this:

```bash
/ralph-loop "Build a REST API for todos. Requirements: CRUD operations, input validation, tests. Output <promise>COMPLETE</promise> when done." --completion-promise "COMPLETE" --max-iterations 50
```

The plugin then handles the looping automatically. You don't need to write bash scripts. You don't need to run commands repeatedly. The plugin sits inside Claude Code, intercepts your exit attempts, and feeds the prompt back into the session automatically.

On the surface, it sounds perfect. It automates Ralph so you don't have to think about it.

But there's a fundamental problem with how it's built.

## The Problem With Anthropic's Ralph Plugin

To understand why the plugin fails, you need to understand how LLMs actually work under load.

As LLMs receive more tokens, the relationships between tokens scale quadratically. This means LLMs get exponentially more overloaded the more tokens you provide them. Each additional token makes it harder for the model to process information and make good decisions.

Practically speaking, every LLM has a **smart zone** and a **dumb zone**.

| Zone       | Position             | Behavior                                 |
| ---------- | -------------------- | ---------------------------------------- |
| Smart Zone | First 40% of context | Sharp, capable, makes good decisions     |
| Dumb Zone  | Last 60% of context  | Confused, mistakes, degraded performance |

At around the 40% context mark, LLMs start entering the dumb zone. Most people debate exactly where this boundary is, but everyone agrees the boundary exists.

## Why A Bash Loop Works

Ralph keeps the AI in the smart zone. How? **Each iteration of Ralph uses a fresh context window**.

When you run the bash loop, Claude starts with an empty context. The PRD and progress file go in. Claude works on one task. Then the script exits.

When you run it again, Claude gets another fresh context window. The PRD and progress file go in again. Claude reads what was done before (via git history and file modifications), picks the next task, and implements it.

The context window never fills up with cruft. The AI always operates in the smart zone. It never degrades.

![The Bash Loop](https://res.cloudinary.com/total-typescript/image/upload/v1769159503/ai-hero-images/hfobysqhrpwxnyec7evb.png)

Each phase resets the context, keeping the LLM working in the smart zone where it does its best work.

## How The Plugin Breaks This

The Anthropic plugin keeps everything inside a single Claude Code session.

Instead of exiting and restarting, the plugin uses a "stop hook" that intercepts Claude's exit attempts and feeds the same prompt back into the session. The loop happens entirely within one session.

This means:

- **Iteration 1**: Claude reads the PRD, implements task 1, context is ~20% full
- **Iteration 2**: Claude sees its previous work, implements task 2, context is ~35% full
- **Iteration 3**: Claude sees its previous work and the last iteration, implements task 3, context is ~50% full. We have entered the dumb zone.

With each iteration, the context window fills up. The plugin accumulates session history, previous attempts, and accumulated context. After 3-4 iterations, the AI is working entirely in the dumb zone.

In other words, the plugin **guarantees** that you're going to fill up the smart zone and enter the dumb zone. It fundamentally undermines the reason Ralph works in the first place.

![Anthropic's Ralph Plugin](https://res.cloudinary.com/total-typescript/image/upload/v1769159504/ai-hero-images/jpze5uvgxnvfugf53sgl.png)

The plugin keeps all iterations in one session, causing the context to fill up and degrade performance over time.

## The Solution: Stick With The Bash Loop

If you want Ralph to actually work, use a bash loop instead of the plugin. Here are some resources:

1. **Read** the [getting started guide](https://www.aihero.dev/getting-started-with-ralph) for detailed implementation advice
2. Learn more with these [11 tips](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum)
3. Learn how to stream AFK results with Claude Code [here](https://www.aihero.dev/heres-how-to-stream-claude-code-with-afk-ralph)

Ralph works because it's ruthlessly simple. Keep it that way.

---
