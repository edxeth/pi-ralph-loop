import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { finalizeLoop } from "./loop/finalize.js";
import { handleLoopAgentEnd, handleLoopTurnEnd } from "./loop-engine.js";
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

function handleSessionShutdown(
	event: { reason?: "quit" | "reload" | "new" | "resume" | "fork" },
	ctx: ExtensionContext,
) {
	const cwd = ctx.cwd;
	const state = readState(cwd);
	if (!state?.running) return;

	if (state.transitioning) {
		if (event.reason === "quit" || event.reason === "reload") {
			// A NEXT was already accepted and the iteration advanced, but the
			// fresh-session handoff was cut off by host/stdin shutdown. This is a
			// committed handoff, not a loop failure: mark it resumable so
			// /ralph-resume continues the saved iteration instead of treating a
			// valid promise as an unrecoverable error.
			finalizeLoop(ctx, cwd, "interrupted", state.error_count);
		}
		return;
	}

	updateState(cwd, { cancel_requested: true });
}

function handleSessionStart(
	event: { reason: string },
	ctx: ExtensionContext,
) {
	const state = readState(ctx.cwd);
	if (!state?.running) return;

	if (event.reason === "startup") {
		// Pi booted and found a loop still marked running, so the previous
		// process died without a clean shutdown event (hard crash, kill, OOM).
		// If it died mid-handoff after a committed NEXT, mark it resumable so
		// /ralph-resume can continue the saved iteration; otherwise treat the
		// interrupted iteration as an error.
		finalizeLoop(
			ctx,
			ctx.cwd,
			state.transitioning ? "interrupted" : "error",
			state.error_count,
		);
		return;
	}

	restoreLoopStatus(ctx);
}

export function registerEventHandlers(pi: ExtensionAPI): void {
	pi.on("session_before_switch", handleSessionBeforeSwitch);
	pi.on("session_before_fork", async (_event, ctx) =>
		handleBlockedSessionMutation("fork", ctx),
	);
	pi.on("session_before_tree", async (_event, ctx) =>
		handleBlockedSessionMutation("tree", ctx),
	);
	pi.on("session_shutdown", async (event, ctx) =>
		handleSessionShutdown(event, ctx),
	);
	pi.on("session_start", handleSessionStart);
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
