import assert from "node:assert/strict";
import test from "node:test";

import {
	bundleProgress,
	derivePhase,
	elapsedSince,
	formatElapsed,
	isHeartbeatStale,
	phasePresentation,
	progressTail,
} from "../src/loop/status-model.ts";
import type { BundleItemsFile } from "../src/bundle/types.ts";
import type { RalphLoopState } from "../src/types.ts";

function baseState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	return {
		running: true,
		iteration: 1,
		max_iterations: 5,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "s",
		last_session_file: null,
		owner_pid: 123,
		owner_heartbeat_at: "2026-04-08T00:00:00.000Z",
		error_count: 0,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "tok",
		model_provider: null,
		model_id: null,
		thinking_level: null,
		bundle_snapshot_hash: null,
		items_snapshot_hash: null,
		progress_size: null,
		progress_hash: null,
		progress_snapshot: null,
		source_doc_hashes: null,
		bundle_items_snapshot: null,
		git_head: null,
		bundle_rejection_count: 0,
		provider_recovery_fresh_fallback_used: false,
		limit_reminders: null,
		...overrides,
	};
}

// ── derivePhase ────────────────────────────────────────────────────────────

test("derivePhase: working is the default running state", () => {
	assert.equal(derivePhase(baseState()), "working");
});

test("derivePhase: transitioning flag", () => {
	assert.equal(derivePhase(baseState({ transitioning: true })), "transitioning");
});

test("derivePhase: stop/cancel requests beat transitioning", () => {
	assert.equal(
		derivePhase(baseState({ stop_requested: true, transitioning: true })),
		"stopping",
	);
	assert.equal(
		derivePhase(baseState({ cancel_requested: true })),
		"stopping",
	);
});

test("derivePhase: stall beats working/transitioning", () => {
	assert.equal(
		derivePhase(baseState({ transitioning: true }), { stalled: true }),
		"stalled",
	);
});

test("derivePhase: recovering inferred from error-count rise", () => {
	assert.equal(
		derivePhase(baseState(), { errorCountRose: true }),
		"recovering",
	);
});

test("derivePhase: terminal stop_reasons when not running", () => {
	const cases: Array<[RalphLoopState["stop_reason"], string]> = [
		["complete", "done"],
		["error", "failed"],
		["manual_stop", "stopped"],
		["user_cancelled", "stopped"],
		["max_iterations", "stopped"],
		["interrupted", "stopped"],
		[null, "idle"],
	];
	for (const [reason, expected] of cases) {
		assert.equal(
			derivePhase(baseState({ running: false, stop_reason: reason })),
			expected,
			`stop_reason=${reason}`,
		);
	}
});

test("phasePresentation: label + tone for headline phases", () => {
	assert.equal(phasePresentation("working").label, "Loop Running");
	assert.equal(phasePresentation("working").tone, "accent");
	assert.equal(phasePresentation("transitioning").label, "Loop Running");
	assert.equal(phasePresentation("stalled").label, "Loop Stalled");
	assert.equal(phasePresentation("stalled").tone, "error");
	assert.equal(phasePresentation("done").tone, "success");
	assert.equal(phasePresentation("failed").tone, "error");
});

// ── elapsed ──────────────────────────────────────────────────────────────

test("formatElapsed: compact tiers", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(42_000), "42s");
	assert.equal(formatElapsed(12 * 60_000 + 4_000), "12m 04s");
	assert.equal(formatElapsed(3_600_000 + 2 * 60_000), "1h 02m");
	assert.equal(formatElapsed(-5_000), "0s");
});

test("elapsedSince: parses ISO, rejects junk/empty", () => {
	const now = Date.parse("2026-04-08T00:01:00.000Z");
	assert.equal(elapsedSince("2026-04-08T00:00:00.000Z", now), 60_000);
	assert.equal(elapsedSince(null, now), null);
	assert.equal(elapsedSince("not-a-date", now), null);
});

// ── bundle ─────────────────────────────────────────────────────────────────

function items(passes: boolean[]): BundleItemsFile {
	return {
		version: 1,
		items: passes.map((p, i) => ({
			category: "functional",
			description: `item ${i}`,
			steps: ["s"],
			passes: p,
			regression_notes: "",
		})),
	};
}

test("bundleProgress: count + first unfinished description", () => {
	const p = bundleProgress(items([true, true, false, false]));
	assert.equal(p.passing, 2);
	assert.equal(p.total, 4);
	assert.equal(p.current, "item 2");
});

test("bundleProgress: all passing → current null", () => {
	const p = bundleProgress(items([true, true]));
	assert.equal(p.passing, 2);
	assert.equal(p.current, null);
});

test("progressTail: last non-empty trimmed line", () => {
	assert.equal(progressTail("a\nb\n\n  c  \n\n"), "c");
	assert.equal(progressTail(""), null);
	assert.equal(progressTail("\n\n"), null);
});

// ── liveness / stall ───────────────────────────────────────────────────────

test("isHeartbeatStale: missing/junk/old → stale", () => {
	const now = Date.parse("2026-04-08T00:01:00.000Z");
	assert.equal(isHeartbeatStale(null, now, 30_000), true);
	assert.equal(isHeartbeatStale("junk", now, 30_000), true);
	assert.equal(isHeartbeatStale("2026-04-08T00:00:00.000Z", now, 30_000), true);
	assert.equal(isHeartbeatStale("2026-04-08T00:00:45.000Z", now, 30_000), false);
});
