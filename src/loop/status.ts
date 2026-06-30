import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createStatusWidget } from "./status-widget.js";

const LOOP_NOTICE_WIDGET = "ralph-loop-notice";
const LOOP_STATUS_WIDGET = "ralph-loop-status";
// How long the status widget lingers after the loop finishes so it can render
// the auto-clearing result summary before it is removed.
const STATUS_FINISH_LINGER_MS = 4_000;
// Bumped on every mount; a delayed unmount only fires when its captured token
// still matches, so a newly-started loop is never torn down by a stale timer.
let _statusWidgetToken = 0;
const LOOP_NOTICE_CLEAR_MS = 2_500;
let _noticeToken = 0;
// Type of the notice currently rendered in the widget, or null when it is
// empty. Used by clearLoopNotice to dismiss problem notices (warnings / errors)
// by default while allowing lifecycle boundaries like resume/restart to clear
// stale info notices too.
let _noticeType: "info" | "warning" | "error" | null = null;

// Narrow ctx.ui to expose setWidget as optional. It is required on the real API
// type and present on every shipped host, but the commands test harness mocks a
// ui without it, and showLoopNotice depends on that absence to select its
// ctx.ui.notify() fallback path. Keep it optional so that fallback stays live.
type WidgetUi = ExtensionContext["ui"] & {
	setWidget?: ExtensionContext["ui"]["setWidget"];
};
function widgetUi(ctx: ExtensionContext): WidgetUi {
	return ctx.ui as WidgetUi;
}

export function setLoopStatus(
	ctx: ExtensionContext,
	iteration: number,
	maxIterations: number,
): void {
	ctx.ui.setStatus("ralph-loop", `Ralph ${iteration}/${maxIterations}`);
	mountStatusWidget(ctx);
}

/**
 * Mount the live status widget above the editor. Idempotent: setWidget disposes
 * the previous instance (and its timers) before creating a new one, and each
 * fresh-session handoff re-mounts it. The widget reads .ralph/loop.md and the
 * bundle artifacts itself (ADR-0001), so it needs no per-iteration data here.
 * No-op when the host UI lacks setWidget (e.g. the commands test mock).
 */
function mountStatusWidget(ctx: ExtensionContext): void {
	const ui = widgetUi(ctx);
	if (!ui.setWidget) return;
	const cwd = ctx.cwd;
	_statusWidgetToken++;
	ui.setWidget(
		LOOP_STATUS_WIDGET,
		(tui, theme) => createStatusWidget(cwd, tui, theme),
		{ placement: "aboveEditor" },
	);
}

function unmountStatusWidget(ctx: ExtensionContext): void {
	const ui = widgetUi(ctx);
	if (!ui.setWidget) return;
	// Linger briefly so the widget's own sync reads running:false and renders
	// the result summary, then remove it. Guard against a loop that restarts
	// during the linger window.
	const token = ++_statusWidgetToken;
	const timer = setTimeout(() => {
		if (_statusWidgetToken !== token) return;
		ui.setWidget?.(LOOP_STATUS_WIDGET, undefined, { placement: "aboveEditor" });
	}, STATUS_FINISH_LINGER_MS);
	timer.unref?.();
}

export function showLoopNotice(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
	options: { autoClear?: boolean } = {},
): void {
	const ui = widgetUi(ctx);
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
	const ui = widgetUi(ctx);
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
	unmountStatusWidget(ctx);
}
