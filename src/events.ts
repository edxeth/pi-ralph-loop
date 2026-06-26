import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { finalizeLoop } from "./loop/finalize.js";
import { isLoopOwnerActive } from "./loop/ownership.js";
import {
	handleLoopAgentEnd,
	handleLoopInput,
	handleLoopTurnEnd,
} from "./loop-engine.js";
import {
	updateLoopModelStateFromContext,
	updateLoopSelectedModel,
	updateLoopThinkingLevel,
} from "./loop/model-state.js";
import { readState, updateState } from "./state.js";

const BLOCKED_TOOLS_ENV = "RALPH_BLOCKED_TOOLS";

function isLoopRunning(cwd: string): boolean {
	return readState(cwd)?.running === true;
}

function getBlockedToolNames(): Set<string> {
	return new Set(
		(process.env[BLOCKED_TOOLS_ENV] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0),
	);
}

function getBlockedToolReason(toolName: string): string {
	return `Tool "${toolName}" is illegal to use during Ralph loops because it can block loop execution. The user is AFK during these loops; this is fully AI-driven development without human intervention.`;
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

function handleBlockedToolCall(event: ToolCallEvent, ctx: ExtensionContext) {
	if (!isLoopRunning(ctx.cwd)) return;

	const blockedToolNames = getBlockedToolNames();
	if (!blockedToolNames.has(event.toolName)) return;

	const reason = getBlockedToolReason(event.toolName);
	ctx.ui.notify(reason, "warning");
	return { block: true, reason };
}

function handleSessionShutdown(
	event: { reason?: "quit" | "reload" | "new" | "resume" | "fork" },
	ctx: ExtensionContext,
) {
	const cwd = ctx.cwd;
	const state = readState(cwd);
	if (!state?.running) return;

	// Only the loop's owner process may cancel it by shutting down. Any other
	// pi process in this workspace (a one-shot `pi -p`, a helper spawned by some
	// extension, an observer session, or a second `pi` window) that exits is a
	// no-op — its pid differs from the recorded owner_pid. owner_pid is the
	// identity gate; crash/reboot recovery is handled separately by the heartbeat
	// on session_start, so do not treat pid alone as a liveness proof.
	if (state.owner_pid !== null && state.owner_pid !== process.pid) return;

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
		// Pi booted and found a loop still marked running. Another Pi instance may
		// already own that loop in this workspace, so startup cleanup must first
		// prove the owner is stale. Otherwise an observer session can mark the loop
		// as error while the real iteration continues and later emits a valid NEXT.
		if (isLoopOwnerActive(state, ctx.sessionManager.getSessionId())) {
			restoreLoopStatus(ctx);
			return;
		}

		// The saved owner is stale: the previous process died without a clean
		// shutdown event (hard crash, kill, OOM). If it died mid-handoff after a
		// committed NEXT, mark it resumable; otherwise treat the interrupted
		// iteration as an error.
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
	pi.on("tool_call", handleBlockedToolCall);
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
	pi.on("model_select", (event, ctx) =>
		updateLoopSelectedModel(ctx, event.model),
	);
	pi.on("thinking_level_select", (event, ctx) =>
		updateLoopThinkingLevel(ctx, event.level),
	);
	pi.on("before_agent_start", (_event, ctx) =>
		updateLoopModelStateFromContext(pi, ctx),
	);
	pi.on("input", (event, ctx) => handleLoopInput(event, ctx));
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
