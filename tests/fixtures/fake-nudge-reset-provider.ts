/**
 * Test-only fake provider for the live missing-promise nudge reset regression.
 *
 * Scripted sequence in one Ralph iteration:
 * 1-4. Return terminal assistant replies with no promise, making Ralph send nudges.
 * 5. Return a retryable provider error, simulating a broken phone line mid-chain.
 * 6. Pi's retry succeeds with another no-promise reply.
 * 7. The next Ralph nudge receives <promise>STOP</promise> so the test ends.
 *
 * Pre-fix, attempt 6 consumed the already-near-exhausted promise nudge budget
 * and finalized the loop as stop_reason "error" before attempt 7 could run.
 * Post-fix, the provider error resets the nudge chain; attempt 6 gets a fresh
 * nudge and attempt 7 stops cleanly.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ATTEMPT_KEY = "__ralph_fake_nudge_reset_attempts__";

function nextAttempt(): number {
	const store = globalThis as Record<string, unknown>;
	const current = ((store[ATTEMPT_KEY] as number) ?? 0) + 1;
	store[ATTEMPT_KEY] = current;
	return current;
}

function replyForAttempt(attempt: number): string {
	if (attempt === 7) return "Stopping cleanly.\n<promise>STOP</promise>";
	return `Attempt ${attempt} completed without a promise tag.`;
}

function streamFakeNudgeReset(
	model: Model<Api>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const attempt = nextAttempt();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		stream.push({ type: "start", partial: output });

		if (attempt === 5) {
			output.stopReason = "error";
			output.errorMessage = "Connection error: WebSocket error";
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		const reply = replyForAttempt(attempt);
		output.content.push({ type: "text", text: "" });
		const block = output.content[0];
		if (block.type === "text") {
			block.text = reply;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: reply,
				partial: output,
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: reply,
				partial: output,
			});
		}

		if (options?.signal?.aborted) {
			output.stopReason = "aborted";
			output.errorMessage = "aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("ralph-fake", {
		baseUrl: "http://localhost/unused",
		apiKey: "RALPH_FAKE_API_KEY",
		api: "ralph-fake-api",
		models: [
			{
				id: "nudge-reset",
				name: "Ralph Fake Nudge Reset Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeNudgeReset,
	});
}
