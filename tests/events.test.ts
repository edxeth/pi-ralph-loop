import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { registerEventHandlers } from "../events.ts";
import { readState, writeState } from "../state.ts";
import type { RalphLoopState } from "../types.ts";

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

test("session_start sends task text for Ralph-created new sessions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "my task prompt");

	h.handlers.get("session_start")?.({ reason: "new" }, h.ctx);

	// Should send the task text directly.
	assert.deepEqual(h.sentMessages, ["my task prompt"]);
	// Should set the session name.
	assert.ok(h.sessionNames.some((n) => n.includes("2/5")));
	// Should restore status.
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
