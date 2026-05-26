import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	snapshotBundleIteration,
	validateBundlePromise,
} from "./loop/bundle-gates.js";
import { rejectBundlePromise } from "./loop/bundle-rejections.js";
import {
	createFreshSession,
	getCommandCtx,
	setCommandCtx,
} from "./loop/command-context.js";
import { extractControlPromise } from "./loop/control-promise.js";
import { finalizeLoop } from "./loop/finalize.js";
import { clearLoopStatus, setLoopStatus } from "./loop/status.js";
import { getTaskBody, readState, updateState, writeState } from "./state.js";
import type { RalphLoopState, RunLoopOptions } from "./types.js";

const MAX_PROMISE_NUDGES = 5;
const FINAL_PROMISE_WARNING_NUDGE = [
	"continue",
	"Reminder: emit exactly one control tag on the LAST non-empty line when appropriate:",
	"- <promise>NEXT</promise> only when this iteration unit is fully done",
	"- <promise>COMPLETE</promise> only when ALL tasks are fully done",
].join("\n");
const ITERATION_DELAY_MS = 500;
const PROVIDER_ERROR_IDLE_CHECK_MS = 1_000;
const PROVIDER_ERROR_MAX_WAIT_MS = 180_000;

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

// Per-iteration retry counters (reset on each fresh iteration).
let _promiseNudges = 0;

function resetIterationCounters(): void {
	_promiseNudges = 0;
}

function shouldStop(cwd: string): boolean {
	const state = readState(cwd);
	return state?.cancel_requested === true || state?.stop_requested === true;
}

function scheduleProviderErrorFinalization(
	ctx: ExtensionContext,
	cwd: string,
	loopToken: string,
	iteration: number,
	errorCount: number,
	message: string,
	startedAt = Date.now(),
): void {
	const timeout = setTimeout(() => {
		const latest = readState(cwd);
		if (
			!latest?.running ||
			latest.loop_token !== loopToken ||
			latest.iteration !== iteration ||
			latest.error_count !== errorCount
		) {
			return;
		}

		if (!ctx.isIdle() && Date.now() - startedAt < PROVIDER_ERROR_MAX_WAIT_MS) {
			scheduleProviderErrorFinalization(
				ctx,
				cwd,
				loopToken,
				iteration,
				errorCount,
				message,
				startedAt,
			);
			return;
		}

		ctx.ui.notify(message, "error");
		finalizeLoop(ctx, cwd, "error", errorCount);
	}, PROVIDER_ERROR_IDLE_CHECK_MS);
	timeout.unref?.();
}

function findLastAssistantMessage(
	messages: AgentEndMessages,
): { stopReason?: string; content?: unknown } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			return messages[i];
		}
	}
	return null;
}

function handleRequestedStop(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	const stopReason = state.cancel_requested ? "user_cancelled" : "manual_stop";
	if (stopReason === "manual_stop") {
		ctx.ui.notify("Ralph loop stopped manually", "info");
	}
	finalizeLoop(ctx, ctx.cwd, stopReason, state.error_count);
}

function handleProviderWait(
	ctx: ExtensionContext,
	state: RalphLoopState,
	message: string,
	finalMessage: string,
): void {
	const errorCount = state.error_count + 1;
	updateState(ctx.cwd, { error_count: errorCount });
	ctx.ui.notify(message, "warning");
	scheduleProviderErrorFinalization(
		ctx,
		ctx.cwd,
		state.loop_token,
		state.iteration,
		errorCount,
		finalMessage,
	);
}

function handleCompletePromise(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	const rejection = validateBundlePromise(ctx.cwd, state, "COMPLETE");
	if (rejection) {
		rejectBundlePromise(pi, ctx, state, "COMPLETE", rejection, finalizeLoop);
		return;
	}

	ctx.ui.notify(
		`Ralph loop complete after ${state.iteration} iterations!`,
		"info",
	);
	finalizeLoop(ctx, ctx.cwd, "complete", state.error_count);
}

function handleStopPromise(ctx: ExtensionContext, state: RalphLoopState): void {
	ctx.ui.notify(
		`Ralph loop stopped by assistant at iteration ${state.iteration} via <promise>STOP</promise>`,
		"warning",
	);
	finalizeLoop(ctx, ctx.cwd, "manual_stop", state.error_count);
}

function scheduleNextIteration(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	setTimeout(async () => {
		const cmdCtx = getCommandCtx();
		if (!cmdCtx) {
			ctx.ui.notify(
				"Ralph loop error: lost command context for session transition",
				"error",
			);
			finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
			return;
		}
		try {
			const result = await createFreshSession(cmdCtx);
			if (result.cancelled) {
				finalizeLoop(ctx, ctx.cwd, "user_cancelled", state.error_count);
			}
		} catch (err) {
			ctx.ui.notify(
				`Ralph loop error during session transition: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
		}
	}, ITERATION_DELAY_MS);
}

function handleNextPromise(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	const rejection = validateBundlePromise(ctx.cwd, state, "NEXT");
	if (rejection) {
		rejectBundlePromise(pi, ctx, state, "NEXT", rejection, finalizeLoop);
		return;
	}

	if (state.iteration >= state.max_iterations) {
		ctx.ui.notify(
			`Ralph loop reached max iterations (${state.max_iterations})`,
			"warning",
		);
		finalizeLoop(ctx, ctx.cwd, "max_iterations", state.error_count);
		return;
	}

	updateState(ctx.cwd, {
		iteration: state.iteration + 1,
		transitioning: true,
		bundle_rejection_count: 0,
	});
	scheduleNextIteration(ctx, state);
}

function handleMissingPromise(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	_promiseNudges++;
	if (_promiseNudges >= MAX_PROMISE_NUDGES) {
		ctx.ui.notify(
			`Ralph loop failed at iteration ${state.iteration}: assistant did not emit <promise>NEXT</promise>, <promise>COMPLETE</promise>, or <promise>STOP</promise> within ${MAX_PROMISE_NUDGES - 1} nudges`,
			"error",
		);
		finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
		return;
	}

	const isFinalWarningNudge = _promiseNudges === MAX_PROMISE_NUDGES - 1;
	ctx.ui.notify(
		isFinalWarningNudge
			? `Iteration ${state.iteration}/${state.max_iterations} still missing control promise; sending final warning nudge (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`
			: `Iteration ${state.iteration}/${state.max_iterations} missing control promise; nudging continue (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`,
		"warning",
	);
	pi.sendUserMessage(
		isFinalWarningNudge ? FINAL_PROMISE_WARNING_NUDGE : "continue",
	);
}

function startIteration(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
	task: string,
): void {
	resetIterationCounters();
	setLoopStatus(ctx, state.iteration, state.max_iterations);
	ctx.ui.notify(
		`Ralph iteration ${state.iteration}/${state.max_iterations}`,
		"info",
	);
	pi.setSessionName(
		`Ralph loop iteration ${state.iteration}/${state.max_iterations}`,
	);
	updateState(ctx.cwd, {
		transitioning: false,
		session_id: ctx.sessionManager.getSessionId(),
		last_session_file: ctx.sessionManager.getSessionFile() ?? null,
	});
	if (state.bundle_mode) {
		snapshotBundleIteration(ctx.cwd);
	}
	pi.sendUserMessage(task);
}

// ── Session-start handler (called from events.ts) ───────────────────────
/**
 * Called when a new session starts while a Ralph loop is transitioning.
 * Sends the task text as a user message to kick off the iteration.
 *
 * At this point the command handler has returned, so the agent is NOT
 * streaming and `sendUserMessage` can start a fresh prompt.
 */
export function handleLoopSessionStart(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const state = readState(ctx.cwd);
	if (!state?.running || !state.transitioning) return;

	const task = getTaskBody(ctx.cwd);
	if (!task) return;

	startIteration(pi, ctx, state, task);
}

// ── Agent-end handler (called from events.ts) ───────────────────────────
type AgentEndMessages = Array<{
	role: string;
	stopReason?: string;
	content?: unknown;
}>;

/**
 * Called when the agent finishes a turn. Drives the loop by checking promise
 * tags, retry/error state, and session transitions.
 */
export function handleLoopAgentEnd(
	pi: ExtensionAPI,
	messages: AgentEndMessages,
	ctx: ExtensionContext,
): void {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	if (shouldStop(ctx.cwd)) {
		handleRequestedStop(ctx, state);
		return;
	}

	const assistant = findLastAssistantMessage(messages);
	if (!assistant) return;

	const stopReason = assistant.stopReason;
	if (stopReason === "aborted") {
		ctx.ui.notify(
			`Ralph loop cancelled by user at iteration ${state.iteration}`,
			"info",
		);
		finalizeLoop(ctx, ctx.cwd, "user_cancelled", state.error_count);
		return;
	}

	if (stopReason === "error") {
		handleProviderWait(
			ctx,
			state,
			`Provider error at Ralph iteration ${state.iteration}; waiting for Pi's retry handling before deciding the loop failed.`,
			`Ralph loop stopped at iteration ${state.iteration}: provider error persisted after waiting for Pi retry handling. Resume after inspecting the partial work.`,
		);
		return;
	}

	if (!stopReason || !TERMINAL_STOP_REASONS.has(stopReason)) {
		handleProviderWait(
			ctx,
			state,
			`Agent ended without terminal stopReason at Ralph iteration ${state.iteration}; waiting for Pi's retry handling before deciding the loop failed.`,
			`Ralph loop stopped at iteration ${state.iteration}: agent kept ending without a terminal stopReason after waiting for Pi retry handling. Resume after inspecting the partial work.`,
		);
		return;
	}

	const controlPromise = extractControlPromise(assistant);
	if (controlPromise === "COMPLETE") {
		handleCompletePromise(pi, ctx, state);
		return;
	}
	if (controlPromise === "STOP") {
		handleStopPromise(ctx, state);
		return;
	}
	if (controlPromise === "NEXT") {
		handleNextPromise(pi, ctx, state);
		return;
	}

	handleMissingPromise(pi, ctx, state);
}

// ── Command-level entry points ──────────────────────────────────────────

export async function runLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	task: string,
	maxIterations: number,
	options: RunLoopOptions = {},
): Promise<void> {
	const cwd = ctx.cwd;
	const firstIteration = options.startIteration ?? 1;
	const startedAt = options.startedAt ?? new Date().toISOString();
	const initialErrorCount = options.initialErrorCount ?? 0;
	const reuseCurrentSession = options.reuseCurrentSession === true;
	const bundleMode = options.bundleMode === true;

	const initialState: RalphLoopState = {
		running: true,
		iteration: firstIteration,
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
		bundle_mode: bundleMode,
		loop_token: randomUUID(),
		bundle_snapshot_hash: null,
		items_snapshot_hash: null,
		progress_size: null,
		progress_hash: null,
		progress_snapshot: null,
		source_doc_hashes: null,
		bundle_items_snapshot: null,
		git_head: null,
		bundle_rejection_count: 0,
	};

	writeState(cwd, initialState, task);
	if (bundleMode) {
		snapshotBundleIteration(cwd);
	}

	setCommandCtx(ctx);
	resetIterationCounters();

	ctx.ui.notify(`Ralph loop started (max ${maxIterations} iterations)`, "info");

	if (reuseCurrentSession) {
		startIteration(pi, ctx, initialState, task);
		return;
	}

	const result = await createFreshSession(ctx);
	if (result.cancelled) {
		finalizeLoop(ctx, cwd, "user_cancelled", initialErrorCount);
	}
}

/**
 * Continue a loop that was interrupted in the current session.
 * Only used when the current session matches the loop's session_id
 * (i.e., we're already in the right session).
 */
export async function continueLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const state = readState(ctx.cwd);
	const task = getTaskBody(ctx.cwd);
	if (!state || !task || !state.running) {
		ctx.ui.notify("No Ralph loop is running", "info");
		clearLoopStatus(ctx);
		return;
	}

	if (shouldStop(ctx.cwd)) {
		handleRequestedStop(ctx, state);
		return;
	}

	setCommandCtx(ctx);
	startIteration(pi, ctx, state, task);
}
