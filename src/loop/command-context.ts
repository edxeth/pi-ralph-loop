import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Stored command context ──────────────────────────────────────────────
// Agent event handlers receive ExtensionContext, which cannot open a new
// session. Ralph stores the latest command-capable context so an accepted NEXT
// promise can call ctx.newSession(). Every replacement must refresh this value
// from newSession({ withSession }) because the previous command context is stale.
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
