import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	continueLoop,
	handleLoopAgentEnd,
	handleLoopTurnEnd,
	runLoop,
} from "../src/loop-engine.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type ScriptedResponse = {
	stopReason?: string;
	text: string;
};

type MockAssistantEntry = {
	type: "message";
	message: {
		role: "assistant";
		stopReason: string;
		content: Array<{ type: "text"; text: string }>;
	};
};

type Harness = {
	cwd: string;
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	sentMessages: string[];
	sentMessageOptions: Array<{ deliverAs?: string; triggerTurn?: boolean } | undefined>;
	idleWaits: number;
	customMessages: Array<{
		customType: string;
		content?: unknown;
		display?: boolean;
		options?: { deliverAs?: string; triggerTurn?: boolean };
	}>;
	notifications: Array<{ message: string; type: string }>;
	newSessionCalls: number;
	setSession: (id: string, file: string) => void;
	setIdle: (value: boolean) => void;
	setContextPercent: (value: number | null | undefined) => void;
	readState: () => RalphLoopState | null;
	writeState: (state: RalphLoopState, task?: string) => void;
	/** Simulate an agent_end event with the given response. */
	simulateAgentEnd: (response: ScriptedResponse) => void;
};

function makeBaseState(
	overrides: Partial<RalphLoopState> = {},
): RalphLoopState {
	const baseState: RalphLoopState = {
		running: true,
		iteration: 1,
		max_iterations: 3,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: "/sessions/session-1.jsonl",
		error_count: 0,
		transitioning: true,
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

function git(root: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initGitRepo(root: string): void {
	git(root, ["init"]);
	git(root, ["config", "user.email", "ralph@example.test"]);
	git(root, ["config", "user.name", "Ralph Test"]);
	writeFileSync(join(root, "baseline.txt"), "baseline\n");
	git(root, ["add", "baseline.txt"]);
	git(root, ["commit", "-m", "baseline"]);
}

function commitAll(root: string, message: string): void {
	git(root, ["add", "."]);
	git(root, ["commit", "-m", message]);
}

function writeBundleItems(
	cwd: string,
	passes: boolean[],
	runtime_contract: Record<string, unknown> | undefined = undefined,
): void {
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(join(cwd, ".ralph", "plan.md"), "plan\n");
	writeFileSync(join(cwd, ".ralph", "prompt.md"), "prompt\n");
	writeFileSync(join(cwd, ".ralph", "progress.md"), "progress\n");
	writeFileSync(
		join(cwd, ".ralph", "items.json"),
		JSON.stringify(
			{
				version: 1,
				...(runtime_contract ? { runtime_contract } : {}),
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

function createHarness(): Harness {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-"));
	const branch: MockAssistantEntry[] = [];
	const sentMessages: string[] = [];
	const sentMessageOptions: Harness["sentMessageOptions"] = [];
	const customMessages: Harness["customMessages"] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const sessionNames: string[] = [];
	let sessionId = "session-1";
	let sessionFile = "/sessions/session-1.jsonl";
	let newSessionCalls = 0;
	let idle = true;
	let idleWaits = 0;
	let contextPercent: number | null | undefined;

	const ui = {
		theme: { fg: (_token: string, text: string) => text },
		notify(message: string, type: string) {
			notifications.push({ message, type });
		},
		setStatus(key: string, value: string | undefined) {
			statusUpdates.push({ key, value });
		},
		setWorkingVisible(_visible: boolean) {},
	};

	const pi = {
		sendUserMessage(
			message: string,
			options?: { deliverAs?: string; triggerTurn?: boolean },
		) {
			sentMessages.push(message);
			sentMessageOptions.push(options);
		},
		sendMessage(
			message: {
				customType: string;
				content?: unknown;
				display?: boolean;
			},
			options?: { deliverAs?: string; triggerTurn?: boolean },
		) {
			customMessages.push({ ...message, options });
		},
		setSessionName(name: string) {
			sessionNames.push(name);
		},
	} as unknown as ExtensionAPI;

	let activeContextVersion = 1;
	function makeCtx(version: number): ExtensionCommandContext {
		return {
			cwd,
			ui,
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
			},
			isIdle: () => idle,
			getContextUsage: () =>
				contextPercent === undefined
					? undefined
					: {
							tokens: contextPercent === null ? null : contextPercent * 1_000,
							contextWindow: 100_000,
							percent: contextPercent,
						},
			waitForIdle: async () => {
				idleWaits++;
				idle = true;
			},
			newSession: async (options?: {
				withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
			}) => {
				if (version !== activeContextVersion) {
					throw new Error(`stale command context v${version}`);
				}
				newSessionCalls++;
				activeContextVersion++;
				await options?.withSession?.(makeCtx(activeContextVersion));
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext;
	}

	const ctx = makeCtx(activeContextVersion);

	// Mock ExtensionContext (same object minus command methods)
	const eventCtx = ctx as ExtensionContext;

	function simulateAgentEnd(response: ScriptedResponse) {
		const messages = [
			{
				role: "assistant" as const,
				stopReason: response.stopReason ?? "stop",
				content: [{ type: "text" as const, text: response.text }],
			},
		];
		handleLoopAgentEnd(pi, messages, eventCtx);
	}

	return {
		cwd,
		pi,
		ctx,
		sentMessages,
		sentMessageOptions,
		get idleWaits() {
			return idleWaits;
		},
		customMessages,
		notifications,
		get newSessionCalls() {
			return newSessionCalls;
		},
		setSession(id: string, file: string) {
			sessionId = id;
			sessionFile = file;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setContextPercent(value: number | null | undefined) {
			contextPercent = value;
		},
		readState: () => readState(cwd),
		writeState: (state: RalphLoopState, task = "task") =>
			writeState(cwd, state, task),
		simulateAgentEnd,
	};
}

test("runLoop schedules initial fresh session after returning", async () => {
	const h = createHarness();

	await runLoop(h.pi, h.ctx, "task", 3);

	const state = h.readState();
	assert.equal(h.newSessionCalls, 0);
	assert.equal(state?.running, true);
	assert.equal(state?.iteration, 1);
	assert.equal(state?.max_iterations, 3);
	// transitioning remains true until session_start fires
	assert.equal(state?.transitioning, true);

	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT accepts exactly one completed item", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false, false]);
	h.writeState(
		makeBaseState({
			iteration: 1,
			max_iterations: 3,
			transitioning: false,
			bundle_mode: true,
		}),
	);

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true, false]);
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.iteration, 2);
	assert.equal(state?.transitioning, true);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT survives agent restoring stale loop state", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true, true, false]);
	h.writeState(
		makeBaseState({
			iteration: 2,
			max_iterations: 4,
			transitioning: false,
			bundle_mode: true,
		}),
	);

	await continueLoop(h.pi, h.ctx);
	const activeState = h.readState();
	assert.ok(activeState);
	assert.ok(activeState.bundle_items_snapshot?.includes('"passes":true'));

	// Simulates the runtime file being restored from git during the iteration.
	// The stale snapshot predates item 2 passing, so using it would observe two
	// completed items when only item 3 changed in this iteration.
	h.writeState(
		{
			...activeState,
			session_id: "old-session",
			bundle_items_snapshot: JSON.stringify([
				{
					category: "test",
					description: "Item 1",
					steps: ["Verify it"],
					passes: true,
				},
				{
					category: "test",
					description: "Item 2",
					steps: ["Verify it"],
					passes: false,
				},
				{
					category: "test",
					description: "Item 3",
					steps: ["Verify it"],
					passes: false,
				},
			]),
		},
		"stale task",
	);
	assert.equal(h.readState()?.iteration, 2);

	writeBundleItems(h.cwd, [true, true, true]);
	h.simulateAgentEnd({ text: "Iteration 2 without promise" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.sentMessages.at(-1), "continue");

	h.simulateAgentEnd({ text: "Iteration 2\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 3);
	assert.equal(h.readState()?.transitioning, true);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT runs configured verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], {
		verification_gates: [
			{ name: "pass", command: 'node -e "process.exit(0)"' },
		],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], {
		verification_gates: [
			{ name: "pass", command: 'node -e "process.exit(0)"' },
		],
	});
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects failed verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], {
		verification_gates: [
			{
				name: "fail",
				command: "node -e \"console.error('bad gate'); process.exit(2)\"",
			},
		],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], {
		verification_gates: [
			{
				name: "fail",
				command: "node -e \"console.error('bad gate'); process.exit(2)\"",
			},
		],
	});
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/verification gate fail exited with code 2/,
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(h.sentMessages.at(-1) ?? "", /bad gate/);
	assert.equal(h.sentMessageOptions.at(-1), undefined);
});

test("bundle NEXT rejects zero completed items", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.iteration, 1);
	assert.equal(state?.transitioning, false);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /observed 0/);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(
		h.sentMessages.at(-1) ?? "",
		/^Ralph rejected <promise>NEXT<\/promise>\./,
	);
	assert.match(
		h.sentMessages.at(-1) ?? "",
		/Failed invariant: exactly one item/,
	);
	assert.match(h.sentMessages.at(-1) ?? "", /Continue this same iteration/);
	assert.equal(h.sentMessageOptions.at(-1), undefined);
});

test("bundle NEXT rejects multiple completed items", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false, false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true, true]);
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /observed 2/);
});

test("bundle NEXT rejects progress rewrite", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], { require_progress_append: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_progress_append: true });
	writeFileSync(join(h.cwd, ".ralph", "progress.md"), "changed progress\n");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/previous content as an exact prefix/,
	);
});

test("bundle NEXT rejects missing progress append", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], { require_progress_append: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_progress_append: true });
	writeFileSync(join(h.cwd, ".ralph", "progress.md"), "progress\n");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /progress\.md must grow/);
});

test("bundle NEXT accepts progress append", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], { require_progress_append: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_progress_append: true });
	writeFileSync(join(h.cwd, ".ralph", "progress.md"), "progress\n\nentry\n");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects missing commit when required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { require_one_commit_per_iteration: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_one_commit_per_iteration: true });
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /observed 0/);
});

test("bundle NEXT accepts exactly one commit when required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { require_one_commit_per_iteration: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_one_commit_per_iteration: true });
	commitAll(h.cwd, "complete item");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT accepts exactly one commit in configured git_root", async () => {
	const h = createHarness();
	const appRoot = join(h.cwd, "discord-clone");
	mkdirSync(appRoot, { recursive: true });
	initGitRepo(appRoot);
	writeBundleItems(h.cwd, [false], {
		commit_policy: "exactly_one",
		git_root: "discord-clone",
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(join(appRoot, "app.txt"), "done\n");
	commitAll(appRoot, "complete item in app repo");
	writeBundleItems(h.cwd, [true], {
		commit_policy: "exactly_one",
		git_root: "discord-clone",
	});
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT accepts first commit after git init when required", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], { require_one_commit_per_iteration: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	git(h.cwd, ["init"]);
	git(h.cwd, ["config", "user.email", "ralph@example.test"]);
	git(h.cwd, ["config", "user.name", "Ralph Test"]);
	writeBundleItems(h.cwd, [true], { require_one_commit_per_iteration: true });
	commitAll(h.cwd, "complete first item");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects multiple commits when exactly_one is required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { commit_policy: "exactly_one" });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(join(h.cwd, "first.txt"), "first\n");
	commitAll(h.cwd, "first commit");
	writeBundleItems(h.cwd, [true], { commit_policy: "exactly_one" });
	commitAll(h.cwd, "second commit");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /observed 2/);
});

test("bundle NEXT accepts multiple commits when at_least_one is required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { commit_policy: "at_least_one" });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(join(h.cwd, "first.txt"), "first\n");
	commitAll(h.cwd, "first commit");
	writeBundleItems(h.cwd, [true], { commit_policy: "at_least_one" });
	commitAll(h.cwd, "second commit");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects commits when none is required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { commit_policy: "none" });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { commit_policy: "none" });
	commitAll(h.cwd, "unexpected commit");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /no commits are allowed/);
});

test("bundle NEXT allows any commit count when optional", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { commit_policy: "optional" });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { commit_policy: "optional" });
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects source document mutation", async () => {
	const h = createHarness();
	mkdirSync(join(h.cwd, "docs"), { recursive: true });
	writeFileSync(join(h.cwd, "docs", "source.md"), "source\n");
	writeBundleItems(h.cwd, [false], {
		source_docs: ["docs/source.md"],
		require_clean_source_docs: true,
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], {
		source_docs: ["docs/source.md"],
		require_clean_source_docs: true,
	});
	writeFileSync(join(h.cwd, "docs", "source.md"), "changed\n");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/docs\/source\.md changed/,
	);
});

test("bundle NEXT rejects immutable item changes", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(
		join(h.cwd, ".ralph", "items.json"),
		JSON.stringify(
			{
				version: 1,
				items: [
					{
						category: "test",
						description: "Changed",
						steps: ["Verify it"],
						passes: true,
						regression_notes: "",
					},
				],
			},
			null,
			2,
		),
	);
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/immutable fields changed/,
	);
});

test("turn_end at 75 percent sends hidden Ralph limit reminder", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	h.setContextPercent(75);

	handleLoopTurnEnd(h.pi, h.ctx);

	assert.equal(h.customMessages.length, 1);
	assert.equal(h.customMessages[0].customType, "ralph_limit");
	assert.equal(h.customMessages[0].display, false);
	assert.equal(h.customMessages[0].options?.deliverAs, "steer");
	assert.equal(
		h.customMessages[0].content,
		"This Pi session is getting long and approaching its context limit. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	);
});

test("turn_end sends each Ralph limit reminder once", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	h.setContextPercent(75);

	handleLoopTurnEnd(h.pi, h.ctx);
	handleLoopTurnEnd(h.pi, h.ctx);
	h.setContextPercent(80);
	handleLoopTurnEnd(h.pi, h.ctx);
	handleLoopTurnEnd(h.pi, h.ctx);
	h.setContextPercent(85);
	handleLoopTurnEnd(h.pi, h.ctx);
	handleLoopTurnEnd(h.pi, h.ctx);

	assert.equal(h.customMessages.length, 3);
	assert.equal(
		h.customMessages[1].content,
		"This Pi session has little context room left. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	);
	assert.equal(
		h.customMessages[2].content,
		"This Pi session is almost out of context room. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	);
});

test("turn_end respects Ralph limit reminder opt-out", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	h.setContextPercent(85);
	const previousValue = process.env.RALPH_LIMIT_REMINDERS_DISABLED;
	process.env.RALPH_LIMIT_REMINDERS_DISABLED = "1";

	try {
		handleLoopTurnEnd(h.pi, h.ctx);
	} finally {
		if (previousValue === undefined) {
			delete process.env.RALPH_LIMIT_REMINDERS_DISABLED;
		} else {
			process.env.RALPH_LIMIT_REMINDERS_DISABLED = previousValue;
		}
	}

	assert.equal(h.customMessages.length, 0);
});

test("turn_end skips Ralph limit reminder after terminal promise", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	h.setContextPercent(85);

	handleLoopTurnEnd(h.pi, h.ctx, {
		message: {
			role: "assistant",
			content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
		},
		toolResults: [],
	});

	assert.equal(h.customMessages.length, 0);
});

test("agent_end with provider error waits without injecting continue", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ stopReason: "error", text: "partial" });

	assert.equal(h.readState()?.running, true);
	assert.equal(h.readState()?.stop_reason, null);
	assert.equal(h.readState()?.error_count, 1);
	assert.deepEqual(h.sentMessages, []);
});

test("agent_end without terminal stopReason waits without injecting continue", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ stopReason: "tool-use", text: "partial" });

	assert.equal(h.readState()?.running, true);
	assert.equal(h.readState()?.stop_reason, null);
	assert.equal(h.readState()?.error_count, 1);
	assert.deepEqual(h.sentMessages, []);
});

test("agent_end missing control promise queues continue nudge", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ text: "Done but forgot the tag" });

	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.sentMessages.at(-1), "continue");
	assert.equal(h.sentMessageOptions.at(-1), undefined);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/missing control promise; nudging continue/,
	);
});

test("agent_end with NEXT notifies, advances iteration, and requests new session", async () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 1, max_iterations: 3, transitioning: false }),
	);
	h.setSession("session-2", "/sessions/session-2.jsonl");

	// The loop must have a stored command context.
	await continueLoop(h.pi, h.ctx);

	// Simulate the agent finishing with NEXT.
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.iteration, 2);
	assert.equal(state?.transitioning, true);
	assert.deepEqual(h.notifications.at(-1), {
		message: "Starting iteration 2/3 in a fresh session...",
		type: "info",
	});

	// newSession is called via setTimeout, so wait a tick.
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("agent_end refreshes stored command context after each new session", async () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 1, max_iterations: 4, transitioning: false }),
	);

	await continueLoop(h.pi, h.ctx);

	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(h.newSessionCalls, 1);

	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 4, transitioning: false }),
	);
	h.simulateAgentEnd({ text: "Iteration 2\n<promise>NEXT</promise>" });
	await new Promise((r) => setTimeout(r, 1000));

	assert.equal(h.newSessionCalls, 2);
	assert.ok(
		!h.notifications.some((n) => n.message.includes("lost command context")),
	);
});

test("agent_end with COMPLETE finalizes the loop", () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 3, transitioning: false }),
	);

	h.simulateAgentEnd({ text: "Iteration 2\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
	assert.equal(state?.iteration, 2);
	assert.equal(state?.transitioning, false);
});

test("agent_end accepts promise tag at end of final line", () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 3, transitioning: false }),
	);

	h.simulateAgentEnd({
		text: "All items now pass. <promise>COMPLETE</promise>",
	});

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
});

test("agent_end accepts promise tag wrapped in markdown code", () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 3, transitioning: false }),
	);

	h.simulateAgentEnd({
		text: "All items now pass.\n\n`<promise>COMPLETE</promise>`",
	});

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
});

test("bundle COMPLETE accepts when every item passes", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true, false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true, true]);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
	assert.equal(state?.transitioning, false);
});

test("bundle COMPLETE does not require progress append", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true], { require_progress_append: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "Already done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
});

test("bundle rejection prompt waits for idle then triggers correction", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.setIdle(false);
	h.simulateAgentEnd({ text: "No item done\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.bundle_rejection_count, 1);
	assert.deepEqual(h.sentMessages, ["task"]);
	h.setIdle(true);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.match(
		h.sentMessages.at(-1) ?? "",
		/^Ralph rejected <promise>NEXT<\/promise>/,
	);
	assert.equal(h.sentMessageOptions.at(-1), undefined);
});

test("bundle rejections stop after repeated invariant failures", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false]);
	h.writeState(
		makeBaseState({
			transitioning: false,
			bundle_mode: true,
			bundle_rejection_count: 4,
		}),
	);

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "Still not done\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "error");
	assert.equal(state?.bundle_rejection_count, 5);
	assert.equal(h.sentMessages.length, 1);
});

test("bundle rejection count resets after accepted NEXT", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false, false]);
	h.writeState(
		makeBaseState({
			transitioning: false,
			bundle_mode: true,
			bundle_rejection_count: 2,
		}),
	);

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true, false]);
	h.simulateAgentEnd({ text: "Done\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.bundle_rejection_count, 0);
});

test("bundle COMPLETE rejects unfinished items", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true, false]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, true);
	assert.equal(state?.stop_reason, null);
	assert.equal(state?.transitioning, false);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /every item/);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(
		h.sentMessages.at(-1) ?? "",
		/^Ralph rejected <promise>COMPLETE<\/promise>\./,
	);
	assert.match(
		h.sentMessages.at(-1) ?? "",
		/Failed invariant: COMPLETE requires every item/,
	);
	assert.match(h.sentMessages.at(-1) ?? "", /Continue this same iteration/);
	assert.equal(h.sentMessageOptions.at(-1), undefined);
});

test("bundle COMPLETE rejects failed verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true], {
		verification_gates: [
			{
				name: "complete",
				command: "node -e \"console.error('complete bad'); process.exit(3)\"",
			},
		],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, true);
	assert.equal(state?.stop_reason, null);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/verification gate complete exited with code 3/,
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(h.sentMessages.at(-1) ?? "", /complete bad/);
	assert.equal(h.sentMessageOptions.at(-1), undefined);
});

test("bundle COMPLETE rejects immutable item changes", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true]);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(
		join(h.cwd, ".ralph", "items.json"),
		JSON.stringify(
			{
				version: 1,
				items: [
					{
						category: "changed",
						description: "Item 1",
						steps: ["Verify it"],
						passes: true,
						regression_notes: "",
					},
				],
			},
			null,
			2,
		),
	);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	assert.equal(h.readState()?.running, true);
	assert.equal(h.newSessionCalls, 0);
	assert.match(
		h.notifications.at(-1)?.message ?? "",
		/immutable fields changed/,
	);
});

test("agent_end stops at max_iterations when NEXT on last iteration", () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 2, transitioning: false }),
	);

	h.simulateAgentEnd({ text: "Iteration 2\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "max_iterations");
	assert.equal(state?.iteration, 2);
	assert.equal(h.newSessionCalls, 0);
});

test("continueLoop honors manual stop requests", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ stop_requested: true }));

	await continueLoop(h.pi, h.ctx);

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "manual_stop");
	assert.equal(h.sentMessages.length, 0);
});

test("continueLoop sends task and sets up iteration", async () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 5, transitioning: false }),
	);
	h.setSession("session-3", "/sessions/session-3.jsonl");

	await continueLoop(h.pi, h.ctx);

	// Should have sent the task text
	assert.deepEqual(h.sentMessages, ["task"]);
	// Should have set session info
	const state = h.readState();
	assert.equal(state?.session_id, "session-3");
	assert.equal(state?.transitioning, false);
});
