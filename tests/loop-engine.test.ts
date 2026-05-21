import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { continueLoop, handleLoopAgentEnd, runLoop } from "../loop-engine.ts";
import { readState, writeState } from "../state.ts";
import type { RalphLoopState } from "../types.ts";

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
	notifications: Array<{ message: string; type: string }>;
	newSessionCalls: number;
	setSession: (id: string, file: string) => void;
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
	};
	return { ...baseState, ...overrides };
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
	const notifications: Array<{ message: string; type: string }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const sessionNames: string[] = [];
	let sessionId = "session-1";
	let sessionFile = "/sessions/session-1.jsonl";
	let newSessionCalls = 0;

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
		sendUserMessage(message: string) {
			sentMessages.push(message);
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
			isIdle: () => true,
			waitForIdle: async () => {},
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
	const eventCtx = ctx as unknown;

	function simulateAgentEnd(response: ScriptedResponse) {
		const messages = [
			{
				role: "assistant" as const,
				stopReason: response.stopReason ?? "stop",
				content: [{ type: "text" as const, text: response.text }],
			},
		];
		handleLoopAgentEnd(pi, messages, eventCtx as any);
	}

	return {
		cwd,
		pi,
		ctx,
		sentMessages,
		notifications,
		get newSessionCalls() {
			return newSessionCalls;
		},
		setSession(id: string, file: string) {
			sessionId = id;
			sessionFile = file;
		},
		readState: () => readState(cwd),
		writeState: (state: RalphLoopState, task = "task") =>
			writeState(cwd, state, task),
		simulateAgentEnd,
	};
}

test("runLoop initializes state and creates a fresh session", async () => {
	const h = createHarness();

	await runLoop(h.pi, h.ctx, "task", 3);

	const state = h.readState();
	assert.equal(h.newSessionCalls, 1);
	assert.equal(state?.running, true);
	assert.equal(state?.iteration, 1);
	assert.equal(state?.max_iterations, 3);
	// transitioning remains true until session_start fires
	assert.equal(state?.transitioning, true);
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

test("bundle NEXT runs configured verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], {
		verification_gates: [{ name: "pass", command: "node -e \"process.exit(0)\"" }],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], {
		verification_gates: [{ name: "pass", command: "node -e \"process.exit(0)\"" }],
	});
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 2);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);
});

test("bundle NEXT rejects failed verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [false], {
		verification_gates: [{ name: "fail", command: "node -e \"console.error('bad gate'); process.exit(2)\"" }],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	writeBundleItems(h.cwd, [true], {
		verification_gates: [{ name: "fail", command: "node -e \"console.error('bad gate'); process.exit(2)\"" }],
	});
	h.simulateAgentEnd({ text: "Iteration 1\n<promise>NEXT</promise>" });

	assert.equal(h.readState()?.iteration, 1);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /verification gate fail exited with code 2/);
	assert.match(h.sentMessages.at(-1) ?? "", /bad gate/);
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
	assert.match(h.sentMessages.at(-1) ?? "", /^Ralph rejected <promise>NEXT<\/promise>\./);
	assert.match(h.sentMessages.at(-1) ?? "", /Failed invariant: exactly one item/);
	assert.match(h.sentMessages.at(-1) ?? "", /Continue this same iteration/);
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
	assert.match(h.notifications.at(-1)?.message ?? "", /previous content as an exact prefix/);
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
	assert.match(h.notifications.at(-1)?.message ?? "", /docs\/source\.md changed/);
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
	assert.match(h.notifications.at(-1)?.message ?? "", /immutable fields changed/);
});

test("agent_end with NEXT advances iteration and requests new session", async () => {
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
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(h.newSessionCalls, 1);

	h.writeState(
		makeBaseState({ iteration: 2, max_iterations: 4, transitioning: false }),
	);
	h.simulateAgentEnd({ text: "Iteration 2\n<promise>NEXT</promise>" });
	await new Promise((r) => setTimeout(r, 600));

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
	assert.match(h.sentMessages.at(-1) ?? "", /^Ralph rejected <promise>COMPLETE<\/promise>\./);
	assert.match(h.sentMessages.at(-1) ?? "", /Failed invariant: COMPLETE requires every item/);
	assert.match(h.sentMessages.at(-1) ?? "", /Continue this same iteration/);
});

test("bundle COMPLETE rejects failed verification gates", async () => {
	const h = createHarness();
	writeBundleItems(h.cwd, [true], {
		verification_gates: [{ name: "complete", command: "node -e \"console.error('complete bad'); process.exit(3)\"" }],
	});
	h.writeState(makeBaseState({ transitioning: false, bundle_mode: true }));

	await continueLoop(h.pi, h.ctx);
	h.simulateAgentEnd({ text: "All done\n<promise>COMPLETE</promise>" });

	const state = h.readState();
	assert.equal(state?.running, true);
	assert.equal(state?.stop_reason, null);
	assert.equal(h.newSessionCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /verification gate complete exited with code 3/);
	assert.match(h.sentMessages.at(-1) ?? "", /complete bad/);
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
	assert.match(h.notifications.at(-1)?.message ?? "", /immutable fields changed/);
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