import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTaskBody, readState, updateState, writeState } from "../state.ts";
import type { RalphLoopState } from "../types.ts";

function makeState(): RalphLoopState {
  return {
    running: true,
    iteration: 2,
    max_iterations: 5,
    started_at: "2026-04-08T00:00:00.000Z",
    completed_at: null,
    stop_reason: null,
    session_id: "session-1",
    last_session_file: "/tmp/session-1.jsonl",
    error_count: 1,
    transitioning: false,
    cancel_requested: false,
    stop_requested: false,
    next_message: "continue",
  };
}

test("state round-trips and preserves task body", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-state-"));
  const state = makeState();
  const task = "implement feature x";

  writeState(cwd, state, task);

  assert.deepEqual(readState(cwd), state);
  assert.equal(getTaskBody(cwd), task);

  updateState(cwd, {
    iteration: 3,
    stop_requested: true,
    next_message: "implement feature x",
  });

  assert.deepEqual(readState(cwd), {
    ...state,
    iteration: 3,
    stop_requested: true,
    next_message: "implement feature x",
  });
  assert.equal(getTaskBody(cwd), task);
});
