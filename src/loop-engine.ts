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
import { getCommandCtx, setCommandCtx } from "./loop/command-context.js";
import { extractControlPromise } from "./loop/control-promise.js";
import { finalizeLoop } from "./loop/finalize.js";
import { sendWhenIdle } from "./loop/idle.js";
import {
	areLimitRemindersDisabled,
	selectLimitReminder,
} from "./loop/limit-reminders.js";
import {
	claimLoopOwnership,
	getLoopOwnerFields,
	startLoopHeartbeat,
} from "./loop/ownership.js";
import {
	armProviderWait,
	isProviderWaitCurrent,
	supersedeProviderWait,
} from "./loop/provider-wait.js";
import {
	clearLoopStatus,
	setLoopStatus,
	showLoopNotice,
} from "./loop/status.js";
import { getTaskBody, readState, updateState, writeState } from "./state.js";
import type { RalphLoopState, RunLoopOptions } from "./types.js";

const MAX_PROMISE_NUDGES = 5;
const FINAL_PROMISE_WARNING_NUDGE = [
	"continue",
	"Reminder: emit exactly one control tag on the LAST non-empty line when appropriate:",
	"- <promise>NEXT</promise> only when this iteration unit is fully done",
	"- <promise>COMPLETE</promise> only when ALL tasks are fully done",
].join("\n");
// How long Ralph waits for Pi's auto-retry after a provider-error turn before
// declaring the loop dead. Pi retries with exponential backoff and is idle
// (not streaming) between attempts, so Ralph cannot use idleness as the
// give-up signal. Instead it waits out this window; any later agent_end (a
// recovered turn or a fresh failure) supersedes the wait. Kept well above Pi's
// max per-attempt retry delay so a genuine retry is never cut off.
export const PROVIDER_ERROR_MAX_WAIT_MS = 180_000;

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

type NewSessionOptions = NonNullable<
	Parameters<ExtensionCommandContext["newSession"]>[0]
>;
type ReplacementSessionContext = Parameters<
	NonNullable<NewSessionOptions["withSession"]>
>[0];

// Per-chain promise-nudge counter. Provider errors and fresh iterations start a
// new missing-promise chain; accepted promises leave the chain by moving state.
let _promiseNudges = 0;

function resetPromiseNudgeChain(): void {
	_promiseNudges = 0;
}

function resetIterationCounters(): void {
	resetPromiseNudgeChain();
	supersedeProviderWait();
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
	const token = armProviderWait();
	const timeout = setTimeout(() => {
		if (!isProviderWaitCurrent(token)) return;
		const latest = readState(cwd);
		if (
			!latest?.running ||
			latest.loop_token !== loopToken ||
			latest.iteration !== iteration ||
			latest.error_count !== errorCount
		) {
			return;
		}

		showLoopNotice(ctx, message, "error");
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

type BranchMessageEntry = {
	type?: string;
	message?: { role?: string; content?: unknown };
};

/**
 * Inspect the current session branch for resume routing: the most recent
 * assistant message (if any) and whether the session holds any prior turn.
 * A session that already has turns has already consumed its seed prompt.
 */
function readSessionTurns(ctx: ExtensionContext): {
	lastAssistant: { content?: unknown } | null;
	hasTurns: boolean;
} {
	const sessionManager = ctx.sessionManager as unknown as {
		getBranch?: () => BranchMessageEntry[];
	};
	const branch =
		typeof sessionManager.getBranch === "function"
			? sessionManager.getBranch()
			: [];
	let lastAssistant: { content?: unknown } | null = null;
	let hasTurns = false;
	for (const entry of branch) {
		if (entry?.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role === "assistant" || role === "user") hasTurns = true;
		if (role === "assistant") lastAssistant = entry.message;
	}
	return { lastAssistant, hasTurns };
}

function handleRequestedStop(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	const stopReason = state.cancel_requested ? "user_cancelled" : "manual_stop";
	if (stopReason === "manual_stop") {
		showLoopNotice(ctx, "Ralph loop stopped manually", "info");
	}
	finalizeLoop(ctx, ctx.cwd, stopReason, state.error_count);
}

function handleProviderWait(
	ctx: ExtensionContext,
	state: RalphLoopState,
	message: string,
	finalMessage: string,
): void {
	resetPromiseNudgeChain();
	const errorCount = state.error_count + 1;
	updateState(ctx.cwd, { error_count: errorCount });
	showLoopNotice(ctx, message, "warning");
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

	showLoopNotice(
		ctx,
		`Ralph loop complete after ${state.iteration} iterations!`,
		"info",
	);
	finalizeLoop(ctx, ctx.cwd, "complete", state.error_count);
}

function handleStopPromise(ctx: ExtensionContext, state: RalphLoopState): void {
	showLoopNotice(
		ctx,
		`Ralph loop stopped by assistant at iteration ${state.iteration} via <promise>STOP</promise>`,
		"warning",
	);
	finalizeLoop(ctx, ctx.cwd, "manual_stop", state.error_count);
}

function formatIterationSessionName(state: RalphLoopState): string {
	return `Ralph loop iteration ${state.iteration}/${state.max_iterations}`;
}

function markIterationStarted(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	resetIterationCounters();
	setLoopStatus(ctx, state.iteration, state.max_iterations);
	updateState(ctx.cwd, {
		transitioning: false,
		session_id: ctx.sessionManager.getSessionId(),
		last_session_file: ctx.sessionManager.getSessionFile() ?? null,
		...getLoopOwnerFields(),
	});
	startLoopHeartbeat(ctx.cwd, state.loop_token);
	if (state.bundle_mode) {
		snapshotBundleIteration(ctx.cwd, state);
	}
}

function startCurrentIteration(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
	task: string,
): void {
	markIterationStarted(ctx, state);
	pi.setSessionName(formatIterationSessionName(state));
	pi.sendUserMessage(task);
}

function scheduleReplacementPrompt(
	ctx: ReplacementSessionContext,
	task: string,
	errorCount: number,
): void {
	setTimeout(() => {
		void (async () => {
			const state = readState(ctx.cwd);
			if (!state?.running) return;
			try {
				await ctx.sendUserMessage(task);
			} catch {
				finalizeLoop(ctx, ctx.cwd, "error", state.error_count || errorCount);
			}
		})();
	}, 0);
}

async function openFreshIterationSession(
	ctx: ExtensionCommandContext,
	errorCount: number,
): Promise<void> {
	const state = readState(ctx.cwd);
	const task = getTaskBody(ctx.cwd);
	if (!state?.running) return;
	if (!task) {
		finalizeLoop(ctx, ctx.cwd, "error", errorCount);
		return;
	}

	try {
		const result = await ctx.newSession({
			setup: async (sessionManager) => {
				sessionManager.appendSessionInfo(formatIterationSessionName(state));
			},
			withSession: async (nextCtx) => {
				setCommandCtx(nextCtx);
				const latest = readState(nextCtx.cwd);
				if (!latest?.running) return;
				markIterationStarted(nextCtx, latest);
				scheduleReplacementPrompt(nextCtx, task, latest.error_count);
			},
		});
		if (result.cancelled) {
			finalizeLoop(ctx, ctx.cwd, "error", errorCount);
		}
	} catch {
		finalizeLoop(ctx, ctx.cwd, "error", errorCount);
	}
}

function scheduleFreshIterationSession(
	ctx: ExtensionCommandContext,
	errorCount: number,
): void {
	setTimeout(() => {
		void openFreshIterationSession(ctx, errorCount);
	}, 0);
}

function scheduleNextIteration(
	ctx: ExtensionContext,
	state: RalphLoopState,
): void {
	setTimeout(() => {
		const cmdCtx = getCommandCtx();
		if (!cmdCtx || cmdCtx.cwd !== ctx.cwd) {
			showLoopNotice(
				ctx,
				"Ralph loop error: lost command context for session transition",
				"error",
			);
			finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
			return;
		}
		void openFreshIterationSession(cmdCtx, state.error_count);
	}, 0);
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
		showLoopNotice(
			ctx,
			`Ralph loop reached max iterations (${state.max_iterations})`,
			"warning",
		);
		finalizeLoop(ctx, ctx.cwd, "max_iterations", state.error_count);
		return;
	}

	const nextIteration = state.iteration + 1;
	showLoopNotice(
		ctx,
		`Starting iteration ${nextIteration}/${state.max_iterations} in a fresh session...`,
		"info",
		{ autoClear: true },
	);
	updateState(ctx.cwd, {
		iteration: nextIteration,
		transitioning: true,
		bundle_rejection_count: 0,
		limit_reminders: null,
	});
	scheduleNextIteration(ctx, state);
}

export function handleLoopTurnEnd(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event?: {
		message?: { role?: string; content?: unknown };
		toolResults?: unknown[];
	},
): void {
	const state = readState(ctx.cwd);
	if (!state?.running || state.transitioning) return;

	// A turn landing is proof Pi recovered after a provider-error turn, so any
	// pending provider-error wait must be superseded here. Otherwise a recovery
	// that runs longer than PROVIDER_ERROR_MAX_WAIT_MS lets the wait timer fire
	// and finalize the loop as "error" while the agent is actively working.
	// agent_end alone is too late: a long multi-turn recovery emits no agent_end
	// until the whole unit finishes, which can be many minutes after the error.
	supersedeProviderWait();

	if (areLimitRemindersDisabled()) return;
	if (extractControlPromise(event?.message ?? null)) return;

	const usage = ctx.getContextUsage();
	const usagePercent = usage?.percent;
	if (usagePercent === undefined || usagePercent === null) return;

	const reminder = selectLimitReminder(usagePercent, state.limit_reminders);
	if (!reminder) return;

	updateState(ctx.cwd, { limit_reminders: reminder.sentCsv });
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
		showLoopNotice(
			ctx,
			`Ralph loop failed at iteration ${state.iteration}: assistant did not emit <promise>NEXT</promise>, <promise>COMPLETE</promise>, or <promise>STOP</promise> within ${MAX_PROMISE_NUDGES - 1} nudges`,
			"error",
		);
		finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
		return;
	}

	const isFinalWarningNudge = _promiseNudges === MAX_PROMISE_NUDGES - 1;
	showLoopNotice(
		ctx,
		isFinalWarningNudge
			? `Iteration ${state.iteration}/${state.max_iterations} still missing control promise; sending final warning nudge (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`
			: `Iteration ${state.iteration}/${state.max_iterations} missing control promise; nudging continue (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`,
		"warning",
	);
	sendWhenIdle(
		pi,
		ctx,
		isFinalWarningNudge ? FINAL_PROMISE_WARNING_NUDGE : "continue",
	);
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
	// prior provider-error turn is superseded. Supersede before deciding this
	// turn; a fresh provider error below will arm its own wait.
	supersedeProviderWait();

	if (shouldStop(ctx.cwd)) {
		handleRequestedStop(ctx, state);
		return;
	}

	const assistant = findLastAssistantMessage(messages);
	if (!assistant) return;

	const stopReason = assistant.stopReason;
	if (stopReason === "aborted") {
		showLoopNotice(
			ctx,
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
	const useCurrentSession =
		options.forceFreshSession !== true && !readSessionTurns(ctx).hasTurns;

	const initialState: RalphLoopState = {
		running: true,
		iteration: firstIteration,
		max_iterations: maxIterations,
		started_at: startedAt,
		completed_at: null,
		stop_reason: null,
		session_id: "",
		last_session_file: null,
		...getLoopOwnerFields(),
		error_count: initialErrorCount,
		transitioning: true,
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
	claimLoopOwnership(ctx.cwd);
	resetIterationCounters();

	showLoopNotice(ctx, `Ralph loop started (max ${maxIterations} iterations)`, "info", {
		autoClear: true,
	});

	if (useCurrentSession) {
		startCurrentIteration(pi, ctx, initialState, task);
		return;
	}

	scheduleFreshIterationSession(ctx, initialErrorCount);
}

/**
 * Resume a stopped loop inside the session that already owns it.
 *
 * The seed prompt is delivered exactly once per session, at iteration start.
 * Re-sending it here would make the agent start a brand new unit of work, so
 * instead we re-activate the loop and decide what the session actually needs
 * from its last assistant turn:
 *
 * - COMPLETE / STOP already emitted  -> finalize the loop (route, don't nudge).
 * - NEXT already emitted             -> the unit is done; advance the iteration
 *                                        and open a fresh session.
 * - no promise but the session has
 *   prior turns                      -> nudge "continue" to finish the unit.
 * - empty session (no prior turns)   -> seed the prompt once.
 *
 * Bundle promises validate against the pre-iteration snapshot preserved in
 * loop.md (and the in-memory store when this is the same process), so this
 * path must not re-snapshot the already-mutated working tree.
 */
export async function resumeCurrentSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const saved = readState(ctx.cwd);
	const task = getTaskBody(ctx.cwd);
	if (!saved || !task) {
		showLoopNotice(
			ctx,
			"No resumable Ralph loop state found in .ralph/loop.md",
			"error",
		);
		return;
	}

	setCommandCtx(ctx);
	resetIterationCounters();

	updateState(ctx.cwd, {
		running: true,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		completed_at: null,
		stop_reason: null,
		session_id: ctx.sessionManager.getSessionId(),
		last_session_file: ctx.sessionManager.getSessionFile() ?? null,
		...getLoopOwnerFields(),
	});
	claimLoopOwnership(ctx.cwd);
	const state = readState(ctx.cwd);
	if (!state) return;

	const { lastAssistant, hasTurns } = readSessionTurns(ctx);
	const promise = extractControlPromise(lastAssistant);
	if (promise === "COMPLETE") {
		handleCompletePromise(pi, ctx, state);
		return;
	}
	if (promise === "STOP") {
		handleStopPromise(ctx, state);
		return;
	}
	if (promise === "NEXT") {
		handleNextPromise(pi, ctx, state);
		return;
	}

	if (hasTurns) {
		setLoopStatus(ctx, state.iteration, state.max_iterations);
		pi.setSessionName(formatIterationSessionName(state));
		sendWhenIdle(pi, ctx, "continue");
		return;
	}

	startCurrentIteration(pi, ctx, state, task);
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
		showLoopNotice(ctx, "No Ralph loop is running", "info");
		clearLoopStatus(ctx);
		return;
	}

	if (shouldStop(ctx.cwd)) {
		handleRequestedStop(ctx, state);
		return;
	}

	setCommandCtx(ctx);
	startCurrentIteration(pi, ctx, state, task);
}
