import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import {
	getLoopOwnerFields,
	isLoopOwnerActive,
	LOOP_OWNER_STALE_AFTER_MS,
	startLoopHeartbeat,
	stopLoopHeartbeat,
} from "../src/loop/ownership.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

function makeState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	return {
		running: true,
		iteration: 1,
		max_iterations: 3,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "owner-session",
		last_session_file: null,
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 0,
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
		...overrides,
	};
}

function oldTimestamp(): string {
	return new Date(Date.now() - LOOP_OWNER_STALE_AFTER_MS - 1_000).toISOString();
}

test("fresh owner heartbeat marks a loop owner active without trusting pid visibility", () => {
	const state = makeState({
		owner_pid: 999_999_999,
		owner_heartbeat_at: new Date().toISOString(),
	});

	assert.equal(isLoopOwnerActive(state, "observer-session"), true);
});

test("stale owner heartbeat marks a loop owner inactive", () => {
	const state = makeState({
		owner_pid: process.pid,
		owner_heartbeat_at: oldTimestamp(),
	});

	assert.equal(isLoopOwnerActive(state, "observer-session"), false);
});

test("legacy loop state uses recent session file activity only for a different startup session", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-owner-legacy-"));
	const sessionFile = join(cwd, "owner-session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	const state = makeState({ last_session_file: sessionFile });

	assert.equal(isLoopOwnerActive(state, "observer-session"), true);
	assert.equal(isLoopOwnerActive(state, "owner-session"), false);
});

test("legacy loop state ignores stale session file activity", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-owner-stale-legacy-"));
	const sessionFile = join(cwd, "owner-session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	const old = new Date(Date.now() - 31 * 60_000);
	utimesSync(sessionFile, old, old);
	const state = makeState({ last_session_file: sessionFile });

	assert.equal(isLoopOwnerActive(state, "observer-session"), false);
});

test("loop heartbeat updates the persisted owner timestamp and stops when ownership changes", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const cwd = mkdtempSync(join(tmpdir(), "ralph-owner-heartbeat-"));
		writeState(cwd, makeState({ ...getLoopOwnerFields(), owner_heartbeat_at: oldTimestamp() }), "task");
		const initialHeartbeat = readState(cwd)?.owner_heartbeat_at;
		assert.ok(initialHeartbeat);

		startLoopHeartbeat(cwd, "token-1");
		mock.timers.tick(5_200);
		const updatedHeartbeat = readState(cwd)?.owner_heartbeat_at;
		assert.ok(updatedHeartbeat);
		assert.notEqual(updatedHeartbeat, initialHeartbeat);

		writeState(
			cwd,
			makeState({
				owner_pid: process.pid + 1,
				owner_heartbeat_at: updatedHeartbeat,
			}),
			"task",
		);
		mock.timers.tick(5_200);
		assert.equal(readState(cwd)?.owner_heartbeat_at, updatedHeartbeat);

		stopLoopHeartbeat(cwd);
		assert.equal(existsSync(join(cwd, ".ralph", "loop.md")), true);
	} finally {
		mock.timers.reset();
	}
});
