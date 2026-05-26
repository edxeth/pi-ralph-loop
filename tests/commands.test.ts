import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerCommands } from "../src/commands.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type CommandDef = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

function makeCommandsState(
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
	};
	return { ...baseState, ...overrides };
}

function createCommandsHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-commands-"));
	const commands = new Map<string, CommandDef>();
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: string[] = [];
	let newSessionCount = 0;

	const pi = {
		registerCommand(name: string, command: CommandDef) {
			commands.set(name, command);
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
		setSessionName(_name: string) {},
	} as unknown as ExtensionAPI;

	registerCommands(pi);

	const ctx = {
		cwd,
		ui: {
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			setWorkingVisible(_visible: boolean) {},
			setStatus(_key: string, _value: string | undefined) {},
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
		},
		newSession() {
			newSessionCount++;
			return Promise.resolve({ cancelled: false });
		},
	} as unknown as ExtensionCommandContext;

	return {
		cwd,
		commands,
		notifications,
		sentMessages,
		ctx,
		getNewSessionCount: () => newSessionCount,
	};
}

function writeValidBundle(cwd: string): void {
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "plans", "prds"), { recursive: true });
	writeFileSync(join(cwd, ".ralph", "plan.md"), "plan\n");
	writeFileSync(join(cwd, ".ralph", "prompt.md"), "bundle prompt\n");
	writeFileSync(join(cwd, ".ralph", "progress.md"), "progress\n");
	writeFileSync(join(cwd, ".pi", "plans", "prds", "source.md"), "source\n");
	writeFileSync(
		join(cwd, ".ralph", "items.json"),
		JSON.stringify(
			{
				version: 1,
				runtime_contract: {
					source_docs: [".pi/plans/prds/source.md"],
					require_progress_append: true,
					require_clean_source_docs: true,
				},
				items: [
					{
						category: "test",
						description: "Do the thing",
						steps: ["Verify it"],
						passes: false,
						regression_notes: "",
					},
				],
			},
			null,
			2,
		),
	);
}

test("registerCommands exposes the Ralph command set", () => {
	const h = createCommandsHarness();
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

test("ralph-loop starts bundle mode for @.ralph/prompt.md", async () => {
	const h = createCommandsHarness();
	writeValidBundle(h.cwd);
	execFileSync("git", ["init"], { cwd: h.cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: h.cwd,
	});
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: h.cwd });
	execFileSync("git", ["add", "."], { cwd: h.cwd });
	execFileSync("git", ["commit", "-m", "initial"], {
		cwd: h.cwd,
		stdio: "ignore",
	});

	await h.commands
		.get("ralph-loop")
		?.handler("@.ralph/prompt.md --max-iterations=3", h.ctx);

	assert.equal(h.getNewSessionCount(), 1);
	assert.equal(
		h.notifications.at(-1)?.message,
		"Ralph loop started (max 3 iterations)",
	);
	const state = readState(h.cwd);
	assert.equal(state?.bundle_mode, true);
	assert.ok(state?.loop_token);
	assert.ok(state?.bundle_snapshot_hash);
	assert.ok(state?.items_snapshot_hash);
	assert.equal(state?.progress_size, 9);
	assert.ok(state?.progress_hash);
	assert.ok(state?.progress_snapshot);
	assert.match(state?.source_doc_hashes ?? "", /source\.md/);
});

test("ralph-loop starts bundle mode for @./.ralph/prompt.md", async () => {
	const h = createCommandsHarness();
	writeValidBundle(h.cwd);

	await h.commands.get("ralph-loop")?.handler('"@./.ralph/prompt.md"', h.ctx);

	assert.equal(h.getNewSessionCount(), 1);
	assert.equal(
		h.notifications.at(-1)?.message,
		"Ralph loop started (max 100 iterations)",
	);
});

test("ralph-loop rejects bundle mode when bundle validation fails", async () => {
	const h = createCommandsHarness();

	await h.commands.get("ralph-loop")?.handler("@.ralph/prompt.md", h.ctx);

	assert.equal(h.getNewSessionCount(), 0);
	assert.deepEqual(h.notifications.at(-1), {
		message: "Invalid Ralph bundle: .ralph/plan.md is missing",
		type: "error",
	});
});

test("ralph-loop preserves non-bundle prompt references", async () => {
	const h = createCommandsHarness();

	await h.commands.get("ralph-loop")?.handler("@notes.md", h.ctx);

	assert.equal(h.getNewSessionCount(), 1);
	assert.equal(
		h.notifications.at(-1)?.message,
		"Ralph loop started (max 100 iterations)",
	);
});

test("ralph-loop rejects start when active loop state exists", async () => {
	const h = createCommandsHarness();
	writeState(h.cwd, makeCommandsState(), "task");

	await h.commands.get("ralph-loop")?.handler("new task", h.ctx);

	assert.equal(h.getNewSessionCount(), 0);
	assert.deepEqual(h.notifications.at(-1), {
		message: "A Ralph loop is already running",
		type: "error",
	});
});

test("ralph-resume preserves saved bundle mode", async () => {
	const h = createCommandsHarness();
	writeValidBundle(h.cwd);
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "max_iterations",
			bundle_mode: true,
		}),
		"bundle prompt",
	);

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	assert.equal(readState(h.cwd)?.bundle_mode, true);
	assert.deepEqual(h.sentMessages, ["bundle prompt"]);
});

test("ralph-restart preserves saved bundle mode", async () => {
	const h = createCommandsHarness();
	writeValidBundle(h.cwd);
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "max_iterations",
			bundle_mode: true,
		}),
		"bundle prompt",
	);

	await h.commands.get("ralph-restart")?.handler("", h.ctx);

	assert.equal(readState(h.cwd)?.bundle_mode, true);
	assert.equal(h.getNewSessionCount(), 1);
});

test("ralph-stop updates persisted stop state", async () => {
	const h = createCommandsHarness();
	writeState(h.cwd, makeCommandsState(), "task");
	await h.commands.get("ralph-stop")?.handler("", h.ctx);
	assert.deepEqual(h.notifications.at(-1), {
		message: "Ralph loop will stop after the current iteration",
		type: "info",
	});
});
