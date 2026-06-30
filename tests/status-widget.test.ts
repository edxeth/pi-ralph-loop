import assert from "node:assert/strict";
import test from "node:test";

import {
	buildStatusView,
	type Observation,
} from "../src/loop/status-widget.ts";
import type { BundleItemsFile } from "../src/bundle/types.ts";
import type { RalphLoopState } from "../src/types.ts";

const T0 = Date.parse("2026-04-08T00:00:00.000Z");

function state(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	return {
		running: true,
		iteration: 2,
		max_iterations: 10,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "s",
		last_session_file: null,
		owner_pid: 1,
		owner_heartbeat_at: "2026-04-08T00:00:00.000Z",
		error_count: 0,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "tok",
		model_provider: "openai",
		model_id: "gpt-5-codex",
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

test("plain mode: count label, task summary, elapsed", () => {
	const { view } = buildStatusView({
		state: state({ iteration: 3, max_iterations: 10 }),
		bundle: null,
		taskBody: "do the work\nmore detail",
		now: T0 + 30_000,
		prev: null,
	});
	assert.equal(view.countLabel, "iteration 3/10");
	assert.equal(view.countSuffix, null);
	assert.equal(view.taskSummary, "do the work");
	assert.equal(view.phase, "working");
	assert.equal(view.elapsed, "30s");
});

test("elapsed hidden before the 5s threshold", () => {
	const { view } = buildStatusView({
		state: state(),
		bundle: null,
		taskBody: null,
		now: T0 + 2_000,
		prev: null,
	});
	assert.equal(view.elapsed, null);
});

test("bundle mode: count is iteration-based, current item from items.json", () => {
	const { view } = buildStatusView({
		state: state({ bundle_mode: true, iteration: 2, max_iterations: 8 }),
		bundle: { items: items([true, true, false, false, false]), progressMd: "iter 1: did A\niter 2: did B" },
		taskBody: null,
		now: T0 + 60_000,
		prev: null,
	});
	assert.equal(view.bundleMode, true);
	// Bundle mode: item tally is the headline, iteration budget is the dim suffix.
	assert.equal(view.countLabel, "✓ 2/5 items");
	assert.equal(view.countSuffix, "iteration 2/8");
	assert.equal(view.current, "item 2");
	assert.equal(view.progressTail, "iter 2: did B");
});

test("recovering: inferred when error_count rises vs prev observation", () => {
	const prev: Observation = { errorCount: 0 };
	const { view } = buildStatusView({
		state: state({ error_count: 1, owner_heartbeat_at: "2026-04-08T00:00:29.000Z" }),
		bundle: null,
		taskBody: null,
		now: T0 + 30_000,
		prev,
	});
	assert.equal(view.phase, "recovering");
	assert.equal(view.errorCount, 1);
});

test("stall: a live heartbeat with no other change is NOT stalled", () => {
	// A long healthy iteration: nothing in state changes for a while, but the
	// owner keeps refreshing its heartbeat. Must not read as stalled.
	const { view } = buildStatusView({
		state: state({ owner_heartbeat_at: "2026-04-08T00:04:58.000Z" }),
		bundle: null,
		taskBody: null,
		now: T0 + 300_000, // 5m in, heartbeat 2s old
		prev: { errorCount: 0 },
	});
	assert.notEqual(view.phase, "stalled");
	assert.equal(view.stalled, false);
});

test("stall: a frozen heartbeat past the stale window flips to stalled", () => {
	const { view } = buildStatusView({
		// heartbeat frozen at T0, now 31s later (> 30s stale window).
		state: state({ owner_heartbeat_at: "2026-04-08T00:00:00.000Z" }),
		bundle: null,
		taskBody: null,
		now: T0 + 31_000,
		prev: { errorCount: 0 },
	});
	assert.equal(view.stalled, true);
	assert.equal(view.phase, "stalled");
});

test("stall: a missing heartbeat while running reads as stalled", () => {
	const { view } = buildStatusView({
		state: state({ owner_heartbeat_at: null }),
		bundle: null,
		taskBody: null,
		now: T0 + 31_000,
		prev: { errorCount: 0 },
	});
	assert.equal(view.stalled, true);
});

test("finished: result summary set, phase terminal", () => {
	const complete = buildStatusView({
		state: state({ running: false, stop_reason: "complete", bundle_mode: true, iteration: 5 }),
		bundle: { items: items([true, true, true]), progressMd: "" },
		taskBody: null,
		now: T0 + 480_000,
		prev: null,
	});
	assert.equal(complete.view.phase, "done");
	assert.match(complete.view.resultSummary ?? "", /Ralph complete/);
	assert.match(complete.view.resultSummary ?? "", /3\/3/);
	// Bundle mode: item tally is the completion signal, iter is omitted.
	assert.ok(!/iter/.test(complete.view.resultSummary ?? ""));

	const plainComplete = buildStatusView({
		state: state({ running: false, stop_reason: "manual_stop", iteration: 7 }),
		bundle: null,
		taskBody: null,
		now: T0 + 60_000,
		prev: null,
	});
	// Plain mode: no items, so the iteration count stays.
	assert.match(plainComplete.view.resultSummary ?? "", /7 iter/);
	const failed = buildStatusView({
		state: state({ running: false, stop_reason: "error", iteration: 4 }),
		bundle: null,
		taskBody: null,
		now: T0 + 60_000,
		prev: null,
	});
	assert.equal(failed.view.phase, "failed");
	assert.match(failed.view.resultSummary ?? "", /failed at iteration 4/);
});

test("idle: not running with no stop_reason → idle phase, no summary", () => {
	const { view } = buildStatusView({
		state: state({ running: false, stop_reason: null }),
		bundle: null,
		taskBody: null,
		now: T0,
		prev: null,
	});
	assert.equal(view.phase, "idle");
	assert.equal(view.resultSummary, null);
});

test("observation carries the latest error count across syncs", () => {
	const a = buildStatusView({
		state: state({ error_count: 2 }),
		bundle: null,
		taskBody: null,
		now: T0 + 5_000,
		prev: null,
	});
	assert.equal(a.observation.errorCount, 2);
});
