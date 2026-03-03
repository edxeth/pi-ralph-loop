/**
 * pi-ralph-loop — Ralph Wiggum loop extension for pi
 *
 * Implements iterative task execution with fresh context windows per iteration.
 * The loop sends the same task prompt in a new session each iteration, checking
 * for <promise>COMPLETE</promise> to know when the task is done.
 *
 * Commands:
 *   /ralph-loop <task> [--max-iterations=N]  — Start a loop
 *   /ralph-stop                               — Stop after current iteration
 *   /ralph-status                             — Show loop status
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { runLoop } from "./loop-engine.js";
import { parseArgs } from "./parser.js";
import { readState, updateState } from "./state.js";
import type { BooleanRef } from "./types.js";

export default function ralphLoopExtension(pi: ExtensionAPI): void {
  /** Whether a loop is currently running in this extension instance */
  let loopActive = false;

  /** Signals: set by event handlers / commands, read by the loop */
  const cancelledRef: BooleanRef = { value: false };
  const stoppedRef: BooleanRef = { value: false };

  // ─── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("ralph-loop", {
    description:
      'Start a Ralph loop — run a task iteratively in fresh sessions until <promise>COMPLETE</promise> or max iterations. Usage: /ralph-loop "task" [--max-iterations=N]',
    getArgumentCompletions: (prefix: string) => {
      // Offer common max-iterations values
      if (prefix.includes("--max-iterations")) return null;
      const items = ["--max-iterations=5", "--max-iterations=10", "--max-iterations=20", "--max-iterations=50", "--max-iterations=100"];
      const filtered = items
        .filter((v) => v.startsWith(prefix) || !prefix)
        .map((v) => ({ value: v, label: v }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (loopActive) {
        ctx.ui.notify("A Ralph loop is already running", "error");
        return;
      }

      const parsed = parseArgs(args);
      if (!parsed) {
        ctx.ui.notify(
          'Usage: /ralph-loop "task text" [--max-iterations=N]',
          "error",
        );
        return;
      }

      // Reset signals
      cancelledRef.value = false;
      stoppedRef.value = false;
      loopActive = true;

      try {
        await runLoop(
          pi,
          ctx,
          parsed.task,
          parsed.maxIterations,
          cancelledRef,
          stoppedRef,
        );
      } finally {
        loopActive = false;
      }
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop the currently running Ralph loop after the current iteration",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!loopActive) {
        ctx.ui.notify("No Ralph loop is running", "info");
        return;
      }

      stoppedRef.value = true;
      ctx.ui.notify("Ralph loop will stop after the current iteration", "info");
    },
  });

  pi.registerCommand("ralph-status", {
    description: "Show the current Ralph loop status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = readState(ctx.cwd);

      if (!state || !state.running) {
        if (state && state.stop_reason) {
          ctx.ui.notify(
            `Ralph loop (inactive): last run stopped at iteration ${state.iteration}/${state.max_iterations}, reason: ${state.stop_reason}`,
            "info",
          );
        } else {
          ctx.ui.notify("No active Ralph loop", "info");
        }
        return;
      }

      const elapsed = state.started_at
        ? Math.round((Date.now() - new Date(state.started_at).getTime()) / 1000)
        : 0;

      ctx.ui.notify(
        [
          `Ralph loop: iteration ${state.iteration}/${state.max_iterations}`,
          `   Started: ${state.started_at}`,
          `   Elapsed: ${elapsed}s`,
          `   Errors: ${state.error_count}`,
          `   Session: ${state.session_id || "unknown"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // ─── Event Handlers ───────────────────────────────────────────────

  /**
   * On session_shutdown (Ctrl+C×2, Ctrl+D, SIGTERM), signal the loop to stop.
   */
  pi.on("session_shutdown", async () => {
    if (loopActive) {
      cancelledRef.value = true;
    }
  });

  /**
   * On session_start, detect stale running state from a previous crash
   * and reset it.
   */
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const state = readState(ctx.cwd);
    if (state && state.running && !loopActive) {
      updateState(ctx.cwd, {
        running: false,
        completed_at: new Date().toISOString(),
        stop_reason: "error",
      });
    }
  });
}
