import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	getTaskBody,
	readState,
	updateState,
	writeState,
} from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

function makeState(): RalphLoopState {
	return {
		running: true,
		iteration: 2,
		max_iterations: 5,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: "/sessions/session-1.jsonl",
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 1,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "token-1",
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
		limit_reminders: null,
	};
}

test("state round-trips and preserves task body", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-"));
	const state = makeState();
	const task = "implement feature x";

	writeState(cwd, state, task);

	assert.deepEqual(readState(cwd), state);
	assert.equal(getTaskBody(cwd), task);

	updateState(cwd, {
		iteration: 3,
		stop_requested: true,
	});

	assert.deepEqual(readState(cwd), {
		...state,
		iteration: 3,
		stop_requested: true,
	});
	assert.equal(getTaskBody(cwd), task);
});

test("old state files parse with default bundle metadata", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-old-"));
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(
		join(cwd, ".ralph", "loop.md"),
		[
			"---",
			"running: true",
			"iteration: 1",
			"max_iterations: 3",
			'started_at: "2026-04-08T00:00:00.000Z"',
			"completed_at: null",
			"stop_reason: null",
			'session_id: "session-1"',
			"last_session_file: null",
			"error_count: 0",
			"transitioning: false",
			"cancel_requested: false",
			"stop_requested: false",
			"---",
			"",
			"legacy task",
			"",
		].join("\n"),
		"utf8",
	);

	const state = readState(cwd);
	assert.equal(state?.bundle_mode, false);
	assert.ok(state?.loop_token);
	assert.equal(state?.owner_pid, null);
	assert.equal(state?.owner_heartbeat_at, null);
	assert.equal(state?.model_provider, null);
	assert.equal(state?.model_id, null);
	assert.equal(state?.thinking_level, null);
	assert.equal(state?.bundle_snapshot_hash, null);
	assert.equal(state?.items_snapshot_hash, null);
	assert.equal(state?.progress_size, null);
	assert.equal(state?.progress_hash, null);
	assert.equal(state?.progress_snapshot, null);
	assert.equal(state?.source_doc_hashes, null);
	assert.equal(state?.git_head, null);
	assert.equal(state?.bundle_rejection_count, 0);
	assert.equal(state?.limit_reminders, null);
	assert.equal(getTaskBody(cwd), "legacy task");
});
