import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerEventHandlers } from "../src/events.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeEventsState(
	overrides: Partial<RalphLoopState> = {},
): RalphLoopState {
	const baseState: RalphLoopState = {
		running: true,
		iteration: 2,
		max_iterations: 5,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: "/sessions/session-1.jsonl",
		error_count: 0,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "token-1",
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
	return { ...baseState, ...overrides };
}

function createEventsHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-events-"));
	const handlers = new Map<string, EventHandler>();
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: string[] = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const sessionNames: string[] = [];

	const pi = {
		on(name: string, handler: EventHandler) {
			handlers.set(name, handler);
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
		setSessionName(name: string) {
			sessionNames.push(name);
		},
	} as unknown as ExtensionAPI;

	registerEventHandlers(pi);

	const ctx = {
		cwd,
		ui: {
			theme: { fg: (_token: string, text: string) => text },
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, value: string | undefined) {
				statusUpdates.push({ key, value });
			},
			setWorkingVisible(_visible: boolean) {},
		},
		sessionManager: {
			getSessionId: () => "session-2",
			getSessionFile: () => "/sessions/session-2.jsonl",
		},
	} as unknown as ExtensionContext;

	return {
		cwd,
		handlers,
		notifications,
		sentMessages,
		statusUpdates,
		sessionNames,
		ctx,
	};
}

test("session_before_switch blocks resume while loop is running", async () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState(), "task");

	const result = await h.handlers.get("session_before_switch")?.(
		{ reason: "resume" },
		h.ctx,
	);

	assert.deepEqual(result, { cancel: true });
	assert.deepEqual(h.notifications.at(-1), {
		message:
			"Ralph loop is running. /resume is blocked. Use another pi instance or /ralph-stop.",
		type: "warning",
	});
});

test("session_shutdown marks cancellation request", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState(), "task");

	h.handlers.get("session_shutdown")?.({}, h.ctx);

	assert.equal(readState(h.cwd)?.cancel_requested, true);
});

test("session_shutdown leaves a quit during a committed handoff resumable", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// Resumable, not a fatal error: a valid NEXT already advanced the iteration.
	assert.equal(state?.stop_reason, "interrupted");
	assert.equal(state?.transitioning, false);
});

test("session_shutdown preserves Ralph-managed new-session transitions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_shutdown")?.({ reason: "new" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.transitioning, true);
	assert.equal(state?.stop_reason, null);
});

test("session_start restores status for Ralph-created new sessions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "my task prompt");

	h.handlers.get("session_start")?.({ reason: "new" }, h.ctx);

	assert.deepEqual(h.sentMessages, []);
	assert.deepEqual(h.sessionNames, []);
	assert.ok(
		h.statusUpdates.some(
			(u) => u.key === "ralph-loop" && u.value !== undefined,
		),
	);
});

test("session_start does nothing for non-transitioning sessions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: false }), "task");

	h.handlers.get("session_start")?.({ reason: "new" }, h.ctx);

	// Should not send any messages.
	assert.deepEqual(h.sentMessages, []);
});

test("session_start on startup marks a crashed committed handoff resumable", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// A NEXT already advanced the iteration before the crash; keep it resumable.
	assert.equal(state?.stop_reason, "interrupted");
});

test("session_start on startup errors a crashed mid-iteration loop", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: false }), "task");

	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// No committed handoff: a mid-iteration crash is still a fatal error.
	assert.equal(state?.stop_reason, "error");
});
