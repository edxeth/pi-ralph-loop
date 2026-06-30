/**
 * Pure, TUI-free logic for the Ralph loop status widget.
 *
 * Everything here is a pure function of persisted state (`.ralph/loop.md`
 * frontmatter) plus parsed bundle artifacts and a few observation hints the
 * sync layer tracks over time (error-count deltas, time since last change).
 * No timers, no rendering, no theme — so it is trivially unit-testable.
 *
 * See ADR-0001: the widget reads persisted state, not in-process loop events.
 * Consequence captured here: WAIT and a live "recovering" turn have no
 * dedicated persisted flag. `recovering` is inferred from an observed
 * error_count rise; a long WAIT (or any wedged owner) surfaces as a stall via
 * heartbeat / observable-signature staleness, not a fake phase.
 */

import type { BundleItem, BundleItemsFile } from "../bundle/types.js";
import type { RalphLoopState } from "../types.js";

// ── Phase ────────────────────────────────────────────────────────────────

export type Phase =
	| "idle"
	| "working"
	| "transitioning"
	| "recovering"
	| "stalled"
	| "stopping"
	| "done"
	| "stopped"
	| "failed";

/** How a phase is presented: a header label, a glyph, and a theme tone. */
export interface PhasePresentation {
	label: string;
	/** Single-cell glyph (used on terminal-state summary lines). */
	glyph: string;
	/** Semantic theme-token name (theme.fg(tone, …)). */
	tone: "accent" | "success" | "warning" | "error" | "muted";
}

const PHASE_PRESENTATION: Record<Phase, PhasePresentation> = {
	idle: { label: "Idle", glyph: "·", tone: "muted" },
	working: { label: "Loop Running", glyph: "●", tone: "accent" },
	transitioning: { label: "Loop Running", glyph: "●", tone: "accent" },
	recovering: { label: "Loop Recovering", glyph: "↻", tone: "warning" },
	stalled: { label: "Loop Stalled", glyph: "!", tone: "error" },
	stopping: { label: "Loop Stopping", glyph: "■", tone: "warning" },
	done: { label: "Done", glyph: "✓", tone: "success" },
	stopped: { label: "Stopped", glyph: "■", tone: "muted" },
	failed: { label: "Failed", glyph: "✗", tone: "error" },
};

export function phasePresentation(phase: Phase): PhasePresentation {
	return PHASE_PRESENTATION[phase];
}

/** Observation hints the sync layer derives by comparing snapshots over time. */
export interface PhaseObservation {
	/** error_count rose since the previous observed snapshot. */
	errorCountRose?: boolean;
	/** No observable change for the stall threshold while still running. */
	stalled?: boolean;
}

/**
 * Collapse the loop's scattered runtime flags into one headline Phase.
 * Pure over persisted state plus optional observation hints.
 */
export function derivePhase(
	state: RalphLoopState,
	obs: PhaseObservation = {},
): Phase {
	if (!state.running) {
		switch (state.stop_reason) {
			case "complete":
				return "done";
			case "error":
				return "failed";
			case null:
			case undefined:
				return "idle";
			default:
				// manual_stop | user_cancelled | max_iterations | interrupted
				return "stopped";
		}
	}

	if (state.stop_requested || state.cancel_requested) return "stopping";
	// A wedged/dead owner beats the optimistic "working" reading.
	if (obs.stalled) return "stalled";
	if (state.transitioning) return "transitioning";
	if (obs.errorCountRose) return "recovering";
	return "working";
}

/**
 * Phases whose header label shimmers (the only on-frame motion in the widget).
 * Limited to the actively-working phases so trouble states (stalled/stopping/
 * recovering) read as calm, not lively. Single source of truth shared by the
 * renderer (whether to shimmer) and the widget (whether to run the frame timer).
 */
export function phaseShimmers(phase: Phase): boolean {
	return phase === "working" || phase === "transitioning";
}

// ── Color capability + truecolor shimmer ────────────────────────────

export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

/**
 * Detect terminal color capability from environment. Honors NO_COLOR (present
 * and non-empty disables color) and COLORTERM=truecolor|24bit for the shimmer.
 */
export function detectColorMode(
	env: Record<string, string | undefined> = process.env,
): ColorMode {
	if (env.NO_COLOR != null && env.NO_COLOR !== "") return "none";
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("256color")) return "ansi256";
	return "ansi16";
}

export type Rgb = [number, number, number];

/** Linear interpolation between two RGB colors. t clamped to [0,1]. */
function lerpColor(a: Rgb, b: Rgb, t: number): Rgb {
	const k = Math.min(1, Math.max(0, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}

/** Truecolor SGR-wrapped text. */
function truecolor(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

/**
 * Shimmer: a bright highlight band sweeping across the text, blended over a
 * base color per character (truecolor). Pure: a given (text, tick) always
 * yields the same string. The band travels off both ends so the sweep enters
 * and exits smoothly. Visible text is unchanged (only SGR escapes are added).
 */
export function shimmer(
	text: string,
	base: Rgb,
	highlight: Rgb,
	tick: number,
): string {
	const chars = [...text];
	const n = chars.length;
	if (n === 0) return "";
	const band = 3;
	const speed = 0.5;
	const span = n + band * 2;
	const center = ((((tick * speed) % span) + span) % span) - band;
	return chars
		.map((ch, i) => {
			const t = Math.max(0, 1 - Math.abs(i - center) / band);
			return truecolor(lerpColor(base, highlight, t), ch);
		})
		.join("");
}

// ── Elapsed formatting ─────────────────────────────────────────────────────

/** Compact elapsed: "42s", "12m 04s", "1h 02m". Clamps negatives to 0. */
export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

/** Elapsed since an ISO timestamp, or null when unparseable/empty. */
export function elapsedSince(
	startedAt: string | null,
	now: number,
): number | null {
	if (!startedAt) return null;
	const start = Date.parse(startedAt);
	if (Number.isNaN(start)) return null;
	return Math.max(0, now - start);
}

// ── Bundle progress ──────────────────────────────────────────────────────

export interface BundleProgress {
	passing: number;
	total: number;
	/** Description of the first not-yet-passing item, or null when all pass. */
	current: string | null;
}

export function bundleProgress(items: BundleItemsFile): BundleProgress {
	const list: BundleItem[] = items.items;
	let passing = 0;
	let current: string | null = null;
	for (const item of list) {
		if (item.passes) {
			passing++;
		} else if (current === null) {
			current = item.description;
		}
	}
	return { passing, total: list.length, current };
}

/** Last non-empty, trimmed line of progress.md (the "what just happened"). */
export function progressTail(progressMd: string): string | null {
	const lines = progressMd.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line) return line;
	}
	return null;
}

// ── Liveness / stall ───────────────────────────────────────────────────────

/**
 * Heartbeat older than staleMs (or missing/unparseable) → stale owner.
 *
 * This is the only stall signal the widget can honestly derive. The owner
 * process refreshes `owner_heartbeat_at` on a timer while alive; a frozen
 * heartbeat means the process died or is unresponsive. "No progress while the
 * heartbeat still ticks" is deliberately NOT treated as a stall: a single Ralph
 * iteration is a whole agent turn that legitimately persists nothing for
 * minutes (within-iteration verification isn't written to state until the turn
 * ends, see ADR-0001), so a no-progress timer would false-flag healthy work.
 */
export function isHeartbeatStale(
	heartbeatAt: string | null,
	now: number,
	staleMs: number,
): boolean {
	if (!heartbeatAt) return true;
	const beat = Date.parse(heartbeatAt);
	if (Number.isNaN(beat)) return true;
	return now - beat > staleMs;
}
