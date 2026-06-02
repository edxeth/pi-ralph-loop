import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const LOOP_NOTICE_WIDGET = "ralph-loop-notice";
const LOOP_NOTICE_CLEAR_MS = 2_500;
let _noticeToken = 0;

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
			}, LOOP_NOTICE_CLEAR_MS);
		}
		return;
	}

	ctx.ui.notify(message, type);
}

export function clearLoopStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("ralph-loop", undefined);
}
