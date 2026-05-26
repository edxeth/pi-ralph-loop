import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Stored command context ──────────────────────────────────────────────
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

export function getCommandCtx(): ExtensionCommandContext | null {
	return (
		((globalThis as Record<string, unknown>)[
			CTX_KEY
		] as ExtensionCommandContext | null) ?? null
	);
}

export function setCommandCtx(ctx: ExtensionCommandContext | null): void {
	(globalThis as Record<string, unknown>)[CTX_KEY] = ctx;
}

export function clearCommandCtx(): void {
	setCommandCtx(null);
}

export async function createFreshSession(
	ctx: ExtensionCommandContext,
): Promise<{ cancelled: boolean }> {
	return ctx.newSession({
		withSession: async (nextCtx) => {
			setCommandCtx(nextCtx);
		},
	});
}
