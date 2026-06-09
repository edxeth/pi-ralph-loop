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
import { createBundleSnapshot, loadRalphBundle } from "../src/bundle/index.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type CommandDef = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

async function waitForScheduledWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

function staleOwnerHeartbeat(): string {
	return new Date(Date.now() - 61_000).toISOString();
}

function freshOwnerHeartbeat(): string {
	return new Date().toISOString();
}

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
		owner_pid: null,
		owner_heartbeat_at: null,
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

type BranchEntry = {
	type: "message";
	message: {
		role: "assistant" | "user";
		content: Array<{ type: "text"; text: string }>;
	};
};

function createCommandsHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-commands-"));
	const commands = new Map<string, CommandDef>();
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: string[] = [];
	const branch: BranchEntry[] = [];
	let newSessionCount = 0;
	let idle = true;

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
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
			getBranch: () => branch,
		},
		async newSession(options?: {
			withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
		}) {
			newSessionCount++;
			await options?.withSession?.({
				...ctx,
				sendUserMessage(message: string) {
					sentMessages.push(message);
				},
			} as unknown as ExtensionCommandContext);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	return {
		cwd,
		commands,
		notifications,
		sentMessages,
		ctx,
		getNewSessionCount: () => newSessionCount,
		setIdle: (value: boolean) => {
			idle = value;
		},
		pushAssistant: (text: string) => {
			branch.push({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text }] },
			});
		},
		pushUser: (text: string) => {
			branch.push({
				type: "message",
				message: { role: "user", content: [{ type: "text", text }] },
			});
		},
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

	await waitForScheduledWork();
	assert.equal(h.getNewSessionCount(), 0);
	assert.equal(h.sentMessages.at(-1), "bundle prompt\n");
	assert.ok(
		h.notifications.some(
			(notification) =>
				notification.message === "Ralph loop started (max 3 iterations)",
		),
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

	await waitForScheduledWork();
	assert.equal(h.getNewSessionCount(), 0);
	assert.equal(h.sentMessages.at(-1), "bundle prompt\n");
	assert.ok(
		h.notifications.some(
			(notification) =>
				notification.message === "Ralph loop started (max 100 iterations)",
		),
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

	await waitForScheduledWork();
	assert.equal(h.getNewSessionCount(), 0);
	assert.equal(h.sentMessages.at(-1), "@notes.md");
	assert.ok(
		h.notifications.some(
			(notification) =>
				notification.message === "Ralph loop started (max 100 iterations)",
		),
	);
});

test("ralph-loop starts in a fresh session when current session has history", async () => {
	const h = createCommandsHarness();
	h.pushUser("prior chat");

	await h.commands.get("ralph-loop")?.handler("new task", h.ctx);

	assert.equal(h.getNewSessionCount(), 0);
	await waitForScheduledWork();
	assert.equal(h.getNewSessionCount(), 1);
	assert.equal(h.sentMessages.at(-1), "new task");
});

test("ralph-loop rejects start when active loop state exists", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({ owner_pid: process.pid, owner_heartbeat_at: freshOwnerHeartbeat() }),
		"task",
	);

	await h.commands.get("ralph-loop")?.handler("new task", h.ctx);

	assert.equal(h.getNewSessionCount(), 0);
	assert.deepEqual(h.notifications.at(-1), {
		message: "A Ralph loop is already running",
		type: "error",
	});
});

test("ralph-resume recovers a stale running owner before resuming", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: true,
			iteration: 2,
			max_iterations: 5,
			session_id: "stale-owner-session",
			owner_pid: 123_456_789,
			owner_heartbeat_at: staleOwnerHeartbeat(),
		}),
		"resume stale task",
	);

	await h.commands.get("ralph-resume")?.handler("", h.ctx);
	await waitForScheduledWork();

	assert.equal(h.notifications.at(0)?.message, "Recovered stale Ralph loop owner before continuing");
	assert.equal(h.getNewSessionCount(), 1);
	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.iteration, 2);
	assert.equal(state?.stop_reason, null);
});

test("ralph-resume refuses a fresh running owner", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: true,
			owner_pid: 123_456_789,
			owner_heartbeat_at: freshOwnerHeartbeat(),
		}),
		"active task",
	);

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	assert.deepEqual(h.notifications.at(-1), {
		message: "A Ralph loop is already running",
		type: "error",
	});
	assert.equal(h.getNewSessionCount(), 0);
	assert.equal(readState(h.cwd)?.running, true);
});

test("ralph-restart recovers a stale running owner before restarting", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: true,
			iteration: 3,
			max_iterations: 5,
			session_id: "stale-owner-session",
			owner_pid: 123_456_789,
			owner_heartbeat_at: staleOwnerHeartbeat(),
		}),
		"restart stale task",
	);

	await h.commands.get("ralph-restart")?.handler("", h.ctx);
	await waitForScheduledWork();

	assert.equal(h.notifications.at(0)?.message, "Recovered stale Ralph loop owner before continuing");
	assert.match(h.notifications.at(1)?.message ?? "", /Restarting Ralph loop from iteration 1\/5/);
	assert.equal(readState(h.cwd)?.iteration, 1);
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
	// Empty session (no prior turns) -> seed the prompt once.
	assert.deepEqual(h.sentMessages, ["bundle prompt"]);
});

test("ralph-resume in same session does not re-seed when work is in progress", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 2,
		}),
		"the ralph prompt",
	);
	h.pushUser("the ralph prompt");
	h.pushAssistant("Working on item 2, still mid-flight.");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	// No promise yet and the session already has turns: nudge, do not re-seed.
	assert.deepEqual(h.sentMessages, ["continue"]);
	assert.equal(h.getNewSessionCount(), 0);
	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.iteration, 2);
});

test("ralph-resume in same session advances iteration on a re-emitted NEXT", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 2,
			max_iterations: 5,
		}),
		"the ralph prompt",
	);
	h.pushAssistant("Item done.\n<promise>NEXT</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.iteration, 3);
	assert.equal(state?.transitioning, true);
	// The re-emitted NEXT must not be answered by re-seeding the prompt.
	assert.deepEqual(h.sentMessages, []);
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(h.getNewSessionCount(), 1);
});

test("ralph-resume in same session finalizes on a re-emitted COMPLETE", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 4,
		}),
		"the ralph prompt",
	);
	h.pushAssistant("All tasks done.\n<promise>COMPLETE</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
	assert.deepEqual(h.sentMessages, []);
	assert.equal(h.getNewSessionCount(), 0);
});

test("ralph-resume in same session stops on a re-emitted STOP", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 2,
		}),
		"the ralph prompt",
	);
	h.pushAssistant("Blocked.\n<promise>STOP</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "manual_stop");
	assert.deepEqual(h.sentMessages, []);
	assert.equal(h.getNewSessionCount(), 0);
});

test("ralph-resume in a different session restarts the saved iteration fresh", async () => {
	const h = createCommandsHarness();
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "some-old-session",
			iteration: 2,
		}),
		"the ralph prompt",
	);
	// Last assistant message belongs to the OLD session; current session differs,
	// so resume must open a fresh session rather than route the stale promise.
	h.pushAssistant("Item done.\n<promise>NEXT</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	assert.equal(h.getNewSessionCount(), 0);
	await waitForScheduledWork();
	const state = readState(h.cwd);
	assert.equal(state?.iteration, 2);
	assert.equal(state?.transitioning, false);
	assert.equal(h.getNewSessionCount(), 1);
	assert.deepEqual(h.sentMessages, ["the ralph prompt"]);
});

function writeMinimalBundle(cwd: string, passes: boolean[]): void {
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(join(cwd, ".ralph", "plan.md"), "plan\n");
	writeFileSync(join(cwd, ".ralph", "prompt.md"), "bundle prompt\n");
	writeFileSync(join(cwd, ".ralph", "progress.md"), "progress\n");
	writeFileSync(
		join(cwd, ".ralph", "items.json"),
		JSON.stringify(
			{
				version: 1,
				runtime_contract: {},
				items: passes.map((pass, index) => ({
					category: "test",
					description: `Item ${index + 1}`,
					steps: ["Verify it"],
					passes: pass,
					regression_notes: "",
				})),
			},
			null,
			2,
		),
	);
}

test("ralph-resume routes a re-emitted bundle NEXT against the persisted snapshot", async () => {
	const h = createCommandsHarness();
	writeMinimalBundle(h.cwd, [false, false]);
	// Snapshot taken while both items were unfinished is the pre-iteration
	// baseline persisted in loop.md. A real restart leaves the in-memory store
	// empty, so validation must fall back to these fields.
	const snapshot = createBundleSnapshot(loadRalphBundle(h.cwd));
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 2,
			max_iterations: 5,
			bundle_mode: true,
			...snapshot,
		}),
		"bundle prompt",
	);
	// Exactly one item moved false -> true this iteration: a valid NEXT.
	writeMinimalBundle(h.cwd, [true, false]);
	h.pushAssistant("Item 1 done.\n<promise>NEXT</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.iteration, 3);
	assert.equal(state?.transitioning, true);
	assert.deepEqual(h.sentMessages, []);
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(h.getNewSessionCount(), 1);
});

test("ralph-resume rejects a re-emitted bundle NEXT that violates the persisted snapshot", async () => {
	const h = createCommandsHarness();
	writeMinimalBundle(h.cwd, [false, false]);
	const snapshot = createBundleSnapshot(loadRalphBundle(h.cwd));
	writeState(
		h.cwd,
		makeCommandsState({
			running: false,
			stop_reason: "user_cancelled",
			session_id: "session-1",
			iteration: 2,
			max_iterations: 5,
			bundle_mode: true,
			...snapshot,
		}),
		"bundle prompt",
	);
	// Two items moved vs the persisted baseline: must be rejected, not advanced.
	writeMinimalBundle(h.cwd, [true, true]);
	h.pushAssistant("Items done.\n<promise>NEXT</promise>");

	await h.commands.get("ralph-resume")?.handler("", h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.iteration, 2);
	assert.equal(state?.bundle_rejection_count, 1);
	// A corrective prompt continues the same iteration; the seed prompt is never
	// re-sent and no fresh session is opened.
	assert.equal(h.getNewSessionCount(), 0);
	assert.ok(h.sentMessages.at(-1)?.includes("Ralph rejected <promise>NEXT</promise>"));
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
	assert.equal(h.getNewSessionCount(), 0);
	await waitForScheduledWork();
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
