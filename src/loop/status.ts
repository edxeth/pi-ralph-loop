import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function setLoopStatus(
	ctx: ExtensionContext,
	iteration: number,
	maxIterations: number,
): void {
	ctx.ui.setStatus("ralph-loop", `Ralph ${iteration}/${maxIterations}`);
}

export function clearLoopStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("ralph-loop", undefined);
}
