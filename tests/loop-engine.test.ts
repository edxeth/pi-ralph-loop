import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { continueLoop, runLoop } from "../loop-engine.ts";
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
};

function makeBaseState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
  const baseState: RalphLoopState = {
    running: true,
    iteration: 1,
    max_iterations: 3,
    started_at: "2026-04-08T00:00:00.000Z",
    completed_at: null,
    stop_reason: null,
    session_id: "session-1",
    last_session_file: "/tmp/session-1.jsonl",
    error_count: 0,
    transitioning: true,
    cancel_requested: false,
    stop_requested: false,
    next_message: "task",
  };
  return { ...baseState, ...overrides };
}

function createHarness(responses: ScriptedResponse[]): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-"));
  const branch: MockAssistantEntry[] = [];
  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
  const sessionNames: string[] = [];
  let sessionId = "session-1";
  let sessionFile = "/tmp/session-1.jsonl";
  let newSessionCalls = 0;

  const pi = {
    sendUserMessage(message: string) {
      sentMessages.push(message);
      const response = responses.shift();
      if (!response) throw new Error(`No scripted response left for message: ${message}`);
      branch.splice(0, branch.length, {
        type: "message",
        message: {
          role: "assistant",
          stopReason: response.stopReason ?? "stop",
          content: [{ type: "text", text: response.text }],
        },
      });
    },
    setSessionName(name: string) {
      sessionNames.push(name);
    },
  } as unknown as ExtensionAPI;

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
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    isIdle: () => false,
    waitForIdle: async () => {},
    newSession: async () => {
      newSessionCalls++;
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

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
    writeState: (state: RalphLoopState, task = "task") => writeState(cwd, state, task),
  };
}

test("runLoop initializes state and starts a fresh-session transition", async () => {
  const h = createHarness([]);

  await runLoop(h.pi, h.ctx, "task", 3);

  const state = h.readState();
  assert.equal(h.newSessionCalls, 1);
  assert.equal(state?.running, true);
  assert.equal(state?.iteration, 1);
  assert.equal(state?.max_iterations, 3);
  assert.equal(state?.transitioning, true);
  assert.equal(state?.session_id, "");
  assert.equal(state?.last_session_file, null);
  assert.equal(state?.next_message, "task");
});

test("continueLoop advances iteration when assistant emits NEXT", async () => {
  const h = createHarness([{ text: "Iteration 1\n<promise>NEXT</promise>" }]);
  h.writeState(makeBaseState({ iteration: 1, max_iterations: 3, next_message: "task" }));
  h.setSession("session-2", "/tmp/session-2.jsonl");

  await continueLoop(h.pi, h.ctx);

  assert.equal(h.newSessionCalls, 1);
  assert.deepEqual(
    h.readState(),
    makeBaseState({
      iteration: 2,
      max_iterations: 3,
      session_id: "session-2",
      last_session_file: "/tmp/session-2.jsonl",
      transitioning: true,
      next_message: "task",
    }),
  );
  assert.deepEqual(h.sentMessages, ["task"]);
});

test("continueLoop completes when assistant emits COMPLETE", async () => {
  const h = createHarness([{ text: "Iteration 2\n<promise>COMPLETE</promise>" }]);
  h.writeState(makeBaseState({ iteration: 2, max_iterations: 3, next_message: "task" }));
  h.setSession("session-3", "/tmp/session-3.jsonl");

  await continueLoop(h.pi, h.ctx);

  const state = h.readState();
  assert.equal(state?.running, false);
  assert.equal(state?.stop_reason, "complete");
  assert.equal(state?.iteration, 2);
  assert.equal(state?.transitioning, false);
});

test("continueLoop stops at max_iterations when assistant emits NEXT on last iteration", async () => {
  const h = createHarness([{ text: "Iteration 2\n<promise>NEXT</promise>" }]);
  h.writeState(makeBaseState({ iteration: 2, max_iterations: 2, next_message: "task" }));

  await continueLoop(h.pi, h.ctx);

  const state = h.readState();
  assert.equal(state?.running, false);
  assert.equal(state?.stop_reason, "max_iterations");
  assert.equal(state?.iteration, 2);
  assert.equal(h.newSessionCalls, 0);
});

test("continueLoop honors manual stop requests", async () => {
  const h = createHarness([]);
  h.writeState(makeBaseState({ stop_requested: true }));

  await continueLoop(h.pi, h.ctx);

  const state = h.readState();
  assert.equal(state?.running, false);
  assert.equal(state?.stop_reason, "manual_stop");
  assert.equal(h.sentMessages.length, 0);
});
