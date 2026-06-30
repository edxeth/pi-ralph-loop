/**
 * Sync layer for the Ralph status widget: turns persisted state + bundle
 * artifacts into a StatusView, tracking the cross-snapshot observations
 * (error-count rise, stall) that the pure model needs but can't see in a
 * single frame. See ADR-0001.
 *
 * `buildStatusView` is pure over its inputs (state, parsed bundle data, timing,
 * previous observation) so it is unit-testable without timers or file I/O. The
 * Component below owns the timers and the actual reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { parseBundleItemsJson } from "../bundle/index.js";
import type { BundleItemsFile } from "../bundle/types.js";
import { getTaskBody, readState } from "../state.js";
import type { RalphLoopState } from "../types.js";
import {
	type BundleProgress,
	bundleProgress,
	derivePhase,
	detectColorMode,
	elapsedSince,
	formatElapsed,
	isHeartbeatStale,
	type Phase,
	phaseShimmers,
	progressTail,
} from "./status-model.js";
import { renderStatus, type StatusView } from "./status-render.js";

// Time the elapsed clock stays hidden so instant work doesn't flash a timer.
const ELAPSED_VISIBLE_AFTER_MS = 5_000;
// Heartbeat older than this ⇒ owner process died/unresponsive ⇒ stalled. The
// owner refreshes the heartbeat every 5s, so 30s = 6 missed beats.
const HEARTBEAT_STALE_MS = 30_000;
const TASK_SUMMARY_MAX = 120;

/** Cross-snapshot observation carried between syncs. Only the previous
 * error_count is needed (to infer a fresh provider-error "recovering" turn). */
export interface Observation {
	errorCount: number;
}

interface BundleData {
	items: BundleItemsFile;
	progressMd: string;
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	return (line ?? "").trim();
}

export interface BuildResult {
	view: StatusView;
	observation: Observation;
}

/**
 * Build the StatusView from already-loaded inputs. Pure: same inputs → same
 * output. `prev` is the observation from the last sync (or null on first).
 */
export function buildStatusView(args: {
	state: RalphLoopState;
	bundle: BundleData | null;
	taskBody: string | null;
	now: number;
	prev: Observation | null;
}): BuildResult {
	const { state, bundle, taskBody, now, prev } = args;

	const progress: BundleProgress | null =
		state.bundle_mode && bundle ? bundleProgress(bundle.items) : null;
	const tail = bundle ? progressTail(bundle.progressMd) : null;

	const errorCountRose = prev ? state.error_count > prev.errorCount : false;

	// Stalled only matters while running. The only signal honestly derivable
	// from persisted state is a frozen heartbeat (dead/unresponsive owner); a
	// live heartbeat with no other change is just a long healthy iteration.
	const stalled =
		state.running &&
		isHeartbeatStale(state.owner_heartbeat_at, now, HEARTBEAT_STALE_MS);

	const phase: Phase = derivePhase(state, { errorCountRose, stalled });

	const elapsedMs = elapsedSince(state.started_at, now);
	const elapsed =
		elapsedMs !== null && elapsedMs >= ELAPSED_VISIBLE_AFTER_MS
			? formatElapsed(elapsedMs)
			: null;

	// Plain mode: the iteration count is the only progress signal, so it's the
	// headline. Bundle mode: the item tally (passing/total) is the real progress,
	// so it leads; the iteration budget moves to a dim suffix for context. "iter"
	// is spelled out so it never reads as a task-completion ratio.
	let countLabel: string;
	let countSuffix: string | null;
	if (progress) {
		countLabel = `✓ ${progress.passing}/${progress.total} items`;
		countSuffix = `iteration ${state.iteration}/${state.max_iterations}`;
	} else {
		countLabel = `iteration ${state.iteration}/${state.max_iterations}`;
		countSuffix = null;
	}

	const resultSummary = !state.running
		? buildResultSummary(state, progress, elapsedMs)
		: null;

	const view: StatusView = {
		phase,
		countLabel,
		countSuffix,
		elapsed,
		errorCount: state.error_count,
		bundleMode: state.bundle_mode,
		current: progress?.current ?? null,
		progressTail: tail,
		taskSummary: taskBody ? firstLine(taskBody).slice(0, TASK_SUMMARY_MAX) : null,
		stalled,
		resultSummary,
	};

	return { view, observation: { errorCount: state.error_count } };
}

function buildResultSummary(
	state: RalphLoopState,
	progress: BundleProgress | null,
	elapsedMs: number | null,
): string | null {
	const elapsed = elapsedMs !== null ? `, ${formatElapsed(elapsedMs)}` : "";
	const items = progress ? `, ${progress.passing}/${progress.total}` : "";
	// In bundle mode the item tally is the completion signal, so the iteration
	// count is redundant; show it only in plain mode (no items to report).
	const iters = progress ? "" : `, ${state.iteration} iter`;
	switch (state.stop_reason) {
		case "complete":
			return `Ralph complete${items}${iters}${elapsed}`;
		case "error":
			return `Ralph failed at iteration ${state.iteration}${elapsed}`;
		case "max_iterations":
			return `Ralph hit max iterations (${state.max_iterations})${items}${elapsed}`;
		case "manual_stop":
			return `Ralph stopped${items}${iters}${elapsed}`;
		case "user_cancelled":
			return `Ralph cancelled${items}${iters}${elapsed}`;
		case "interrupted":
			return `Ralph interrupted at iteration ${state.iteration}; resumable`;
		default:
			return null;
	}
}

// ── File reads (impure, kept thin) ─────────────────────────────────────────

function loadBundleData(cwd: string): BundleData | null {
	try {
		const itemsPath = join(cwd, ".ralph", "items.json");
		const progressPath = join(cwd, ".ralph", "progress.md");
		if (!existsSync(itemsPath)) return null;
		const items = parseBundleItemsJson(readFileSync(itemsPath, "utf8"));
		const progressMd = existsSync(progressPath)
			? readFileSync(progressPath, "utf8")
			: "";
		return { items, progressMd };
	} catch {
		return null;
	}
}

// ── Component ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 1_000;
// Shimmer frame cadence. Only runs while the current phase shimmers.
const FRAME_INTERVAL_MS = 90;

export interface StatusWidgetDeps {
	cwd: string;
	tui: { requestRender: () => void };
	theme: Theme;
	now?: () => number;
}

/**
 * The persistent status widget. Owns two timers:
 * - sync (~1s): re-read state + bundle artifacts, rebuild the StatusView,
 *   request a render only when the view actually changed. The elapsed clock
 *   ticks via this sync. After each sync it starts or stops the frame timer
 *   so the shimmer loop only runs while a phase actually shimmers.
 * - frame (~90ms): advance the shimmer tick and re-render. Created only while
 *   the current phase shimmers (actively working) and torn down otherwise, so
 *   an idle/terminal widget runs no frame loop at all.
 */
export class StatusWidget {
	private readonly cwd: string;
	private readonly tui: { requestRender: () => void };
	private readonly theme: Theme;
	private readonly now: () => number;

	private syncTimer: ReturnType<typeof setInterval> | null = null;
	private frameTimer: ReturnType<typeof setInterval> | null = null;

	private view: StatusView | null = null;
	private observation: Observation | null = null;
	private frameTick = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(deps: StatusWidgetDeps) {
		this.cwd = deps.cwd;
		this.tui = deps.tui;
		this.theme = deps.theme;
		this.now = deps.now ?? Date.now;
		this.sync();
		this.syncTimer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
		this.syncTimer.unref?.();
	}

	/** True only while the current phase's label shimmers. */
	private animating(): boolean {
		return this.view !== null && phaseShimmers(this.view.phase);
	}

	/** Start or stop the shimmer frame loop to match the current phase. */
	private syncFrameTimer(): void {
		if (this.animating()) {
			if (!this.frameTimer) {
				this.frameTimer = setInterval(() => this.frame(), FRAME_INTERVAL_MS);
				this.frameTimer.unref?.();
			}
		} else if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = null;
		}
	}

	private frame(): void {
		this.frameTick++;
		this.invalidate();
		this.tui.requestRender();
	}


	private sync(): void {
		const state = readState(this.cwd);
		if (!state) {
			if (this.view) {
				this.view = null;
				this.invalidate();
				this.tui.requestRender();
			}
			this.syncFrameTimer();
			return;
		}
		const bundle = state.bundle_mode ? loadBundleData(this.cwd) : null;
		const taskBody = state.bundle_mode ? null : getTaskBody(this.cwd);
		const { view, observation } = buildStatusView({
			state,
			bundle,
			taskBody,
			now: this.now(),
			prev: this.observation,
		});
		this.observation = observation;
		const changed = !this.view || !sameView(this.view, view);
		this.view = view;
		if (changed) {
			this.invalidate();
			this.tui.requestRender();
		}
		this.syncFrameTimer();
	}

	render(width: number): string[] {
		if (!this.view) return [];
		if (width === this.cachedWidth && this.cachedLines.length) {
			return this.cachedLines;
		}
		const lines = renderStatus(this.view, {
			theme: this.theme,
			width,
			colorMode: detectColorMode(),
			frameTick: this.frameTick,
		});
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	dispose(): void {
		if (this.syncTimer) clearInterval(this.syncTimer);
		if (this.frameTimer) clearInterval(this.frameTimer);
		this.syncTimer = null;
		this.frameTimer = null;
	}
}

/** Shallow structural equality of the fields that affect the render. */
function sameView(a: StatusView, b: StatusView): boolean {
	return (
		a.phase === b.phase &&
		a.countLabel === b.countLabel &&
		a.countSuffix === b.countSuffix &&
		a.elapsed === b.elapsed &&
		a.errorCount === b.errorCount &&
		a.bundleMode === b.bundleMode &&
		a.current === b.current &&
		a.progressTail === b.progressTail &&
		a.taskSummary === b.taskSummary &&
		a.stalled === b.stalled &&
		a.resultSummary === b.resultSummary
	);
}

/** Factory matching ctx.ui.setWidget's component-factory signature. */
export function createStatusWidget(
	cwd: string,
	tui: TUI,
	theme: Theme,
): StatusWidget {
	return new StatusWidget({ cwd, tui, theme });
}
