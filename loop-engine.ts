import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { RalphLoopState, RunLoopOptions } from "./types.js";
import { getTaskBody, readState, updateState, writeState } from "./state.js";

const MAX_ERROR_RETRIES = 3;
const MAX_PROMISE_NUDGES = 5;
const FINAL_PROMISE_WARNING_NUDGE = [
  "continue",
  "Reminder: emit exactly one control tag on the LAST non-empty line when appropriate:",
  "- <promise>NEXT</promise> only when this iteration unit is fully done",
  "- <promise>COMPLETE</promise> only when ALL tasks are fully done",
].join("\n");
const ITERATION_DELAY_MS = 500;
const EVENT_QUEUE_SETTLE_MS = 10000;
const EVENT_QUEUE_POLL_MS = 100;
const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);
const ERROR_RETRY_DELAY_MS = 2000;

type ControlPromise = "NEXT" | "COMPLETE" | "STOP";
type RequestedStopReason = "user_cancelled" | "manual_stop";

type ActiveLoop = {
  state: RalphLoopState;
  task: string;
};

type IterationProgress = {
  totalErrorCount: number;
  providerRetries: number;
  promiseNudges: number;
  nextMessage: string;
};

type ContinueDecision =
  | { kind: "retry" }
  | { kind: "finish"; stopReason: RalphLoopState["stop_reason"] }
  | { kind: "advance" };

function shouldStop(cwd: string): boolean {
  const state = readState(cwd);
  return state?.cancel_requested === true || state?.stop_requested === true;
}

function getRequestedStopReason(cwd: string): RequestedStopReason {
  return readState(cwd)?.cancel_requested === true ? "user_cancelled" : "manual_stop";
}

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

function wasAborted(ctx: ExtensionCommandContext): boolean {
  return getLastAssistantMessage(ctx)?.stopReason === "aborted";
}

function hasError(ctx: ExtensionCommandContext): boolean {
  return getLastAssistantMessage(ctx)?.stopReason === "error";
}

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

  const match = lines[lines.length - 1].match(/^<promise>(NEXT|COMPLETE|STOP)<\/promise>$/);
  return match ? (match[1] as ControlPromise) : null;
}

function getLastAssistantStopReason(
  ctx: ExtensionCommandContext,
): string | null {
  return getLastAssistantMessage(ctx)?.stopReason ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setLoopStatus(
  ctx: ExtensionCommandContext,
  iteration: number,
  maxIterations: number,
): void {
  const theme = ctx.ui.theme;
  ctx.ui.setStatus(
    "ralph-loop",
    theme.fg("accent", `Ralph ${iteration}/${maxIterations}`),
  );
}

function clearLoopStatus(ctx: ExtensionCommandContext): void {
  ctx.ui.setStatus("ralph-loop", undefined);
}

function finalizeLoop(
  ctx: ExtensionCommandContext,
  cwd: string,
  stopReason: RalphLoopState["stop_reason"],
  errorCount: number,
): void {
  updateState(cwd, {
    running: false,
    completed_at: new Date().toISOString(),
    stop_reason: stopReason,
    error_count: errorCount,
    transitioning: false,
    cancel_requested: false,
    stop_requested: false,
  });
  clearLoopStatus(ctx);
}

function loadActiveLoop(ctx: ExtensionCommandContext): ActiveLoop | null {
  const state = readState(ctx.cwd);
  const task = getTaskBody(ctx.cwd);
  if (!state || !task || !state.running) return null;
  return { state, task };
}

function createIterationProgress(state: RalphLoopState, task: string): IterationProgress {
  return {
    totalErrorCount: state.error_count,
    providerRetries: 0,
    promiseNudges: 0,
    nextMessage: state.next_message || task,
  };
}

function syncIterationSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RalphLoopState,
  cwd: string,
): void {
  setLoopStatus(ctx, state.iteration, state.max_iterations);
  ctx.ui.notify(`Ralph iteration ${state.iteration}/${state.max_iterations}`, "info");
  pi.setSessionName(`Ralph loop iteration ${state.iteration}/${state.max_iterations}`);
  updateState(cwd, {
    transitioning: false,
    session_id: ctx.sessionManager.getSessionId(),
    last_session_file: ctx.sessionManager.getSessionFile() ?? null,
  });
}

async function waitForSessionSettle(
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<boolean> {
  const deadline = Date.now() + EVENT_QUEUE_SETTLE_MS;
  while (!shouldStop(cwd) && Date.now() < deadline) {
    const stopReason = getLastAssistantStopReason(ctx);
    if (stopReason !== null && TERMINAL_STOP_REASONS.has(stopReason)) {
      return true;
    }
    await sleep(EVENT_QUEUE_POLL_MS);
  }
  return false;
}

async function sendAndWaitForCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  message: string,
): Promise<boolean> {
  pi.sendUserMessage(message);

  while (ctx.isIdle() && !shouldStop(cwd)) {
    await sleep(100);
  }

  await ctx.waitForIdle();
  return waitForSessionSettle(ctx, cwd);
}

async function startFreshIterationSession(
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<boolean> {
  updateState(cwd, { transitioning: true });
  const result = await ctx.newSession();
  if (result.cancelled) {
    updateState(cwd, { transitioning: false });
    return false;
  }
  return true;
}

function finishRequestedStop(
  ctx: ExtensionCommandContext,
  cwd: string,
  errorCount: number,
): ContinueDecision {
  const stopReason = getRequestedStopReason(cwd);
  if (stopReason === "manual_stop") {
    ctx.ui.notify("Ralph loop stopped manually", "info");
  }
  finalizeLoop(ctx, cwd, stopReason, errorCount);
  return { kind: "finish", stopReason };
}

async function handleRetryableFailure(
  ctx: ExtensionCommandContext,
  cwd: string,
  progress: IterationProgress,
  failureMessage: string,
  retryMessage: (attempt: number) => string,
): Promise<ContinueDecision> {
  progress.providerRetries++;
  progress.totalErrorCount++;
  updateState(cwd, {
    error_count: progress.totalErrorCount,
    next_message: "continue",
  });

  if (progress.providerRetries > MAX_ERROR_RETRIES) {
    ctx.ui.notify(failureMessage, "error");
    finalizeLoop(ctx, cwd, "error", progress.totalErrorCount);
    return { kind: "finish", stopReason: "error" };
  }

  ctx.ui.notify(retryMessage(progress.providerRetries), "warning");
  await sleep(ERROR_RETRY_DELAY_MS);
  progress.nextMessage = "continue";
  return { kind: "retry" };
}

function finishWithControlPromise(
  ctx: ExtensionCommandContext,
  cwd: string,
  state: RalphLoopState,
  task: string,
  progress: IterationProgress,
  controlPromise: ControlPromise | null,
): ContinueDecision {
  if (controlPromise === "COMPLETE") {
    ctx.ui.notify(`Ralph loop complete after ${state.iteration} iterations!`, "info");
    finalizeLoop(ctx, cwd, "complete", progress.totalErrorCount);
    return { kind: "finish", stopReason: "complete" };
  }

  if (controlPromise === "STOP") {
    ctx.ui.notify(
      `Ralph loop stopped by assistant at iteration ${state.iteration} via <promise>STOP</promise>`,
      "warning",
    );
    finalizeLoop(ctx, cwd, "manual_stop", progress.totalErrorCount);
    return { kind: "finish", stopReason: "manual_stop" };
  }

  if (controlPromise === "NEXT") {
    if (state.iteration === state.max_iterations) {
      ctx.ui.notify(
        `Ralph loop reached max iterations (${state.max_iterations})`,
        "warning",
      );
      finalizeLoop(ctx, cwd, "max_iterations", progress.totalErrorCount);
      return { kind: "finish", stopReason: "max_iterations" };
    }

    updateState(cwd, {
      iteration: state.iteration + 1,
      error_count: progress.totalErrorCount,
      next_message: task,
    });
    return { kind: "advance" };
  }

  progress.promiseNudges++;
  if (progress.promiseNudges >= MAX_PROMISE_NUDGES) {
    ctx.ui.notify(
      `Ralph loop failed at iteration ${state.iteration}: assistant did not emit <promise>NEXT</promise>, <promise>COMPLETE</promise>, or <promise>STOP</promise> within ${MAX_PROMISE_NUDGES - 1} nudges`,
      "error",
    );
    finalizeLoop(ctx, cwd, "error", progress.totalErrorCount);
    return { kind: "finish", stopReason: "error" };
  }

  const isFinalWarningNudge = progress.promiseNudges === MAX_PROMISE_NUDGES - 1;
  ctx.ui.notify(
    isFinalWarningNudge
      ? `Iteration ${state.iteration}/${state.max_iterations} still missing control promise; sending final warning nudge (${progress.promiseNudges}/${MAX_PROMISE_NUDGES - 1})`
      : `Iteration ${state.iteration}/${state.max_iterations} missing control promise; nudging continue (${progress.promiseNudges}/${MAX_PROMISE_NUDGES - 1})`,
    "warning",
  );
  progress.nextMessage = isFinalWarningNudge ? FINAL_PROMISE_WARNING_NUDGE : "continue";
  return { kind: "retry" };
}

async function executeIterationTurn(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  activeLoop: ActiveLoop,
  progress: IterationProgress,
): Promise<ContinueDecision> {
  const { state, task } = activeLoop;
  const cwd = ctx.cwd;

  updateState(cwd, { next_message: progress.nextMessage });
  const turnCompleted = await sendAndWaitForCompletion(
    pi,
    ctx,
    cwd,
    progress.nextMessage,
  );

  if (!turnCompleted) {
    return handleRetryableFailure(
      ctx,
      cwd,
      progress,
      `Ralph loop failed after ${state.iteration} iterations: agent kept ending without a terminal stopReason after ${MAX_ERROR_RETRIES} retries`,
      (attempt) =>
        `Agent ended without terminal stopReason (likely transient provider failure after tool use); retrying with continue (${attempt}/${MAX_ERROR_RETRIES})...`,
    );
  }

  if (shouldStop(cwd)) {
    return finishRequestedStop(ctx, cwd, progress.totalErrorCount);
  }

  if (wasAborted(ctx)) {
    ctx.ui.notify(
      `Ralph loop cancelled by user at iteration ${state.iteration}`,
      "info",
    );
    finalizeLoop(ctx, cwd, "user_cancelled", progress.totalErrorCount);
    return { kind: "finish", stopReason: "user_cancelled" };
  }

  if (hasError(ctx)) {
    return handleRetryableFailure(
      ctx,
      cwd,
      progress,
      `Ralph loop failed after ${state.iteration} iterations: provider error persists after ${MAX_ERROR_RETRIES} retries`,
      (attempt) => `Provider error, retrying (attempt ${attempt}/${MAX_ERROR_RETRIES})...`,
    );
  }

  return finishWithControlPromise(
    ctx,
    cwd,
    state,
    task,
    progress,
    getControlPromise(ctx),
  );
}

async function advanceIterationOrFinish(
  ctx: ExtensionCommandContext,
  progress: IterationProgress,
): Promise<void> {
  await sleep(ITERATION_DELAY_MS);
  if (!(await startFreshIterationSession(ctx, ctx.cwd))) {
    finalizeLoop(ctx, ctx.cwd, "user_cancelled", progress.totalErrorCount);
  }
}

export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: string,
  maxIterations: number,
  options: RunLoopOptions = {},
): Promise<void> {
  const cwd = ctx.cwd;
  const startIteration = options.startIteration ?? 1;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const initialErrorCount = options.initialErrorCount ?? 0;
  const reuseCurrentSession = options.reuseCurrentSession === true;
  const initialMessage = options.initialMessage ?? task;

  writeState(cwd, {
    running: true,
    iteration: startIteration,
    max_iterations: maxIterations,
    started_at: startedAt,
    completed_at: null,
    stop_reason: null,
    session_id: "",
    last_session_file: null,
    error_count: initialErrorCount,
    transitioning: !reuseCurrentSession,
    cancel_requested: false,
    stop_requested: false,
    next_message: initialMessage,
  }, task);

  ctx.ui.notify(`Ralph loop started (max ${maxIterations} iterations)`, "info");
  if (reuseCurrentSession) {
    await continueLoop(pi, ctx);
    return;
  }

  if (!(await startFreshIterationSession(ctx, cwd))) {
    finalizeLoop(ctx, cwd, "user_cancelled", initialErrorCount);
  }
}

export async function continueLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const activeLoop = loadActiveLoop(ctx);
  if (!activeLoop) {
    ctx.ui.notify("No Ralph loop is running", "info");
    clearLoopStatus(ctx);
    return;
  }

  if (shouldStop(ctx.cwd)) {
    finishRequestedStop(ctx, ctx.cwd, activeLoop.state.error_count);
    return;
  }

  syncIterationSession(pi, ctx, activeLoop.state, ctx.cwd);
  const progress = createIterationProgress(activeLoop.state, activeLoop.task);

  while (!shouldStop(ctx.cwd)) {
    const decision = await executeIterationTurn(pi, ctx, activeLoop, progress);
    if (decision.kind === "finish") return;
    if (decision.kind === "retry") continue;

    await advanceIterationOrFinish(ctx, progress);
    return;
  }

  finishRequestedStop(ctx, ctx.cwd, progress.totalErrorCount);
}
