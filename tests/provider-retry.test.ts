import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	handleLoopAgentEnd,
	handleLoopTurnEnd,
	PROVIDER_ERROR_MAX_WAIT_MS,
} from "../src/loop-engine.ts";
import { readState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

function makeState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	return {
		running: true,
		iteration: 12,
		max_iterations: 20,
		started_at: "2026-05-31T00:00:00.000Z",
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
		limit_reminders: null,
		...overrides,
	};
}

function createHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-retry-"));
	const notifications: Array<{ message: string; type: string }> = [];

	// During Pi's auto-retry backoff the agent is NOT streaming, so the
	// extension sees isIdle() === true the entire time a retry is pending.
	const ctx = {
		cwd,
		ui: {
			theme: { fg: (_t: string, text: string) => text },
			notify: (message: string, type: string) =>
				notifications.push({ message, type }),
			setStatus: () => {},
			setWorkingVisible: () => {},
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
		},
		isIdle: () => true,
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;

	const pi = {
		sendUserMessage: () => {},
		sendMessage: () => {},
		setSessionName: () => {},
	} as unknown as ExtensionAPI;

	return {
		cwd,
		ctx,
		pi,
		notifications,
		writeState: (s: RalphLoopState) => writeState(cwd, s, "task"),
		readState: () => readState(cwd),
		agentEnd: (stopReason: string, text: string) =>
			handleLoopAgentEnd(
				pi,
				[{ role: "assistant", stopReason, content: [{ type: "text", text }] }],
				ctx,
			),
		turnEnd: (text = "working") =>
			handleLoopTurnEnd(pi, ctx, {
				message: { role: "assistant", content: [{ type: "text", text }] },
			}),
	};
}

test("provider error keeps the loop alive while a retry could still land", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		h.agentEnd("error", "partial work before the WebSocket error");

		// Pi's first retry backoff is 2s (then 4s, 8s). Advancing well past any
		// single backoff window must NOT finalize the loop: Ralph has to wait for
		// the retry to either succeed or fail with a fresh agent_end.
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS - 1);

		assert.equal(h.readState()?.running, true);
		assert.equal(h.readState()?.stop_reason, null);
		assert.equal(h.readState()?.error_count, 1);
	} finally {
		mock.timers.reset();
	}
});

test("provider error finalizes as error once the retry window fully elapses", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		h.agentEnd("error", "partial work before the WebSocket error");

		// No further agent_end arrives: Pi's retries are exhausted and the agent
		// stays silent. After the full window, Ralph gives up.
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);

		assert.equal(h.readState()?.running, false);
		assert.equal(h.readState()?.stop_reason, "error");
		assert.match(
			h.notifications.at(-1)?.message ?? "",
			/provider error persisted/,
		);
	} finally {
		mock.timers.reset();
	}
});

test("a recovered turn that does not advance the loop still cancels the wait", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		// Provider error arms the wait.
		h.agentEnd("error", "partial work before the WebSocket error");

		// Pi's retry succeeds, but the recovered turn forgets its promise tag.
		// That path neither advances the iteration nor bumps error_count — yet it
		// is a real turn, so the prior provider-error wait must be superseded.
		h.agentEnd("stop", "recovered, but forgot the control tag");

		// The stale wait must never finalize the loop, even after its full window.
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS);

		assert.equal(h.readState()?.running, true);
		assert.equal(h.readState()?.stop_reason, null);
	} finally {
		mock.timers.reset();
	}
});

test("a long multi-turn recovery is not killed mid-work by the wait timer", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		// Provider error mid-iteration arms the 180s wait.
		h.agentEnd("error", "partial work before the WebSocket error");

		// Pi recovers immediately and the agent keeps working: each tool round is a
		// turn_end, NOT an agent_end (no agent_end arrives until the whole unit is
		// done). This recovery runs longer than the wait window. Each turn must
		// supersede the armed wait so it never fires while the agent is productive.
		for (let elapsed = 0; elapsed < PROVIDER_ERROR_MAX_WAIT_MS * 2; elapsed += 20_000) {
			h.turnEnd("still working on the iteration");
			mock.timers.tick(20_000);
			assert.equal(
				h.readState()?.running,
				true,
				`loop killed mid-recovery at ~${elapsed}ms after the error`,
			);
			assert.equal(h.readState()?.stop_reason, null);
		}
	} finally {
		mock.timers.reset();
	}
});

test("a NEXT that lands after the backoff is honored and advances the loop", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		// Provider error at iteration 12 arms the wait.
		h.agentEnd("error", "partial work before the WebSocket error");

		// Time passes during Pi's backoff, but less than the give-up window.
		mock.timers.tick(8_000);

		// Pi's retry succeeds and the model emits a valid promise. This must be
		// honored rather than dropped because the loop was finalized early.
		h.agentEnd("stop", "Recovered after retry\n<promise>NEXT</promise>");

		assert.equal(h.readState()?.iteration, 13);
		assert.equal(h.readState()?.transitioning, true);
	} finally {
		mock.timers.reset();
	}
});

test("a second provider error re-arms the window and supersedes the first wait", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const h = createHarness();
		h.writeState(makeState());

		// First failed attempt arms a wait.
		h.agentEnd("error", "first failed attempt");
		mock.timers.tick(5_000);

		// A second failed attempt (next retry also errors) re-arms a fresh window.
		h.agentEnd("error", "second failed attempt");
		assert.equal(h.readState()?.error_count, 2);

		// Reaching the FIRST wait's original deadline must not finalize: that wait
		// was superseded, and the second window has not elapsed yet.
		mock.timers.tick(PROVIDER_ERROR_MAX_WAIT_MS - 5_000);
		assert.equal(h.readState()?.running, true);
		assert.equal(h.readState()?.stop_reason, null);

		// Completing the SECOND window finalizes exactly once, as an error.
		mock.timers.tick(5_000);
		assert.equal(h.readState()?.running, false);
		assert.equal(h.readState()?.stop_reason, "error");
		assert.equal(h.readState()?.error_count, 2);
	} finally {
		mock.timers.reset();
	}
});
