import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";
import { clearCommandCtx, getCommandCtx } from "./command-context.js";
import { clearLoopStatus } from "./status.js";

export function finalizeLoop(
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
		clearCommandCtx();
	}
}
