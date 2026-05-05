import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

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
	};
	return { ...baseState, ...overrides };
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
