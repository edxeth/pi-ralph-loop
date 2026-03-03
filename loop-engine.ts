import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { BooleanRef, RalphLoopState } from "./types.js";
import { readState, updateState, writeState } from "./state.js";

/** Maximum retry attempts per iteration for provider errors */
const MAX_ERROR_RETRIES = 3;

/** Delay between iterations in milliseconds */
const ITERATION_DELAY_MS = 500;

/** Backoff delay before retrying after a provider error */
const ERROR_RETRY_DELAY_MS = 2000;

/**
 * Check if the last assistant message in the session was aborted by the user.
 */
function wasAborted(ctx: ExtensionCommandContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "message" &&
      "message" in entry &&
      (entry.message as { role: string }).role === "assistant"
    ) {
      return (entry.message as { stopReason?: string }).stopReason === "aborted";
    }
  }
  return false;
}

/**
 * Check if the last assistant message ended with an error (provider/API error).
 */
function hasError(ctx: ExtensionCommandContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "message" &&
      "message" in entry &&
      (entry.message as { role: string }).role === "assistant"
    ) {
      return (entry.message as { stopReason?: string }).stopReason === "error";
    }
  }
  return false;
}

/**
 * Check if any assistant message in the current session contains <promise>COMPLETE</promise>.
 */
function containsCompletionPromise(ctx: ExtensionCommandContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as { message: { role: string; content?: unknown } }).message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type: string; text?: string }>) {
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.includes("<promise>COMPLETE</promise>")
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if the loop should stop based on cancellation/stop flags.
 */
function shouldStop(cancelledRef: BooleanRef, stoppedRef: BooleanRef): boolean {
  return cancelledRef.value || stoppedRef.value;
}

/**
 * Run the Ralph loop: iterate fresh sessions with the same task prompt.
 *
 * @param pi - Extension API
 * @param ctx - Command context (provides newSession, waitForIdle, etc.)
 * @param task - The task prompt to send each iteration
 * @param maxIterations - Maximum number of iterations
 * @param cancelledRef - Mutable ref set by session_shutdown handler
 * @param stoppedRef - Mutable ref set by /ralph-stop command
 */
export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: string,
  maxIterations: number,
  cancelledRef: BooleanRef,
  stoppedRef: BooleanRef,
): Promise<void> {
  const cwd = ctx.cwd;
  const startedAt = new Date().toISOString();

  // Write initial state
  const initialState: RalphLoopState = {
    running: true,
    iteration: 1,
    max_iterations: maxIterations,
    started_at: startedAt,
    completed_at: null,
    stop_reason: null,
    session_id: "",
    last_session_file: null,
    error_count: 0,
  };
  writeState(cwd, initialState, task);

  ctx.ui.notify(`Ralph loop started (max ${maxIterations} iterations)`, "info");

  let finalStopReason: RalphLoopState["stop_reason"] = null;
  let totalErrorCount = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Check cancellation before starting iteration
    if (shouldStop(cancelledRef, stoppedRef)) {
      finalStopReason = cancelledRef.value ? "user_cancelled" : "manual_stop";
      break;
    }

    // Update state with current iteration
    updateState(cwd, { iteration });

    // Update footer status
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "ralph-loop",
      theme.fg("accent", `Ralph ${iteration}/${maxIterations}`),
    );

    ctx.ui.notify(`Ralph iteration ${iteration}/${maxIterations}`, "info");

    // Create a fresh session (new context window!)
    const newSessionResult = await ctx.newSession();
    if (newSessionResult.cancelled) {
      finalStopReason = "user_cancelled";
      break;
    }

    // Name the session
    pi.setSessionName(`Ralph loop iteration ${iteration}/${maxIterations}`);

    // Update state with session info
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    updateState(cwd, {
      session_id: sessionId,
      last_session_file: sessionFile,
    });

    // Send the task prompt
    pi.sendUserMessage(task);

    // Wait for the agent to actually start processing before waiting for idle.
    // sendUserMessage triggers a turn asynchronously; without this guard,
    // waitForIdle() returns immediately because the agent hasn't begun yet.
    while (ctx.isIdle() && !shouldStop(cancelledRef, stoppedRef)) {
      await sleep(100);
    }

    // Wait for the agent to finish
    await ctx.waitForIdle();

    // Check cancellation after idle
    if (shouldStop(cancelledRef, stoppedRef)) {
      finalStopReason = cancelledRef.value ? "user_cancelled" : "manual_stop";
      break;
    }

    // Check if the user aborted the turn (Ctrl+C once)
    if (wasAborted(ctx)) {
      finalStopReason = "user_cancelled";
      ctx.ui.notify(
        `Ralph loop cancelled by user at iteration ${iteration}`,
        "info",
      );
      break;
    }

    // Handle provider errors with retry logic
    let iterationRetries = 0;
    while (hasError(ctx) && iterationRetries < MAX_ERROR_RETRIES) {
      iterationRetries++;
      totalErrorCount++;

      ctx.ui.notify(
        `Provider error, retrying (attempt ${iterationRetries}/${MAX_ERROR_RETRIES})...`,
        "warning",
      );

      await sleep(ERROR_RETRY_DELAY_MS);

      if (shouldStop(cancelledRef, stoppedRef)) break;

      // Send a "continue" nudge
      pi.sendUserMessage("continue");
      while (ctx.isIdle() && !shouldStop(cancelledRef, stoppedRef)) {
        await sleep(100);
      }
      await ctx.waitForIdle();

      if (shouldStop(cancelledRef, stoppedRef)) break;

      if (wasAborted(ctx)) {
        finalStopReason = "user_cancelled";
        break;
      }
    }

    // Update cumulative error count
    updateState(cwd, { error_count: totalErrorCount });

    // If we broke out of retry loop due to cancellation
    if (finalStopReason) break;

    // If still erroring after retries, stop
    if (hasError(ctx)) {
      finalStopReason = "error";
      ctx.ui.notify(
        `Ralph loop failed after ${iteration} iterations: provider error persists after ${MAX_ERROR_RETRIES} retries`,
        "error",
      );
      break;
    }

    // Check for completion promise
    if (containsCompletionPromise(ctx)) {
      finalStopReason = "complete";
      ctx.ui.notify(
        `Ralph loop complete after ${iteration} iterations!`,
        "info",
      );
      break;
    }

    // If this was the last iteration, we'll fall through
    if (iteration === maxIterations) {
      finalStopReason = "max_iterations";
      ctx.ui.notify(
        `Ralph loop reached max iterations (${maxIterations})`,
        "warning",
      );
      break;
    }

    // Brief delay to let state settle before next iteration
    await sleep(ITERATION_DELAY_MS);
  }

  // Determine final stop reason if not yet set
  if (!finalStopReason) {
    if (cancelledRef.value) {
      finalStopReason = "user_cancelled";
    } else if (stoppedRef.value) {
      finalStopReason = "manual_stop";
    } else {
      finalStopReason = "max_iterations";
    }
  }

  // Notify for stop reasons that weren't already notified inside the loop
  const currentIteration = readState(cwd)?.iteration ?? 0;
  if (finalStopReason === "manual_stop") {
    ctx.ui.notify("Ralph loop stopped manually", "info");
  } else if (
    finalStopReason === "user_cancelled" &&
    cancelledRef.value &&
    !stoppedRef.value
  ) {
    ctx.ui.notify(
      `Ralph loop cancelled by user at iteration ${currentIteration}`,
      "info",
    );
  }

  // Final state update
  updateState(cwd, {
    running: false,
    completed_at: new Date().toISOString(),
    stop_reason: finalStopReason,
    error_count: totalErrorCount,
  });

  // Clear footer status
  ctx.ui.setStatus("ralph-loop", undefined);
}
