import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	handleLoopAgentEnd,
	handleLoopSessionStart,
	handleLoopTurnEnd,
} from "./loop-engine.js";
import { readState, updateState } from "./state.js";

function isLoopRunning(cwd: string): boolean {
	return readState(cwd)?.running === true;
}

function restoreLoopStatus(ctx: ExtensionContext): void {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	ctx.ui.setStatus(
		"ralph-loop",
		`Ralph ${state.iteration}/${state.max_iterations}`,
	);
}

function handleSessionBeforeSwitch(
	event: { reason: "new" | "resume" },
	ctx: ExtensionContext,
) {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	if (event.reason === "resume") {
		ctx.ui.notify(
			"Ralph loop is running. /resume is blocked. Use another pi instance or /ralph-stop.",
			"warning",
		);
		return { cancel: true };
	}

	if (event.reason === "new" && !state.transitioning) {
		ctx.ui.notify(
			"Ralph loop is running. /new is blocked. Use another pi instance or /ralph-stop.",
			"warning",
		);
		return { cancel: true };
	}
}

function handleBlockedSessionMutation(
	commandName: "fork" | "tree",
	ctx: ExtensionContext,
) {
	if (!isLoopRunning(ctx.cwd)) return;

	ctx.ui.notify(
		`Ralph loop is running. /${commandName} is blocked. Use another pi instance or /ralph-stop.`,
		"warning",
	);
	return { cancel: true };
}

function handleSessionShutdown(ctx: ExtensionContext) {
	const cwd = ctx.cwd;
	const state = readState(cwd);
	if (state?.running && !state.transitioning) {
		updateState(cwd, { cancel_requested: true });
	}
}

function handleSessionStart(
	pi: ExtensionAPI,
	event: { reason: string },
	ctx: ExtensionContext,
) {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	if (event.reason === "startup") {
		updateState(ctx.cwd, {
			running: false,
			completed_at: new Date().toISOString(),
			stop_reason: "error",
			transitioning: false,
			cancel_requested: false,
			stop_requested: false,
		});
		ctx.ui.setStatus("ralph-loop", undefined);
		return;
	}

	restoreLoopStatus(ctx);

	// When this is a Ralph-managed new session, set up the iteration and
	// send the task.  The command handler has already returned at this point,
	// so the agent is NOT streaming and sendUserMessage can start a fresh prompt.
	if (event.reason === "new" && state.transitioning) {
		handleLoopSessionStart(pi, ctx);
	}
}

export function registerEventHandlers(pi: ExtensionAPI): void {
	pi.on("session_before_switch", handleSessionBeforeSwitch);
	pi.on("session_before_fork", async (_event, ctx) =>
		handleBlockedSessionMutation("fork", ctx),
	);
	pi.on("session_before_tree", async (_event, ctx) =>
		handleBlockedSessionMutation("tree", ctx),
	);
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));
	pi.on("session_start", handleSessionStart.bind(null, pi));
	pi.on("turn_end", (event, ctx) => handleLoopTurnEnd(pi, ctx, event));
	pi.on("agent_end", (event, ctx) => {
		const messages = (
			event as {
				messages: Array<{
					role: string;
					stopReason?: string;
					content?: unknown;
				}>;
			}
		).messages;
		handleLoopAgentEnd(pi, messages, ctx);
	});
}
