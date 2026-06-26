import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const LOOP_NOTICE_WIDGET = "ralph-loop-notice";
const LOOP_NOTICE_CLEAR_MS = 2_500;
let _noticeToken = 0;
// Type of the notice currently rendered in the widget, or null when it is
// empty. Used by clearLoopNotice to dismiss problem notices (warnings / errors)
// by default while allowing lifecycle boundaries like resume/restart to clear
// stale info notices too.
let _noticeType: "info" | "warning" | "error" | null = null;

export function setLoopStatus(
	ctx: ExtensionContext,
	iteration: number,
	maxIterations: number,
): void {
	ctx.ui.setStatus("ralph-loop", `Ralph ${iteration}/${maxIterations}`);
}

export function showLoopNotice(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
	options: { autoClear?: boolean } = {},
): void {
	const ui = ctx.ui as ExtensionContext["ui"] & {
		setWidget?: ExtensionContext["ui"]["setWidget"];
	};
	if (ui.setWidget) {
		const token = ++_noticeToken;
		_noticeType = type;
		ui.setWidget(
			LOOP_NOTICE_WIDGET,
			(_tui, theme) => new Text(theme.fg("muted", message), 1, 0),
			{ placement: "aboveEditor" },
		);
		if (options.autoClear) {
			setTimeout(() => {
				if (_noticeToken !== token) return;
				ui.setWidget?.(LOOP_NOTICE_WIDGET, undefined, {
					placement: "aboveEditor",
				});
				_noticeType = null;
			}, LOOP_NOTICE_CLEAR_MS);
		}
		return;
	}

	ctx.ui.notify(message, type);
}

/**
 * Dismiss a stale problem notice (a warning or error) now that the loop has
 * moved on — the model resumed working after a provider error (a new turn or
 * agent_end landed) or a fresh iteration started. Without this, a banner like
 * "Provider error at Ralph iteration N; waiting for Pi's retry handling" sits
 * over a healthy recovering run because nothing else clears it.
 *
 * Info notices ("Ralph loop started", "Starting iteration N") are left alone:
 * they are short confirmations that already auto-clear, so the user still sees
 * them. No-op when the UI has no widget support — there the notify fallback
 * owns its own dismissal.
 */
export function clearLoopNotice(
	ctx: ExtensionContext,
	options: { includeInfo?: boolean } = {},
): void {
	const ui = ctx.ui as ExtensionContext["ui"] & {
		setWidget?: ExtensionContext["ui"]["setWidget"];
	};
	if (!ui.setWidget) return;
	if (
		_noticeType !== "warning" &&
		_noticeType !== "error" &&
		!(options.includeInfo === true && _noticeType === "info")
	) {
		return;
	}
	_noticeType = null;
	ui.setWidget(LOOP_NOTICE_WIDGET, undefined, { placement: "aboveEditor" });
}

export function clearLoopStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("ralph-loop", undefined);
}
