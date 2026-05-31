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
	clearCommandCtx,
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
// How long Ralph waits for Pi's auto-retry after a provider-error turn before
// declaring the loop dead. Pi retries with exponential backoff and is idle
// (not streaming) between attempts, so Ralph cannot use idleness as the
// give-up signal. Instead it waits out this window; any later agent_end (a
// recovered turn or a fresh failure) supersedes the wait. Kept well above Pi's
// max per-attempt retry delay so a genuine retry is never cut off.
export const PROVIDER_ERROR_MAX_WAIT_MS = 180_000;
const LIMIT_REMINDER_OPT_OUT_ENV = "RALPH_LIMIT_REMINDERS_DISABLED";
function sendUserMessageWhenIdle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	const timeout = setTimeout(
		() => sendUserMessageWhenIdle(pi, ctx, message),
		250,
	);
	timeout.unref?.();
}

const LIMIT_REMINDERS = [
	{
		id: "75",
		percent: 75,
		message:
			"This Pi session is getting long and approaching its context limit. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
	{
		id: "80",
		percent: 80,
		message:
			"This Pi session has little context room left. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
	{
		id: "85",
		percent: 85,
		message:
			"This Pi session is almost out of context room. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
] as const;

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

// Per-iteration retry counters (reset on each fresh iteration).
let _promiseNudges = 0;

// Generation counter for the pending provider-error wait. A provider-error turn
// arms a wait that captures the current generation; any later agent_end or loop
// finalization bumps the generation, so a wait armed by an earlier provider
// error is superseded the moment Pi produces another turn (a recovered turn or
// a fresh failure). The wait finalizes the loop only when its generation is
// still current, i.e. Pi stayed silent for the whole window and retries are
// genuinely exhausted. The timer is unref'd, so a superseded wait costs nothing
// beyond a no-op fire.
let _providerErrorWaitGeneration = 0;

function invalidateProviderErrorWait(): void {
	_providerErrorWaitGeneration++;
}

function resetIterationCounters(): void {
	_promiseNudges = 0;
	invalidateProviderErrorWait();
}

function shouldStop(cwd: string): boolean {
	const state = readState(cwd);
	return state?.cancel_requested === true || state?.stop_requested === true;
}

function armProviderErrorWait(
	ctx: ExtensionContext,
	cwd: string,
	loopToken: string,
	iteration: number,
	errorCount: number,
	message: string,
): void {
	const generation = ++_providerErrorWaitGeneration;
	const timeout = setTimeout(() => {
		if (generation !== _providerErrorWaitGeneration) return;
		const latest = readState(cwd);
		if (
			!latest?.running ||
			latest.loop_token !== loopToken ||
			latest.iteration !== iteration ||
			latest.error_count !== errorCount
		) {
			return;
		}

		ctx.ui.notify(message, "error");
		finalizeLoop(ctx, cwd, "error", errorCount);
	}, PROVIDER_ERROR_MAX_WAIT_MS);
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
	armProviderErrorWait(
		ctx,
		ctx.cwd,
		state.loop_token,
		state.iteration,
		errorCount,
		finalMessage,
	);
}

function getCurrentState(ctx: ExtensionContext): RalphLoopState | null {
	const state = readState(ctx.cwd);
	if (!state?.running) return null;
	if (state.session_id === ctx.sessionManager.getSessionId()) return state;

	updateState(ctx.cwd, {
		session_id: ctx.sessionManager.getSessionId(),
		last_session_file: ctx.sessionManager.getSessionFile() ?? null,
	});
	return readState(ctx.cwd);
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

function finalizeTransitionError(
	cwd: string,
	errorCount: number,
): void {
	updateState(cwd, {
		running: false,
		completed_at: new Date().toISOString(),
		stop_reason: "error",
		error_count: errorCount,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
	});
	clearCommandCtx();
}

function scheduleInitialSessionTransition(
	ctx: ExtensionCommandContext,
	cwd: string,
	errorCount: number,
): void {
	const timeout = setTimeout(async () => {
		try {
			const result = await createFreshSession(ctx);
			if (result.cancelled) {
				finalizeTransitionError(cwd, errorCount);
			}
		} catch {
			finalizeTransitionError(cwd, errorCount);
		}
	}, 0);
	timeout.unref?.();
}

function scheduleNextIteration(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	const timeout = setTimeout(async () => {
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
				finalizeTransitionError(cmdCtx.cwd, state.error_count);
			}
		} catch {
			finalizeTransitionError(cmdCtx.cwd, state.error_count);
		}
	}, ITERATION_DELAY_MS);
	timeout.unref?.();
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

	const nextIteration = state.iteration + 1;
	ctx.ui.notify(
		`Starting iteration ${nextIteration}/${state.max_iterations} in a fresh session...`,
		"info",
	);
	updateState(ctx.cwd, {
		iteration: nextIteration,
		transitioning: true,
		bundle_rejection_count: 0,
		limit_reminders: null,
	});
	scheduleNextIteration(ctx, state);
}

function areLimitRemindersDisabled(): boolean {
	const value = process.env[LIMIT_REMINDER_OPT_OUT_ENV];
	return value !== undefined && value !== "" && value !== "0";
}

export function handleLoopTurnEnd(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event?: {
		message?: { role?: string; content?: unknown };
		toolResults?: unknown[];
	},
): void {
	if (areLimitRemindersDisabled()) return;
	if (extractControlPromise(event?.message ?? null)) return;

	const state = readState(ctx.cwd);
	if (!state?.running || state.transitioning) return;

	const usage = ctx.getContextUsage();
	const usagePercent = usage?.percent;
	if (usagePercent === undefined || usagePercent === null) return;

	const sent = new Set(
		(state.limit_reminders ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
	const reminder = LIMIT_REMINDERS.find(
		(candidate) => usagePercent >= candidate.percent && !sent.has(candidate.id),
	);
	if (!reminder) return;

	sent.add(reminder.id);
	updateState(ctx.cwd, { limit_reminders: Array.from(sent).join(",") });
	pi.sendMessage(
		{
			customType: "ralph_limit",
			content: reminder.message,
			display: false,
		},
		{ deliverAs: "steer" },
	);
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
	sendUserMessageWhenIdle(
		pi,
		ctx,
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
		snapshotBundleIteration(ctx.cwd, state);
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
	const state = getCurrentState(ctx);
	if (!state) return;

	// A new agent_end means Pi produced a turn, so any wait left over from a
	// prior provider-error turn is superseded. Bump the generation before
	// deciding this turn; a fresh provider error below will arm its own wait.
	invalidateProviderErrorWait();

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
	const bundleMode = options.bundleMode === true;
	const reuseCurrentSession = options.reuseCurrentSession === true;

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
		limit_reminders: null,
	};

	writeState(cwd, initialState, task);
	if (bundleMode) {
		snapshotBundleIteration(cwd, initialState);
	}

	setCommandCtx(ctx);
	resetIterationCounters();

	ctx.ui.notify(`Ralph loop started (max ${maxIterations} iterations)`, "info");

	if (reuseCurrentSession) {
		startIteration(pi, ctx, initialState, task);
		return;
	}

	scheduleInitialSessionTransition(ctx, cwd, initialErrorCount);
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
