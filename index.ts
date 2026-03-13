/**
 * pi-ralph-loop — Ralph Wiggum loop extension for pi
 *
 * Implements iterative task execution with fresh context windows per iteration.
 * The loop sends the same task prompt in a new session each iteration, checking
 * for <promise>COMPLETE</promise> to know when the task is done.
 *
 * Commands:
 *   /ralph-loop <task> [--max-iterations=N]  — Start a loop
 *   /ralph-resume [--force]                  — Resume a failed/stopped loop
 *   /ralph-restart                           — Restart a saved loop from iteration 1
 *   /ralph-stop                              — Stop after current iteration
 *   /ralph-status                            — Show loop status
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { runLoop } from "./loop-engine.js";
import { parseArgs } from "./parser.js";
import { getTaskBody, readState, updateState } from "./state.js";
import type { BooleanRef } from "./types.js";

function parseResumeArgs(args: string): { force: boolean } | null {
  const trimmed = args.trim();
  if (!trimmed) return { force: false };
  if (trimmed === "--force") return { force: true };
  return null;
}

export default function ralphLoopExtension(pi: ExtensionAPI): void {
  /** Whether a loop is currently running in this extension instance */
  let loopActive = false;

  /**
   * Allows the loop's own ctx.newSession() call to pass the session_before_switch
   * guard while still blocking user-initiated /new during active runs.
   */
  const internalNewSessionRef: BooleanRef = { value: false };

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
          internalNewSessionRef,
        );
      } finally {
        loopActive = false;
      }
    },
  });

  pi.registerCommand("ralph-resume", {
    description:
      "Resume a saved Ralph loop from .ralph/loop.md. Completed loops require --force. If run from the saved iteration session, it continues that chat; otherwise it restarts the saved iteration in a fresh session.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (loopActive) {
        ctx.ui.notify("A Ralph loop is already running", "error");
        return;
      }

      const parsedArgs = parseResumeArgs(args);
      if (!parsedArgs) {
        ctx.ui.notify("Usage: /ralph-resume [--force]", "error");
        return;
      }

      const state = readState(ctx.cwd);
      const task = getTaskBody(ctx.cwd);

      if (!state || !task) {
        ctx.ui.notify(
          "No resumable Ralph loop state found in .ralph/loop.md",
          "error",
        );
        return;
      }

      if (state.iteration <= 0 || state.max_iterations <= 0) {
        ctx.ui.notify("Ralph loop state is invalid and cannot be resumed", "error");
        return;
      }

      if (state.stop_reason === "complete" && !parsedArgs.force) {
        ctx.ui.notify(
          "Ralph loop already completed; use /ralph-resume --force or /ralph-restart",
          "info",
        );
        return;
      }

      if (state.iteration > state.max_iterations) {
        ctx.ui.notify(
          "Saved Ralph loop is already past max iterations and cannot be resumed",
          "error",
        );
        return;
      }

      const currentSessionId = ctx.sessionManager.getSessionId();
      const reuseCurrentSession =
        Boolean(state.session_id) && currentSessionId === state.session_id;
      const initialMessage = reuseCurrentSession ? "continue" : task;

      // Reset signals
      cancelledRef.value = false;
      stoppedRef.value = false;
      loopActive = true;

      try {
        ctx.ui.notify(
          reuseCurrentSession
            ? `Resuming Ralph loop in current session from iteration ${state.iteration}/${state.max_iterations}`
            : `Resuming Ralph loop from iteration ${state.iteration}/${state.max_iterations} in a fresh session`,
          "info",
        );

        await runLoop(
          pi,
          ctx,
          task,
          state.max_iterations,
          cancelledRef,
          stoppedRef,
          internalNewSessionRef,
          {
            startIteration: state.iteration,
            startedAt: state.started_at || new Date().toISOString(),
            initialErrorCount: state.error_count,
            reuseCurrentSession,
            initialMessage,
          },
        );
      } finally {
        loopActive = false;
      }
    },
  });

  pi.registerCommand("ralph-restart", {
    description:
      "Restart the saved Ralph loop from iteration 1 in a fresh session, reusing the prompt and max_iterations from .ralph/loop.md.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (loopActive) {
        ctx.ui.notify("A Ralph loop is already running", "error");
        return;
      }

      const state = readState(ctx.cwd);
      const task = getTaskBody(ctx.cwd);

      if (!state || !task) {
        ctx.ui.notify(
          "No restartable Ralph loop state found in .ralph/loop.md",
          "error",
        );
        return;
      }

      if (state.max_iterations <= 0) {
        ctx.ui.notify("Ralph loop state is invalid and cannot be restarted", "error");
        return;
      }

      cancelledRef.value = false;
      stoppedRef.value = false;
      loopActive = true;

      try {
        ctx.ui.notify(
          `Restarting Ralph loop from iteration 1/${state.max_iterations} in a fresh session`,
          "info",
        );

        await runLoop(
          pi,
          ctx,
          task,
          state.max_iterations,
          cancelledRef,
          stoppedRef,
          internalNewSessionRef,
          {
            startIteration: 1,
            startedAt: new Date().toISOString(),
            initialErrorCount: 0,
            reuseCurrentSession: false,
            initialMessage: task,
          },
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
   * Block user-initiated session/context switching while Ralph owns the active
   * session. The loop still needs to create its own fresh sessions internally.
   */
  pi.on("session_before_switch", async (event, ctx) => {
    if (!loopActive) return;

    if (event.reason === "resume") {
      ctx.ui.notify(
        "Ralph loop is running. /resume is blocked. Use another pi instance or /ralph-stop.",
        "warning",
      );
      return { cancel: true };
    }

    if (event.reason === "new" && !internalNewSessionRef.value) {
      ctx.ui.notify(
        "Ralph loop is running. /new is blocked. Use another pi instance or /ralph-stop.",
        "warning",
      );
      return { cancel: true };
    }
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    if (!loopActive) return;

    ctx.ui.notify(
      "Ralph loop is running. /fork is blocked. Use another pi instance or /ralph-stop.",
      "warning",
    );
    return { cancel: true };
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    if (!loopActive) return;

    ctx.ui.notify(
      "Ralph loop is running. /tree is blocked. Use another pi instance or /ralph-stop.",
      "warning",
    );
    return { cancel: true };
  });

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
