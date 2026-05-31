import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Send a user message as soon as the agent is idle.
 *
 * While the agent is still streaming, poll every 250ms and retry; calling
 * sendUserMessage mid-stream would not start a fresh prompt. The timer is
 * unref'd so a pending send never keeps the process alive on its own.
 */
export function sendWhenIdle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	const timeout = setTimeout(() => sendWhenIdle(pi, ctx, message), 250);
	timeout.unref?.();
}
