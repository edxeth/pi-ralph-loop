import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import ralphLoopExtension from "../index.ts";
import { readState, writeState } from "../state.ts";
import type { RalphLoopState } from "../types.ts";

type CommandDef = {
	description?: string;
	getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type SessionStartHandler = (
	event: { reason: string },
	ctx: ExtensionContext,
) => Promise<void>;

type Harness = {
	cwd: string;
	commands: Map<string, CommandDef>;
	sessionStart: SessionStartHandler;
	sentMessages: string[];
	notifications: Array<{ message: string; type: string }>;
	commandCtx: ExtensionCommandContext;
	eventCtx: ExtensionContext;
};

function makeState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
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
	};
	return { ...baseState, ...overrides };
}

function createHarness(): Harness {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-index-"));
	const commands = new Map<string, CommandDef>();
	const events = new Map<string, unknown>();
	const sentMessages: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];

	const ui = {
		theme: { fg: (_token: string, text: string) => text },
		notify(message: string, type: string) {
			notifications.push({ message, type });
		},
		setStatus(key: string, value: string | undefined) {
			statusUpdates.push({ key, value });
		},
	};

	const sessionManager = {
		getSessionId: () => "session-1",
		getSessionFile: () => "/sessions/session-1.jsonl",
	};

	const pi = {
		registerCommand(name: string, command: CommandDef) {
			commands.set(name, command);
		},
		on(name: string, handler: unknown) {
			events.set(name, handler);
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
		setSessionName(_name: string) {},
	} as unknown as ExtensionAPI;

	ralphLoopExtension(pi);

	return {
		cwd,
		commands,
		sessionStart: events.get("session_start") as SessionStartHandler,
		sentMessages,
		notifications,
		commandCtx: {
			cwd,
			ui: { ...ui, setWorkingVisible(_v: boolean) {} },
			sessionManager,
		} as unknown as ExtensionCommandContext,
		eventCtx: {
			cwd,
			ui: { ...ui, setWorkingVisible(_v: boolean) {} },
			sessionManager,
		} as unknown as ExtensionContext,
	};
}

test("extension registers core commands", () => {
	const h = createHarness();

	for (const name of [
		"ralph-loop",
		"ralph-resume",
		"ralph-restart",
		"ralph-stop",
		"ralph-status",
	]) {
		assert.ok(h.commands.has(name));
	}
});

test("ralph-loop rejects invalid args", async () => {
	const h = createHarness();

	await h.commands.get("ralph-loop")?.handler("", h.commandCtx);

	assert.deepEqual(h.notifications.at(-1), {
		message: 'Usage: /ralph-loop "task text" [--max-iterations=N]',
		type: "error",
	});
});

test("ralph-loop refuses to start while loop is already running", async () => {
	const h = createHarness();
	writeState(h.cwd, makeState(), "task");

	await h.commands.get("ralph-loop")?.handler('"task"', h.commandCtx);

	assert.deepEqual(h.notifications.at(-1), {
		message: "A Ralph loop is already running",
		type: "error",
	});
});

test("ralph-stop marks persisted state for stopping", async () => {
	const h = createHarness();
	writeState(h.cwd, makeState(), "task");

	await h.commands.get("ralph-stop")?.handler("", h.commandCtx);

	assert.equal(readState(h.cwd)?.stop_requested, true);
	assert.deepEqual(h.notifications.at(-1), {
		message: "Ralph loop will stop after the current iteration",
		type: "info",
	});
});

test("session_start sends task text for Ralph-created new sessions", async () => {
	const h = createHarness();
	writeState(h.cwd, makeState({ transitioning: true }), "task");

	await h.sessionStart({ reason: "new" }, h.eventCtx);

	// Event-driven architecture: session_start sends the task text directly.
	assert.deepEqual(h.sentMessages, ["task"]);
});