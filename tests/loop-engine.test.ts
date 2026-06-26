import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { setLoopApi } from "../src/loop/api-context.ts";
import {
	continueLoop,
	handleLoopAgentEnd,
	handleLoopInput,
	handleLoopTurnEnd,
	PROVIDER_ERROR_MAX_WAIT_MS,
	runLoop,
	WAIT_PARK_TIMEOUT_MS,
} from "../src/loop-engine.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type ScriptedResponse = {
	stopReason?: string;
	text: string;
	/** When set, the assistant message ends with this toolCall (async suspension). */
	toolCall?: { name: string; arguments?: Record<string, unknown> };
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
	sentMessageOptions: Array<
		{ deliverAs?: string; triggerTurn?: boolean } | undefined
	>;
	idleWaits: number;
	customMessages: Array<{
		customType: string;
		content?: unknown;
		display?: boolean;
		options?: { deliverAs?: string; triggerTurn?: boolean };
	}>;
	notifications: Array<{ message: string; type: string }>;
	widgets: Array<{
		key: string;
		content: unknown;
		placement?: string;
	}>;
	newSessionCalls: number;
	setModelCalls: string[];
	setThinkingLevelCalls: string[];
	registerModel: (model: { provider: string; id: string }) => void;
	setCurrentModel: (model: { provider: string; id: string } | undefined) => void;
	setCurrentThinkingLevel: (level: string) => void;
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
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 0,
		transitioning: true,
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
		provider_recovery_fresh_fallback_used: false,
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
	const widgets: Array<{
		key: string;
		content: unknown;
		placement?: string;
	}> = [];
	const sessionNames: string[] = [];
	let sessionId = "session-1";
	let sessionFile = "/sessions/session-1.jsonl";
	let newSessionCalls = 0;
	let idle = true;
	let idleWaits = 0;
	let contextPercent: number | null | undefined;
	let currentModel: { provider: string; id: string } | undefined;
	let currentThinkingLevel = "medium";
	const models = new Map<string, { provider: string; id: string }>();
	const setModelCalls: string[] = [];
	const setThinkingLevelCalls: string[] = [];

	const ui = {
		theme: { fg: (_token: string, text: string) => text },
		notify(message: string, type: string) {
			notifications.push({ message, type });
		},
		setStatus(key: string, value: string | undefined) {
			statusUpdates.push({ key, value });
		},
		setWidget(
			key: string,
			content: unknown,
			options?: { placement?: string },
		) {
			widgets.push({ key, content, placement: options?.placement });
		},
		setWorkingVisible(_visible: boolean) {},
	};

	let activeApiVersion = 1;
	function makePi(version: number): ExtensionAPI {
		function assertActiveApi() {
			if (version !== activeApiVersion) {
				throw new Error(`stale pi api v${version}`);
			}
		}

		return {
			sendUserMessage(
				message: string,
				options?: { deliverAs?: string; triggerTurn?: boolean },
			) {
				assertActiveApi();
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
				assertActiveApi();
				customMessages.push({ ...message, options });
			},
			setSessionName(name: string) {
				assertActiveApi();
				sessionNames.push(name);
			},
			async setModel(model: { provider: string; id: string }) {
				assertActiveApi();
				setModelCalls.push(`${model.provider}/${model.id}`);
				currentModel = model;
				return true;
			},
			getThinkingLevel() {
				assertActiveApi();
				return currentThinkingLevel;
			},
			setThinkingLevel(level: string) {
				assertActiveApi();
				setThinkingLevelCalls.push(level);
				currentThinkingLevel = level;
			},
		} as unknown as ExtensionAPI;
	}

	const pi = makePi(activeApiVersion);
	let currentPi = pi;
	setLoopApi(currentPi);

	let activeContextVersion = 1;
	function makeCtx(version: number): ExtensionCommandContext {
		return {
			cwd,
			ui,
			get model() {
				return currentModel;
			},
			modelRegistry: {
				find: (provider: string, id: string) => models.get(`${provider}/${id}`),
			},
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
			sendUserMessage: (message: string) => {
				sentMessages.push(message);
				sentMessageOptions.push(undefined);
			},
			waitForIdle: async () => {
				idleWaits++;
				idle = true;
			},
			newSession: async (options?: {
				setup?: (sessionManager: {
					appendSessionInfo: (name: string) => void;
				}) => Promise<void>;
				withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
			}) => {
				if (version !== activeContextVersion) {
					throw new Error(`stale command context v${version}`);
				}
				newSessionCalls++;
				activeContextVersion++;
				activeApiVersion++;
				currentPi = makePi(activeApiVersion);
				setLoopApi(currentPi);
				await options?.setup?.({
					appendSessionInfo: (name: string) => sessionNames.push(name),
				});
				await options?.withSession?.(makeCtx(activeContextVersion));
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext;
	}

	const ctx = makeCtx(activeContextVersion);

	// Mock ExtensionContext (same object minus command methods)
	const eventCtx = ctx as ExtensionContext;

	function simulateAgentEnd(response: ScriptedResponse) {
		const content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> = [
			{ type: "text" as const, text: response.text },
		];
		if (response.toolCall) {
			content.push({
				type: "toolCall",
				id: `call_${Date.now()}`,
				name: response.toolCall.name,
				arguments: response.toolCall.arguments ?? {},
			});
		}
		const messages = [
			{
				role: "assistant" as const,
				stopReason: response.stopReason ?? (response.toolCall ? "toolUse" : "stop"),
				content,
			},
		];
		handleLoopAgentEnd(currentPi, messages, eventCtx);
	}

	return {
		cwd,
		get pi() {
			return currentPi;
		},
		ctx,
		sentMessages,
		sentMessageOptions,
		get idleWaits() {
			return idleWaits;
		},
		customMessages,
		notifications,
		widgets,
		get newSessionCalls() {
			return newSessionCalls;
		},
		setModelCalls,
		setThinkingLevelCalls,
		registerModel(model: { provider: string; id: string }) {
			models.set(`${model.provider}/${model.id}`, model);
		},
		setCurrentModel(model: { provider: string; id: string } | undefined) {
			currentModel = model;
			if (model) models.set(`${model.provider}/${model.id}`, model);
		},
		setCurrentThinkingLevel(level: string) {
			currentThinkingLevel = level;
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

test("runLoop uses the current session when it has no turns", async () => {
	const h = createHarness();

	await runLoop(h.pi, h.ctx, "task", 3);

	const state = h.readState();
	assert.equal(h.newSessionCalls, 0);
	assert.equal(state?.running, true);
	assert.equal(state?.iteration, 1);
	assert.equal(state?.max_iterations, 3);
	assert.equal(state?.transitioning, false);
	assert.equal(h.sentMessages.at(-1), "task");
	assert.equal(h.widgets.length, 1);
	assert.equal(h.widgets.at(-1)?.key, "ralph-loop-notice");
	assert.equal(h.widgets.at(-1)?.placement, "aboveEditor");
	assert.equal(typeof h.widgets.at(-1)?.content, "function");
});

test("runLoop snapshots the active model and thinking level", async () => {
	const h = createHarness();
	h.setCurrentModel({ provider: "anthropic", id: "claude-sonnet" });
	h.setCurrentThinkingLevel("high");

	await runLoop(h.pi, h.ctx, "task", 3);

	const state = h.readState();
	assert.equal(state?.model_provider, "anthropic");
	assert.equal(state?.model_id, "claude-sonnet");
	assert.equal(state?.thinking_level, "high");
});

test("accepted NEXT replays saved model and thinking before the fresh iteration prompt", async () => {
	const h = createHarness();
	h.registerModel({ provider: "anthropic", id: "claude-sonnet" });
	await runLoop(h.pi, h.ctx, "task", 3);
	h.sentMessages.length = 0;
	h.setCurrentThinkingLevel("high");
	h.writeState(
		makeBaseState({
			iteration: 1,
			max_iterations: 3,
			transitioning: false,
			model_provider: "anthropic",
			model_id: "claude-sonnet",
			thinking_level: "high",
		}),
	);

	h.simulateAgentEnd({ text: "done\n<promise>NEXT</promise>" });
	await new Promise((r) => setTimeout(r, 600));

	assert.deepEqual(h.setModelCalls, ["anthropic/claude-sonnet"]);
	assert.deepEqual(h.setThinkingLevelCalls, ["high"]);
	assert.equal(h.sentMessages.at(-1), "task");
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

test("provider recovery fresh fallback preserves the original bundle snapshot", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		writeBundleItems(h.cwd, [false]);
		h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));
		await continueLoop(h.pi, h.ctx);

		// The first session made valid item progress before provider failures
		// forced Ralph into a same-iteration fresh fallback.
		writeBundleItems(h.cwd, [true]);
		await exhaustProviderRecoveryToFreshFallback(h);

		h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

		assert.equal(h.readState()?.iteration, 2);
		assert.equal(h.readState()?.transitioning, true);
		assert.doesNotMatch(h.notifications.at(-1)?.message ?? "", /observed 0/);
	} finally {
		mock.timers.reset();
	}
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
	assert.match(h.sentMessages.at(-1) ?? "", /without a control tag/);

	h.simulateAgentEnd({ text: "Iteration 2\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 3);
	assert.equal(h.readState()?.transitioning, true);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT does not run configured verification gates (advisory only)", async () => {
	const h = createHarness();
	// A gate command that would FAIL if Ralph ran it. Ralph must not run it:
	// verification_gates are instructions for the agent, not harness-enforced.
	const failingGate = {
		verification_gates: [
			{ name: "would-fail", command: 'node -e "process.exit(2)"' },
		],
	};
	writeBundleItems(h.cwd, [false], failingGate);
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], failingGate);
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	// The loop advances even though the gate command would have failed.
	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
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
	writeBundleItems(h.cwd, [false], { require_commit: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_commit: true });
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /at least one commit/);
});

test("bundle NEXT accepts commit when required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { require_commit: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_commit: true });
	commitAll(h.cwd, "complete item");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT accepts first commit after git init when required", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], { require_commit: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	git(h.cwd, ["init"]);
	git(h.cwd, ["config", "user.email", "ralph@example.test"]);
	git(h.cwd, ["config", "user.name", "Ralph Test"]);
	writeBundleItems(h.cwd, [true], { require_commit: true });
	commitAll(h.cwd, "complete first item");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT accepts multiple commits when commit is required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { require_commit: true });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeFileSync(join(h.cwd, "first.txt"), "first\n");
	commitAll(h.cwd, "first commit");
	writeBundleItems(h.cwd, [true], { require_commit: true });
	commitAll(h.cwd, "second commit");
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT allows no commit when not required", async () => {
	const h = createHarness();
	initGitRepo(h.cwd);
	writeBundleItems(h.cwd, [false], { require_commit: false });
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], { require_commit: false });
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

test("provider error sends a recovery nudge after Pi retry wait and countdown", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		assert.equal(h.readState()?.running, true);
		assert.equal(h.readState()?.stop_reason, null);
		assert.deepEqual(h.sentMessages, []);

		mock.timers.tick(60_000);
		assert.equal(h.readState()?.running, true);
		assert.equal(h.readState()?.stop_reason, null);
		assert.equal(h.sentMessages.at(-1), "continue");
	} finally {
		mock.timers.reset();
	}
});

test("provider recovery nudge waits for idle before sending", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));
		h.setIdle(false);

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(60_000);
		assert.deepEqual(h.sentMessages, []);

		h.setIdle(true);
		mock.timers.tick(250);

		assert.equal(h.sentMessages.at(-1), "continue");
	} finally {
		mock.timers.reset();
	}
});

test("recovery turn cancels provider nudge already waiting for idle", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));
		h.setIdle(false);

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(60_000);
		assert.deepEqual(h.sentMessages, []);

		handleLoopTurnEnd(h.pi, h.ctx, {
			message: { role: "assistant", content: [{ type: "text", text: "working" }] },
		});
		h.setIdle(true);
		mock.timers.tick(250);

		assert.deepEqual(h.sentMessages, []);
	} finally {
		mock.timers.reset();
	}
});

test("human input cancels provider nudge already waiting for idle", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));
		h.setIdle(false);

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(60_000);
		assert.deepEqual(h.sentMessages, []);

		handleLoopInput({ source: "interactive" }, h.ctx);
		h.setIdle(true);
		mock.timers.tick(250);

		assert.deepEqual(h.sentMessages, []);
	} finally {
		mock.timers.reset();
	}
});

async function exhaustProviderRecoveryToFreshFallback(h: Harness): Promise<void> {
	for (let i = 1; i <= 5; i++) {
		h.simulateAgentEnd({ stopReason: "error", text: `provider failed ${i}` });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(60_000);
	}

	h.simulateAgentEnd({ stopReason: "error", text: "provider failed after final nudge" });
	mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
	mock.timers.tick(300_000);
	await Promise.resolve();
	mock.timers.tick(0);
	await Promise.resolve();
}

test("provider recovery countdown updates the above-editor notice", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		const baseline = h.widgets.length;

		mock.timers.tick(1_000);
		assert.ok(
			h.widgets.length > baseline,
			"countdown should update the above-editor widget while waiting",
		);
	} finally {
		mock.timers.reset();
	}
});

test("recovery turn cancels a pending provider recovery nudge", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		handleLoopTurnEnd(h.pi, h.ctx, {
			message: { role: "assistant", content: [{ type: "text", text: "working" }] },
		});
		mock.timers.tick(60_000);

		assert.deepEqual(h.sentMessages, []);
	} finally {
		mock.timers.reset();
	}
});

test("human input cancels a pending provider recovery nudge", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		handleLoopInput({ source: "interactive" }, h.ctx);
		mock.timers.tick(60_000);

		assert.deepEqual(h.sentMessages, []);
	} finally {
		mock.timers.reset();
	}
});

test("extension input does not cancel Ralph's own provider recovery nudge", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "partial" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		handleLoopInput({ source: "extension" }, h.ctx);
		mock.timers.tick(60_000);

		assert.equal(h.sentMessages.at(-1), "continue");
	} finally {
		mock.timers.reset();
	}
});

test("non-error assistant turn resets the provider recovery nudge chain", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ stopReason: "error", text: "first provider failure" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(60_000);
		assert.equal(h.sentMessages.at(-1), "continue");

		h.sentMessages.length = 0;
		h.simulateAgentEnd({ text: "recovered, but forgot the promise" });

		for (let i = 1; i <= 5; i++) {
			h.simulateAgentEnd({ stopReason: "error", text: `provider failed again ${i}` });
			mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
			mock.timers.tick(60_000);
		}

		assert.equal(h.newSessionCalls, 0);
		assert.equal(h.sentMessages.length, 6);
		assert.match(h.sentMessages[0], /without a control tag/);
		assert.equal(
			h.sentMessages.filter((message) => message.startsWith("continue")).length,
			5,
		);
	} finally {
		mock.timers.reset();
	}
});

test("provider recovery sends five actual nudges before one fresh fallback", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));
		await continueLoop(h.pi, h.ctx);
		h.sentMessages.length = 0;

		for (let i = 1; i <= 5; i++) {
			h.simulateAgentEnd({ stopReason: "error", text: `provider failed ${i}` });
			mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
			mock.timers.tick(60_000);
		}

		assert.equal(
			h.sentMessages.filter((message) => message.startsWith("continue")).length,
			5,
		);
		assert.match(h.sentMessages.at(-1) ?? "", /promise/i);
		assert.equal(h.newSessionCalls, 0);

		h.simulateAgentEnd({ stopReason: "error", text: "provider failed after final nudge" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
		mock.timers.tick(300_000);
		await Promise.resolve();
		mock.timers.tick(0);
		await Promise.resolve();

		assert.equal(h.newSessionCalls, 1);
		assert.equal(h.readState()?.provider_recovery_fresh_fallback_used, true);
		assert.equal(h.readState()?.transitioning, false);
		assert.equal(h.sentMessages.at(-1), "task");
	} finally {
		mock.timers.reset();
	}
});

test("provider recovery fresh fallback is capped at one per iteration", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));
		await continueLoop(h.pi, h.ctx);
		h.sentMessages.length = 0;
		await exhaustProviderRecoveryToFreshFallback(h);
		assert.equal(h.newSessionCalls, 1);
		h.sentMessages.length = 0;

		for (let i = 1; i <= 5; i++) {
			h.simulateAgentEnd({ stopReason: "error", text: `fresh fallback failed ${i}` });
			mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);
			mock.timers.tick(60_000);
		}
		h.simulateAgentEnd({ stopReason: "error", text: "fresh fallback failed after final nudge" });
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);

		assert.equal(h.newSessionCalls, 1);
		assert.equal(h.readState()?.running, false);
		assert.equal(h.readState()?.stop_reason, "error");
	} finally {
		mock.timers.reset();
	}
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

// The provider-error "waiting for Pi's retry handling" banner is a problem
// notice that previously lingered forever. As soon as the model resumes
// working, it must be dismissed. A recovery turn landing (turn_end) is proof
// the provider came back, so the widget must be cleared.
test("provider-error notice is cleared once a recovery turn lands", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ stopReason: "error", text: "partial" });
	// The provider-error warning is now rendered in the widget.
	assert.equal(
		typeof h.widgets.at(-1)?.content,
		"function",
		"provider error must show the waiting notice",
	);

	// Pi recovers and the agent keeps working: a new turn lands.
	handleLoopTurnEnd(h.pi, h.ctx, {
		message: { role: "assistant", content: [{ type: "text", text: "working" }] },
	});

	assert.equal(
		h.widgets.at(-1)?.content,
		undefined,
		"recovery turn must clear the stale waiting notice",
	);
});

// Recovery can also be signalled by an agent_end (single-turn recovery), not
// just a turn_end. The stale waiting notice must be cleared there too. (A
// recovered turn that still forgets its promise then renders a fresh nudge
// warning, so we assert the clear was emitted, not that it is the final
// widget.)
test("provider-error notice is cleared on a recovery agent_end", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ stopReason: "error", text: "partial" });
	assert.equal(typeof h.widgets.at(-1)?.content, "function");

	// Capture the widget log up to the recovery turn, then assert only over the
	// slice it produced. The notice type is module-global state that survives
	// across tests, so a leading clear (or none) from prior tests must not
	// skew the assertion either way.
	const baseline = h.widgets.length;

	// Retry succeeds; the recovered turn ends cleanly.
	h.simulateAgentEnd({ stopReason: "stop", text: "recovered, forgot the tag" });

	const recovery = h.widgets.slice(baseline);
	assert.ok(
		recovery.some((w) => w.content === undefined),
		"recovery agent_end must dismiss the stale waiting notice",
	);
});

// A turn that ends on a trailing toolCall is an async suspension (e.g. a
// background subagent in flight), not a dead provider. It must NOT arm the
// provider-error wait, bump error_count, or finalize as error. The parent
// turn will resume when the tool result lands; until then Ralph stays parked.
// Contrast with the test above: no toolCall + non-terminal stopReason still
// waits (genuine provider silence).
test("agent_end ending in a toolCall (async suspension) does not arm the provider wait", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({
		text: "Launching a background subagent.",
		toolCall: { name: "subagent", arguments: { agent: "dummy-slow" } },
	});

	const state = h.readState();
	assert.equal(state?.running, true, "loop must stay running while suspended");
	assert.equal(state?.stop_reason, null, "must not finalize");
	assert.equal(state?.error_count, 0, "must not count a suspension as an error");
	assert.equal(state?.iteration, 1, "must not advance while suspended");
	assert.deepEqual(h.sentMessages, [], "must not nudge or reseed while suspended");
});

// Regression guard for the interaction between the notice-dismissal fix and
// async suspension. A subagent launch (or an ask_user call) ends the
// assistant message in a toolCall. If that turn lands while a provider-error
// "waiting for Pi's retry handling" warning is on screen, the warning must be
// cleared (the model resumed — it is running the subagent/ask_user), AND the
// loop must stay correctly parked: no second error_count bump, no finalize,
// no nudge. The clearLoopNotice path must not interfere with suspension.
test("a toolCall turn after a provider error clears the warning but stays parked", () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	// Provider error arms the wait and shows the waiting warning.
	h.simulateAgentEnd({ stopReason: "error", text: "partial" });
	assert.equal(
		typeof h.widgets.at(-1)?.content,
		"function",
		"provider error must show the waiting notice",
	);
	assert.equal(h.readState()?.error_count, 1);

	// Capture before the recovering turn so the assertion is immune to the
	// module-global _noticeType leaking from earlier tests.
	const baseline = h.widgets.length;

	// Pi recovers and the model emits a turn that launches a subagent (same
	// shape as an ask_user tool call): ends in a toolCall.
	h.simulateAgentEnd({
		text: "Launching a background subagent.",
		toolCall: { name: "subagent", arguments: { agent: "dummy-slow" } },
	});

	// The stale waiting warning was dismissed.
	assert.ok(
		h.widgets.slice(baseline).some((w) => w.content === undefined),
		"the recovering toolCall turn must clear the stale warning",
	);

	// ...and the loop is still parked, exactly as a plain suspension would be.
	const state = h.readState();
	assert.equal(state?.running, true, "must stay running while suspended");
	assert.equal(state?.stop_reason, null, "must not finalize");
	assert.equal(state?.error_count, 1, "recovery must not bump error_count again");
	assert.equal(state?.iteration, 1, "must not advance while suspended");
	assert.deepEqual(h.sentMessages, [], "must not nudge or reseed while suspended");
});

test("agent_end with WAIT parks the iteration without nudging", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ text: "Waiting for reviewer.\n<promise>WAIT</promise>" });

	await new Promise((resolve) => setTimeout(resolve, 50));
	const state = h.readState();
	assert.equal(state?.running, true, "loop must stay running while parked");
	assert.equal(state?.stop_reason, null, "WAIT must not finalize");
	assert.equal(state?.iteration, 1, "WAIT must not advance the iteration");
	assert.deepEqual(h.sentMessages, [], "WAIT must not send a recovery nudge immediately");
	assert.equal(h.widgets.at(-1)?.key, "ralph-loop-notice");
	assert.equal(h.widgets.at(-1)?.placement, "aboveEditor");
});

test("WAIT followed by NEXT advances the iteration", async () => {
	const h = createHarness();
	h.writeState(
		makeBaseState({ iteration: 1, max_iterations: 3, transitioning: false }),
	);
	await continueLoop(h.pi, h.ctx);
	h.sentMessages.length = 0;

	h.simulateAgentEnd({ text: "Waiting for reviewer.\n<promise>WAIT</promise>" });
	h.simulateAgentEnd({ text: "Reviewer arrived.\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.iteration, 2);
	assert.equal(state?.transitioning, true);
	assert.deepEqual(h.sentMessages, [], "WAIT must not leave a stale nudge behind");
});

test("WAIT timeout sends a bounded recovery prompt", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(makeBaseState({ transitioning: false }));

		h.simulateAgentEnd({ text: "Waiting for reviewer.\n<promise>WAIT</promise>" });
		mock.timers.tick(WAIT_PARK_TIMEOUT_MS);

		const recoveryPrompt = h.sentMessages.at(-1) ?? "";
		assert.match(recoveryPrompt, /WAIT timed out/);
		assert.match(recoveryPrompt, /<promise>WAIT<\/promise>/);
		assert.match(recoveryPrompt, /<promise>NEXT<\/promise>/);
		assert.match(recoveryPrompt, /<promise>COMPLETE<\/promise>/);
		assert.doesNotMatch(recoveryPrompt, /<promise>STOP<\/promise>/);
		assert.notEqual(recoveryPrompt, "continue");
		assert.equal(h.readState()?.running, true);
	} finally {
		mock.timers.reset();
	}
});

test("WAIT timeout prompt is cancelled if NEXT lands before idle returns", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(
			makeBaseState({ iteration: 1, max_iterations: 3, transitioning: false }),
		);
		await continueLoop(h.pi, h.ctx);
		h.sentMessages.length = 0;
		h.setIdle(false);

		h.simulateAgentEnd({ text: "Waiting for reviewer.\n<promise>WAIT</promise>" });
		mock.timers.tick(WAIT_PARK_TIMEOUT_MS);
		assert.deepEqual(h.sentMessages, []);

		h.simulateAgentEnd({ text: "Reviewer arrived.\n<promise>NEXT</promise>" });
		h.setIdle(true);
		mock.timers.tick(250);

		assert.equal(
			h.sentMessages.join("\n").includes("WAIT timed out"),
			false,
			"stale WAIT timeout prompt must not send after NEXT resolves the wait",
		);
		assert.equal(h.readState()?.iteration, 2);
		assert.equal(h.readState()?.transitioning, true);
	} finally {
		mock.timers.reset();
	}
});

test("WAIT countdown is cancelled when async result lands before timeout", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const h = createHarness();
		h.writeState(
			makeBaseState({ iteration: 1, max_iterations: 3, transitioning: false }),
		);
		await continueLoop(h.pi, h.ctx);
		h.sentMessages.length = 0;

		h.simulateAgentEnd({ text: "Waiting for reviewer.\n<promise>WAIT</promise>" });
		mock.timers.tick(Math.floor(WAIT_PARK_TIMEOUT_MS / 2));

		handleLoopTurnEnd(h.pi, h.ctx, {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Reviewer arrived.\n<promise>NEXT</promise>" }],
			},
		});
		h.simulateAgentEnd({ text: "Reviewer arrived.\n<promise>NEXT</promise>" });
		mock.timers.tick(WAIT_PARK_TIMEOUT_MS);

		assert.equal(
			h.sentMessages.join("\n").includes("WAIT timed out"),
			false,
			"WAIT timeout prompt must not send after async result resolves the wait",
		);
		assert.equal(h.readState()?.iteration, 2);
		assert.equal(h.readState()?.transitioning, true);
	} finally {
		mock.timers.reset();
	}
});

test("agent_end missing control promise queues a structured control-tag nudge", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));

	h.simulateAgentEnd({ text: "Done but forgot the tag" });

	await new Promise((resolve) => setTimeout(resolve, 50));
	const prompt = h.sentMessages.at(-1) ?? "";
	assert.match(prompt, /without a control tag/);
	assert.match(prompt, /<promise>WAIT<\/promise>/);
	assert.match(prompt, /<promise>NEXT<\/promise>/);
	assert.match(prompt, /<promise>COMPLETE<\/promise>/);
	assert.doesNotMatch(prompt, /<promise>STOP<\/promise>/);
	assert.notEqual(prompt, "continue");
	assert.equal(h.sentMessageOptions.at(-1), undefined);
	assert.equal(h.widgets.at(-1)?.key, "ralph-loop-notice");
	assert.equal(h.widgets.at(-1)?.placement, "aboveEditor");
	assert.equal(typeof h.widgets.at(-1)?.content, "function");
});

test("missing-promise chain sends five actual nudges before failing", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	await continueLoop(h.pi, h.ctx);
	h.sentMessages.length = 0;

	for (let i = 1; i <= 5; i++) {
		h.simulateAgentEnd({ text: `Missing promise ${i}` });
	}
	assert.equal(h.readState()?.running, true);
	assert.equal(h.sentMessages.length, 5);
	assert.ok(
		h.sentMessages.every((message) => !message.startsWith("continue")),
		"missing-promise nudges must be structured prompts, not bare continue",
	);

	h.simulateAgentEnd({ text: "Missing promise 6" });

	assert.equal(h.readState()?.running, false);
	assert.equal(h.readState()?.stop_reason, "error");
});

test("provider error resets the missing-promise nudge chain", async () => {
	const h = createHarness();
	h.writeState(makeBaseState({ transitioning: false }));
	await continueLoop(h.pi, h.ctx);
	h.sentMessages.length = 0;

	for (let i = 0; i < 4; i++) {
		h.simulateAgentEnd({ text: `Missing promise ${i + 1}` });
	}
	assert.equal(h.readState()?.running, true);
	assert.equal(h.sentMessages.length, 4);
	assert.ok(h.sentMessages.every((message) => !message.startsWith("continue")));

	h.simulateAgentEnd({ stopReason: "error", text: "provider failed" });
	assert.equal(h.readState()?.running, true);
	assert.equal(h.readState()?.error_count, 1);

	h.simulateAgentEnd({ text: "Recovered but still forgot the tag" });

	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.readState()?.running, true);
	assert.equal(h.readState()?.stop_reason, null);
	assert.match(h.sentMessages.at(-1) ?? "", /without a control tag/);
});

test("agent_end with NEXT shows notice, advances iteration, and requests new session", async () => {
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
	assert.equal(h.widgets.at(-1)?.key, "ralph-loop-notice");
	assert.equal(h.widgets.at(-1)?.placement, "aboveEditor");
	assert.equal(typeof h.widgets.at(-1)?.content, "function");

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

test("bundle rejections send five actual corrections before failing", async () => {
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

	assert.equal(h.readState()?.running, true);
	assert.equal(h.readState()?.bundle_rejection_count, 5);
	assert.match(h.sentMessages.at(-1) ?? "", /^Ralph rejected <promise>NEXT<\/promise>/);

	h.simulateAgentEnd({ text: "Still not done again\n<promise>NEXT</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "error");
	assert.equal(state?.bundle_rejection_count, 6);
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

test("bundle COMPLETE does not run configured verification gates (advisory only)", async () => {
	const h = createHarness();
	// A gate command that would FAIL if Ralph ran it. COMPLETE must still finalize:
	// the harness does not re-run verification_gates at promise emission.
	writeBundleItems(h.cwd, [true], {
		verification_gates: [
			{ name: "would-fail", command: 'node -e "process.exit(3)"' },
		],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "complete");
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
