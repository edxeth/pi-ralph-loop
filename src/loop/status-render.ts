/**
 * Pure renderer for the Ralph status widget. Takes a precomputed StatusView
 * (built by the sync layer from persisted state — see ADR-0001) plus a theme
 * and width, and returns the lines to display.
 *
 * Pure: no timers, no file I/O, no global state, no animation. A given
 * (view, width) always renders the same lines. The live "working" motion is
 * left to Pi's own streaming spinner; this widget shows the durable facts:
 * what loop is running, for how long, the iteration count, and the current
 * unit of work.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	type ColorMode,
	type Phase,
	phasePresentation,
	phaseShimmers,
	type Rgb,
	shimmer,
} from "./status-model.js";

/** Minimal slice of the pi-tui Theme we depend on (lets tests pass a fake). */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Everything the renderer needs, precomputed by the sync layer. */
export interface StatusView {
	phase: Phase;
	/** Headline count: "iteration 3/10" (plain) or "✓ 2/5 items" (bundle). */
	countLabel: string;
	/** Dim secondary count after the headline, e.g. the iteration budget in
	 * bundle mode. Null in plain mode (the iteration count is the headline). */
	countSuffix: string | null;
	elapsed: string | null;
	errorCount: number;
	bundleMode: boolean;
	/** Bundle: current unfinished item description. */
	current: string | null;
	/** Bundle: last progress.md line. */
	progressTail: string | null;
	/** Plain: truncated task summary. */
	taskSummary: string | null;
	stalled: boolean;
	/** When the loop just finished: a one-line result summary (overrides body). */
	resultSummary: string | null;
}

export interface RenderOptions {
	theme: ThemeLike;
	width: number;
	/** Terminal color capability; truecolor enables the label shimmer. */
	colorMode: ColorMode;
	/** Monotonic animation tick (one per frame) driving the shimmer sweep. */
	frameTick: number;
}

// Shimmer endpoints for the "Loop Running" label (truecolor only): a burnt-
// orange ember (#BE6E32) sweeping up to a bright amber crest (#FFBE78).
const LABEL_SHIMMER_BASE: Rgb = [190, 110, 50];
const LABEL_SHIMMER_HIGHLIGHT: Rgb = [255, 190, 120];

/**
 * Identity line: phase label, then the elapsed clock inline after a dim dot.
 * The label shimmers in truecolor while the phase is an actively-working one;
 * every other case shows it in the static phase tone.
 */
function renderIdentityLine(view: StatusView, opts: RenderOptions): string {
	const { theme, width } = opts;
	const p = phasePresentation(view.phase);
	const elapsed = view.elapsed ?? "";
	const suffix = elapsed ? ` · ${elapsed}` : "";
	// Leading tone-colored phase glyph anchors the line (matches the summary
	// line's glyph language). Static tone even while the label shimmers, so it
	// reads as a steady status dot.
	const glyph = `${p.glyph} `;
	const styledGlyph = theme.fg(p.tone, glyph);
	const label = truncateToWidth(
		p.label,
		Math.max(0, width - visibleWidth(glyph) - visibleWidth(suffix)),
	);
	const styledLabel =
		opts.colorMode === "truecolor" && phaseShimmers(view.phase)
			? theme.bold(
					shimmer(
						label,
						LABEL_SHIMMER_BASE,
						LABEL_SHIMMER_HIGHLIGHT,
						opts.frameTick,
					),
				)
			: theme.bold(theme.fg(p.tone, label));
	const styledSuffix = suffix ? theme.fg("dim", suffix) : "";
	// Final guard: the glyph and suffix are fixed-width, so clamp the whole
	// assembled line in case it still exceeds width at very narrow sizes.
	return truncateToWidth(styledGlyph + styledLabel + styledSuffix, width);
}

/** Detail line: iteration count, then what's being worked on. */
function renderWorkLine(view: StatusView, opts: RenderOptions): string {
	const { theme, width } = opts;
	const p = phasePresentation(view.phase);
	const count = view.countLabel;
	// Dim secondary count (bundle mode's iteration budget), inline after the
	// headline tally with a separator dot.
	const countSuffix = view.countSuffix ? ` · ${view.countSuffix}` : "";
	const err = view.errorCount > 0 ? `  err ${view.errorCount}` : "";
	// Count, its suffix, and err are fixed-width; the work text gets what's left.
	const used =
		visibleWidth(count) +
		visibleWidth(countSuffix) +
		3 /* "  " + at least 1 */ +
		visibleWidth(err);
	const workBudget = Math.max(0, width - used);
	const work = workText(view);
	const workVisible = work ? truncateToWidth(work, workBudget) : "";

	const styledCount = theme.bold(theme.fg(p.tone, count));
	const styledCountSuffix = countSuffix ? theme.fg("dim", countSuffix) : "";
	const styledErr = err ? theme.fg("error", err.trimStart()) : "";
	const styledWork = workVisible ? theme.fg("dim", workVisible) : "";

	const parts = [styledCount + styledCountSuffix];
	if (styledWork) parts.push(styledWork);
	if (styledErr) parts.push(styledErr);
	// Final guard: count + err are fixed-width and not truncated above, so clamp
	// the assembled line to width for the narrow / long-value cases.
	return truncateToWidth(parts.join("  "), width);
}

/** What the loop is working on: bundle item, else progress tail, else task. */
function workText(view: StatusView): string | null {
	if (view.bundleMode) {
		if (view.current) return `→ ${view.current}`;
		if (view.progressTail) return view.progressTail;
		return null;
	}
	return view.taskSummary;
}

/**
 * Render the widget. Returns 1-2 lines:
 * - finished (resultSummary set): a single summary line.
 * - active: identity line (label + elapsed) + work line (count + current work).
 */
export function renderStatus(view: StatusView, opts: RenderOptions): string[] {
	if (view.resultSummary) {
		const p = phasePresentation(view.phase);
		return [
			opts.theme.fg(
				p.tone,
				truncateToWidth(`${p.glyph} ${view.resultSummary}`, opts.width),
			),
		];
	}

	return [renderIdentityLine(view, opts), renderWorkLine(view, opts)];
}
