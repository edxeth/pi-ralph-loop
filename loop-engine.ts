import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { BooleanRef, RalphLoopState } from "./types.js";
import { readState, updateState, writeState } from "./state.js";

/** Maximum retry attempts per iteration for provider errors */
const MAX_ERROR_RETRIES = 3;

/** Maximum non-promise turns per iteration before failing */
const MAX_PROMISE_NUDGES = 5;

/** Final warning nudge sent on the last allowed attempt before nudge limit is hit */
const FINAL_PROMISE_WARNING_NUDGE = [
  "continue",
  "Reminder: emit exactly one control tag on the LAST non-empty line when appropriate:",
  "- <promise>NEXT</promise> only when this iteration unit is fully done",
  "- <promise>COMPLETE</promise> only when ALL tasks are fully done",
].join("\n");

/** Delay between iterations in milliseconds */
const ITERATION_DELAY_MS = 500;

/** How long to wait for a terminal assistant message after waitForIdle resolves */
const EVENT_QUEUE_SETTLE_MS = 10000;

/** Polling interval when waiting for session entries to settle */
const EVENT_QUEUE_POLL_MS = 100;

/** Stop reasons that indicate the agent loop has truly finished */
const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

/** Backoff delay before retrying after a provider error */
const ERROR_RETRY_DELAY_MS = 2000;

/**
 * Check if the last assistant message in the session was aborted by the user.
 */
function wasAborted(ctx: ExtensionCommandContext): boolean {
  const msg = getLastAssistantMessage(ctx);
  return msg?.stopReason === "aborted";
}

/**
 * Check if the last assistant message ended with an error (provider/API error).
 */
function hasError(ctx: ExtensionCommandContext): boolean {
  const msg = getLastAssistantMessage(ctx);
  return msg?.stopReason === "error";
}

/** Control promises emitted by the assistant to drive loop state transitions. */
type ControlPromise = "NEXT" | "COMPLETE" | "STOP";

/**
 * Get the last assistant message in the current session branch.
 */
function getLastAssistantMessage(
  ctx: ExtensionCommandContext,
): { stopReason?: string; content?: unknown } | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "message" &&
      "message" in entry &&
      (entry.message as { role: string }).role === "assistant"
    ) {
      return entry.message as { stopReason?: string; content?: unknown };
    }
  }
  return null;
}

/**
 * Parse a strict control promise from the last assistant message.
 *
 * Strictness rule: only the LAST non-empty line of assistant text may contain
 * the control tag, and it must match exactly one of:
 * - <promise>NEXT</promise>
 * - <promise>COMPLETE</promise>
 * - <promise>STOP</promise>
 *
 * This avoids false positives from quoted/instructional mentions.
 */
function getControlPromise(
  ctx: ExtensionCommandContext,
): ControlPromise | null {
  const msg = getLastAssistantMessage(ctx);
  if (!msg || !Array.isArray(msg.content)) return null;

  const text = (msg.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();

  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];
  const match = lastLine.match(/^<promise>(NEXT|COMPLETE|STOP)<\/promise>$/);
  if (!match) return null;

  return match[1] as ControlPromise;
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
 * Get the stopReason of the last assistant message in the session branch.
 * Returns null if no assistant messages exist.
 */
function getLastAssistantStopReason(
  ctx: ExtensionCommandContext,
): string | null {
  const msg = getLastAssistantMessage(ctx);
  return msg?.stopReason ?? null;
}

/**
 * Wait for the agent's final state to be visible in the session manager.
 *
 * After waitForIdle() resolves, the agent loop (_runLoop) has finished, but
 * the async event queue (_agentEventQueue) may not have persisted the final
 * assistant message yet. This function polls until the last assistant message
 * has a terminal stopReason ("stop", "length", "error", "aborted").
 *
 * CRITICAL EDGE CASE: When the agent errors (e.g. API timeout), _runLoop's
 * catch block creates an error message via agent.appendMessage() and emits
 * agent_end — but it does NOT emit message_end. Since sessionManager only
 * receives messages via _processAgentEvent(message_end), the error message
 * is INVISIBLE to getBranch(). The last visible assistant message stays at
 * stopReason="toolUse". After the timeout, we return false to signal that
 * the iteration ended abnormally.
 *
 * @returns true if a terminal stopReason was observed, false if timed out
 *          (indicates the agent errored but the error wasn't persisted)
 */
async function waitForSessionSettle(
  ctx: ExtensionCommandContext,
  cancelledRef: BooleanRef,
  stoppedRef: BooleanRef,
): Promise<boolean> {
  const deadline = Date.now() + EVENT_QUEUE_SETTLE_MS;
  while (!shouldStop(cancelledRef, stoppedRef) && Date.now() < deadline) {
    const stopReason = getLastAssistantStopReason(ctx);
    if (stopReason !== null && TERMINAL_STOP_REASONS.has(stopReason)) {
      return true;
    }
    await sleep(EVENT_QUEUE_POLL_MS);
  }
  return false;
}

/**
 * Send a user message and wait for the agent to fully complete.
 *
 * Handles the full lifecycle:
 * 1. Fire-and-forget sendUserMessage (pi triggers turn asynchronously)
 * 2. Spin-wait until the agent transitions out of idle (isStreaming = true)
 * 3. waitForIdle() until the agent loop finishes (runningPrompt resolves)
 * 4. Wait for the last assistant message to reach a terminal stopReason
 *
 * @returns true if the agent completed normally (terminal stopReason visible),
 *          false if the agent errored but the error wasn't persisted to the
 *          session manager (stopReason stuck at "toolUse" — see agent.ts catch block)
 */
async function sendAndWaitForCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  message: string,
  cancelledRef: BooleanRef,
  stoppedRef: BooleanRef,
): Promise<boolean> {
  pi.sendUserMessage(message);

  // Wait for the agent to actually start processing.
  // sendUserMessage triggers a turn asynchronously; without this guard,
  // waitForIdle() returns immediately because the agent hasn't begun yet.
  while (ctx.isIdle() && !shouldStop(cancelledRef, stoppedRef)) {
    await sleep(100);
  }

  // Wait for the agent loop to finish
  await ctx.waitForIdle();

  // Wait for the final assistant message to appear with a terminal stopReason.
  // If this returns false, the agent errored but the error message was never
  // persisted to the session manager (pi's _runLoop catch block only calls
  // agent.appendMessage, not sessionManager.appendMessage).
  return waitForSessionSettle(ctx, cancelledRef, stoppedRef);
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

    // Drive this iteration until assistant emits a control promise.
    let providerRetries = 0;
    let promiseNudges = 0;
    let nextMessage = task;
    let shouldAdvanceIteration = false;

    while (!shouldStop(cancelledRef, stoppedRef)) {
      const turnCompleted = await sendAndWaitForCompletion(
        pi,
        ctx,
        nextMessage,
        cancelledRef,
        stoppedRef,
      );

      // If we timed out waiting for a terminal assistant stopReason, the agent
      // likely errored after a tool call and the error was not persisted to the
      // session manager (pi _runLoop catch path). Treat as provider error.
      if (!turnCompleted) {
        totalErrorCount++;
        finalStopReason = "error";
        ctx.ui.notify(
          `Ralph loop failed at iteration ${iteration}: agent ended without terminal stopReason (stuck at toolUse)`,
          "error",
        );
        break;
      }

      // Check cancellation after each completed turn.
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

      // Provider error path: nudge with plain "continue".
      if (hasError(ctx)) {
        providerRetries++;
        totalErrorCount++;

        if (providerRetries > MAX_ERROR_RETRIES) {
          finalStopReason = "error";
          ctx.ui.notify(
            `Ralph loop failed after ${iteration} iterations: provider error persists after ${MAX_ERROR_RETRIES} retries`,
            "error",
          );
          break;
        }

        ctx.ui.notify(
          `Provider error, retrying (attempt ${providerRetries}/${MAX_ERROR_RETRIES})...`,
          "warning",
        );
        await sleep(ERROR_RETRY_DELAY_MS);
        nextMessage = "continue";
        continue;
      }

      const controlPromise = getControlPromise(ctx);
      if (controlPromise === "COMPLETE") {
        finalStopReason = "complete";
        ctx.ui.notify(
          `Ralph loop complete after ${iteration} iterations!`,
          "info",
        );
        break;
      }

      if (controlPromise === "STOP") {
        finalStopReason = "manual_stop";
        ctx.ui.notify(
          `Ralph loop stopped by assistant at iteration ${iteration} via <promise>STOP</promise>`,
          "warning",
        );
        break;
      }

      if (controlPromise === "NEXT") {
        shouldAdvanceIteration = true;
        break;
      }

      // No control promise => keep same iteration and nudge.
      // Semantics: when promiseNudges reaches MAX_PROMISE_NUDGES, stop.
      // So the final nudge opportunity is MAX_PROMISE_NUDGES - 1.
      promiseNudges++;
      if (promiseNudges >= MAX_PROMISE_NUDGES) {
        finalStopReason = "error";
        ctx.ui.notify(
          `Ralph loop failed at iteration ${iteration}: assistant did not emit <promise>NEXT</promise>, <promise>COMPLETE</promise>, or <promise>STOP</promise> within ${MAX_PROMISE_NUDGES - 1} nudges`,
          "error",
        );
        break;
      }

      const isFinalWarningNudge = promiseNudges === MAX_PROMISE_NUDGES - 1;
      ctx.ui.notify(
        isFinalWarningNudge
          ? `Iteration ${iteration}/${maxIterations} still missing control promise; sending final warning nudge (${promiseNudges}/${MAX_PROMISE_NUDGES - 1})`
          : `Iteration ${iteration}/${maxIterations} missing control promise; nudging continue (${promiseNudges}/${MAX_PROMISE_NUDGES - 1})`,
        "warning",
      );
      nextMessage = isFinalWarningNudge ? FINAL_PROMISE_WARNING_NUDGE : "continue";
    }

    // Update cumulative error count
    updateState(cwd, { error_count: totalErrorCount });

    if (finalStopReason) break;

    if (!shouldAdvanceIteration) {
      finalStopReason = cancelledRef.value ? "user_cancelled" : "manual_stop";
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
  if (finalStopReason === "manual_stop" && stoppedRef.value) {
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
