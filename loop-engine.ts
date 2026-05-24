import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { createBundleSnapshot, evaluateBundleCompleteFileGate, evaluateBundleFileGate, evaluateCompleteGate, evaluateNextGate, evaluateVerificationGates, loadRalphBundle } from "./bundle.js";
import { getTaskBody, readState, updateState, writeState } from "./state.js";
import type { RalphLoopState, RunLoopOptions } from "./types.js";

const MAX_PROMISE_NUDGES = 5;
const MAX_BUNDLE_REJECTIONS = 5;
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

type ControlPromise = "NEXT" | "COMPLETE" | "STOP";

// ── Stored command context ──────────────────────────────────────────────
// The command handler (/ralph-loop, /ralph-resume, /ralph-restart) stores
// the current command-capable context here so that event handlers
// (session_start, agent_end) can trigger the next session transition.
//
// In pi >=0.69.0, command contexts become stale after session replacement, so
// every newSession() must refresh this stored context via withSession().
//
// Stored on globalThis because pi reloads extension modules on newSession(),
// which would reset a module-level variable to null.
const CTX_KEY = "__ralph_loop_command_ctx__";
function getCommandCtx(): ExtensionCommandContext | null {
	return (
		((globalThis as Record<string, unknown>)[
			CTX_KEY
		] as ExtensionCommandContext | null) ?? null
	);
}
function setCommandCtx(ctx: ExtensionCommandContext | null): void {
	(globalThis as Record<string, unknown>)[CTX_KEY] = ctx;
}
async function createFreshSession(
	ctx: ExtensionCommandContext,
): Promise<{ cancelled: boolean }> {
	return ctx.newSession({
		withSession: async (nextCtx) => {
			setCommandCtx(nextCtx);
		},
	});
}

// Per-iteration retry counters (reset on each fresh iteration).
let _promiseNudges = 0;

function resetIterationCounters(): void {
	_promiseNudges = 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractControlPromise(
	msg: { content?: unknown } | null,
): ControlPromise | null {
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

	const match = lines[lines.length - 1].match(
		/<promise>(NEXT|COMPLETE|STOP)<\/promise>$/,
	);
	return match ? (match[1] as ControlPromise) : null;
}

function setLoopStatus(
	ctx: ExtensionContext,
	iteration: number,
	maxIterations: number,
): void {
	ctx.ui.setStatus("ralph-loop", `Ralph ${iteration}/${maxIterations}`);
}

function clearLoopStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("ralph-loop", undefined);
}

function finalizeLoop(
	ctx: ExtensionContext,
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
	if (getCommandCtx()?.cwd === cwd) {
		setCommandCtx(null);
	}
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
			scheduleProviderErrorFinalization(ctx, cwd, loopToken, iteration, errorCount, message, startedAt);
			return;
		}

		ctx.ui.notify(message, "error");
		finalizeLoop(ctx, cwd, "error", errorCount);
	}, PROVIDER_ERROR_IDLE_CHECK_MS);
	timeout.unref?.();
}

function snapshotBundleIteration(cwd: string): void {
	const bundle = loadRalphBundle(cwd);
	updateState(cwd, createBundleSnapshot(bundle));
}

function buildBundleRejectionPrompt(
	promise: Extract<ControlPromise, "NEXT" | "COMPLETE">,
	rejection: string,
): string {
	return [
		`Ralph rejected <promise>${promise}</promise>.`,
		`Failed invariant: ${rejection}.`,
		"Continue this same iteration. Fix the issue, rerun required verification, update only the appropriate bundle state, and end with exactly one valid promise tag on the last non-empty line.",
	].join("\n");
}

function sendWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	const timeout = setTimeout(() => sendWhenIdle(pi, ctx, message), 250);
	timeout.unref?.();
}

function rejectBundlePromise(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
	promise: Extract<ControlPromise, "NEXT" | "COMPLETE">,
	rejection: string,
): void {
	const rejectionCount = state.bundle_rejection_count + 1;
	updateState(ctx.cwd, { bundle_rejection_count: rejectionCount });

	if (rejectionCount >= MAX_BUNDLE_REJECTIONS) {
		ctx.ui.notify(
			`Ralph loop failed at iteration ${state.iteration}: bundle invariant rejected ${rejectionCount} times. Last invariant: ${rejection}`,
			"error",
		);
		finalizeLoop(ctx, ctx.cwd, "error", state.error_count);
		return;
	}

	ctx.ui.notify(
		`Ralph rejected <promise>${promise}</promise> (${rejectionCount}/${MAX_BUNDLE_REJECTIONS - 1}): ${rejection}`,
		"error",
	);
	sendWhenIdle(pi, ctx, buildBundleRejectionPrompt(promise, rejection));
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

	resetIterationCounters();

	// Set up the iteration in the new session.
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

	// Send the task.  The agent is not streaming (command handler returned).
	pi.sendUserMessage(task);
}

// ── Agent-end handler (called from events.ts) ───────────────────────────
type AgentEndMessages = Array<{
	role: string;
	stopReason?: string;
	content?: unknown;
}>;

/**
 * Called when the agent finishes a turn.  Drives the entire loop:
 * check for promise tags, retry on errors, advance on NEXT, stop on
 * COMPLETE/STOP/max_iterations.
 */
export function handleLoopAgentEnd(
	pi: ExtensionAPI,
	messages: AgentEndMessages,
	ctx: ExtensionContext,
): void {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	const cwd = ctx.cwd;

	if (shouldStop(cwd)) {
		const stopReason = state.cancel_requested
			? "user_cancelled"
			: "manual_stop";
		if (stopReason === "manual_stop") {
			ctx.ui.notify("Ralph loop stopped manually", "info");
		}
		finalizeLoop(ctx, cwd, stopReason, state.error_count);
		return;
	}

	// Find the last assistant message in the agent_end payload.
	let assistant: { stopReason?: string; content?: unknown } | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			assistant = messages[i];
			break;
		}
	}
	if (!assistant) return;

	const stopReason = assistant.stopReason;

	// ── Aborted (Ctrl+C) ──
	if (stopReason === "aborted") {
		ctx.ui.notify(
			`Ralph loop cancelled by user at iteration ${state.iteration}`,
			"info",
		);
		finalizeLoop(ctx, cwd, "user_cancelled", state.error_count);
		return;
	}

	// ── Provider/runtime error ──
	if (stopReason === "error") {
		const errorCount = state.error_count + 1;
		updateState(cwd, { error_count: errorCount });
		ctx.ui.notify(
			`Provider error at Ralph iteration ${state.iteration}; waiting for Pi's retry handling before deciding the loop failed.`,
			"warning",
		);
		scheduleProviderErrorFinalization(
			ctx,
			cwd,
			state.loop_token,
			state.iteration,
			errorCount,
			`Ralph loop stopped at iteration ${state.iteration}: provider error persisted after waiting for Pi retry handling. Resume after inspecting the partial work.`,
		);
		return;
	}

	// ── Non-terminal stop reason (e.g. missing stopReason after tool use) ──
	if (!stopReason || !TERMINAL_STOP_REASONS.has(stopReason)) {
		const errorCount = state.error_count + 1;
		updateState(cwd, { error_count: errorCount });
		ctx.ui.notify(
			`Agent ended without terminal stopReason at Ralph iteration ${state.iteration}; waiting for Pi's retry handling before deciding the loop failed.`,
			"warning",
		);
		scheduleProviderErrorFinalization(
			ctx,
			cwd,
			state.loop_token,
			state.iteration,
			errorCount,
			`Ralph loop stopped at iteration ${state.iteration}: agent kept ending without a terminal stopReason after waiting for Pi retry handling. Resume after inspecting the partial work.`,
		);
		return;
	}

	// ── Terminal stop — check for control promise ──
	const controlPromise = extractControlPromise(assistant);

	if (controlPromise === "COMPLETE") {
		if (state.bundle_mode) {
			let rejection: string | null;
			try {
				const bundle = loadRalphBundle(cwd);
				rejection = evaluateCompleteGate(
					state.bundle_items_snapshot,
					bundle.items.items,
				) ?? evaluateBundleCompleteFileGate(bundle, state) ?? evaluateVerificationGates(bundle);
			} catch (err) {
				rejection = err instanceof Error ? err.message : String(err);
			}
			if (rejection) {
				rejectBundlePromise(pi, ctx, state, "COMPLETE", rejection);
				return;
			}
		}

		ctx.ui.notify(
			`Ralph loop complete after ${state.iteration} iterations!`,
			"info",
		);
		finalizeLoop(ctx, cwd, "complete", state.error_count);
		return;
	}

	if (controlPromise === "STOP") {
		ctx.ui.notify(
			`Ralph loop stopped by assistant at iteration ${state.iteration} via <promise>STOP</promise>`,
			"warning",
		);
		finalizeLoop(ctx, cwd, "manual_stop", state.error_count);
		return;
	}

	if (controlPromise === "NEXT") {
		if (state.bundle_mode) {
			let rejection: string | null;
			try {
				const bundle = loadRalphBundle(cwd);
				rejection = evaluateNextGate(
					state.bundle_items_snapshot,
					bundle.items.items,
				) ?? evaluateBundleFileGate(bundle, state) ?? evaluateVerificationGates(bundle);
			} catch (err) {
				rejection = err instanceof Error ? err.message : String(err);
			}
			if (rejection) {
				rejectBundlePromise(pi, ctx, state, "NEXT", rejection);
				return;
			}
		}

		if (state.iteration >= state.max_iterations) {
			ctx.ui.notify(
				`Ralph loop reached max iterations (${state.max_iterations})`,
				"warning",
			);
			finalizeLoop(ctx, cwd, "max_iterations", state.error_count);
			return;
		}

		// Advance to next iteration in a fresh session.
		updateState(cwd, {
			iteration: state.iteration + 1,
			transitioning: true,
			bundle_rejection_count: 0,
		});

		// Create new session using the stored command context.
		// This fires session_start → handleLoopSessionStart → sendUserMessage(task).
		setTimeout(async () => {
			const cmdCtx = getCommandCtx();
			if (!cmdCtx) {
				ctx.ui.notify(
					"Ralph loop error: lost command context for session transition",
					"error",
				);
				finalizeLoop(ctx, cwd, "error", state.error_count);
				return;
			}
			try {
				const result = await createFreshSession(cmdCtx);
				if (result.cancelled) {
					finalizeLoop(ctx, cwd, "user_cancelled", state.error_count);
				}
			} catch (err) {
				ctx.ui.notify(
					`Ralph loop error during session transition: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				finalizeLoop(ctx, cwd, "error", state.error_count);
			}
		}, ITERATION_DELAY_MS);
		return;
	}

	// ── No promise tag — nudge the assistant ──
	_promiseNudges++;
	if (_promiseNudges >= MAX_PROMISE_NUDGES) {
		ctx.ui.notify(
			`Ralph loop failed at iteration ${state.iteration}: assistant did not emit <promise>NEXT</promise>, <promise>COMPLETE</promise>, or <promise>STOP</promise> within ${MAX_PROMISE_NUDGES - 1} nudges`,
			"error",
		);
		finalizeLoop(ctx, cwd, "error", state.error_count);
		return;
	}

	const isFinalWarningNudge = _promiseNudges === MAX_PROMISE_NUDGES - 1;
	ctx.ui.notify(
		isFinalWarningNudge
			? `Iteration ${state.iteration}/${state.max_iterations} still missing control promise; sending final warning nudge (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`
			: `Iteration ${state.iteration}/${state.max_iterations} missing control promise; nudging continue (${_promiseNudges}/${MAX_PROMISE_NUDGES - 1})`,
		"warning",
	);
	const nudgeText = isFinalWarningNudge
		? FINAL_PROMISE_WARNING_NUDGE
		: "continue";
	pi.sendUserMessage(nudgeText);
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
	const startIteration = options.startIteration ?? 1;
	const startedAt = options.startedAt ?? new Date().toISOString();
	const initialErrorCount = options.initialErrorCount ?? 0;
	const reuseCurrentSession = options.reuseCurrentSession === true;
	const bundleMode = options.bundleMode === true;

	const initialState: RalphLoopState = {
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
		// Resume in the current session: set up iteration state, send the task.
		setLoopStatus(ctx, startIteration, maxIterations);
		ctx.ui.notify(`Ralph iteration ${startIteration}/${maxIterations}`, "info");
		pi.setSessionName(
			`Ralph loop iteration ${startIteration}/${maxIterations}`,
		);
		updateState(cwd, {
			transitioning: false,
			session_id: ctx.sessionManager.getSessionId(),
			last_session_file: ctx.sessionManager.getSessionFile() ?? null,
		});
		// Send the task.  We're inside the command handler, but since
		// reuseCurrentSession is true, the command handler returns and THEN
		// the queued sendUserMessage is processed.
		pi.sendUserMessage(task);
		return;
	}

	// Create a fresh session.  The command handler returns, then:
	// session_start → handleLoopSessionStart → sendUserMessage(task).
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
		const stopReason = state.cancel_requested
			? "user_cancelled"
			: "manual_stop";
		if (stopReason === "manual_stop") {
			ctx.ui.notify("Ralph loop stopped manually", "info");
		}
		finalizeLoop(ctx, ctx.cwd, stopReason, state.error_count);
		return;
	}

	setCommandCtx(ctx);
	resetIterationCounters();

	// Set up the iteration.
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

	// Send the task.  The command handler returns, then pi processes the message.
	pi.sendUserMessage(task);
}