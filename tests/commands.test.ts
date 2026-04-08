import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { registerCommands } from "../commands.ts";
import { writeState } from "../state.ts";
import type { RalphLoopState } from "../types.ts";

type CommandDef = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

function makeCommandsState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
  const baseState: RalphLoopState = {
    running: true,
    iteration: 2,
    max_iterations: 5,
    started_at: "2026-04-08T00:00:00.000Z",
    completed_at: null,
    stop_reason: null,
    session_id: "session-1",
    last_session_file: "/tmp/session-1.jsonl",
    error_count: 0,
    transitioning: false,
    cancel_requested: false,
    stop_requested: false,
    next_message: "task",
  };
  return { ...baseState, ...overrides };
}

function createCommandsHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-commands-"));
  const commands = new Map<string, CommandDef>();
  const notifications: Array<{ message: string; type: string }> = [];
  const sentMessages: string[] = [];

  const pi = {
    registerCommand(name: string, command: CommandDef) {
      commands.set(name, command);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  registerCommands(pi);

  const ctx = {
    cwd,
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionId: () => "session-1",
    },
  } as unknown as ExtensionCommandContext;

  return { cwd, commands, notifications, sentMessages, ctx };
}

test("registerCommands exposes the Ralph command set", () => {
  const h = createCommandsHarness();
  for (const name of [
    "ralph-continue",
    "ralph-loop",
    "ralph-resume",
    "ralph-restart",
    "ralph-stop",
    "ralph-status",
  ]) {
    assert.ok(h.commands.has(name));
  }
});

test("ralph-continue notifies when no loop is active", async () => {
  const h = createCommandsHarness();
  await h.commands.get("ralph-continue")!.handler("", h.ctx);
  assert.deepEqual(h.notifications.at(-1), {
    message: "No Ralph loop is running",
    type: "info",
  });
});

test("ralph-stop updates persisted stop state", async () => {
  const h = createCommandsHarness();
  writeState(h.cwd, makeCommandsState(), "task");
  await h.commands.get("ralph-stop")!.handler("", h.ctx);
  assert.deepEqual(h.notifications.at(-1), {
    message: "Ralph loop will stop after the current iteration",
    type: "info",
  });
});
