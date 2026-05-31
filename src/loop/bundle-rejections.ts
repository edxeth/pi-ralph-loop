import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";
import type { ControlPromise } from "./control-promise.js";
import { sendWhenIdle } from "./idle.js";

const MAX_BUNDLE_REJECTIONS = 5;

type FinalizeLoop = (
	ctx: ExtensionContext,
	cwd: string,
	stopReason: RalphLoopState["stop_reason"],
	errorCount: number,
) => void;

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

export function rejectBundlePromise(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
	promise: Extract<ControlPromise, "NEXT" | "COMPLETE">,
	rejection: string,
	finalizeLoop: FinalizeLoop,
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
