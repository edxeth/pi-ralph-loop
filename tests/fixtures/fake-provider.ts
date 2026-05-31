/**
 * Test-only fake provider for the provider-error retry live test.
 *
 * It registers a provider whose stream FAILS ONCE with a retryable
 * "WebSocket error" (Pi's auto-retry pattern, matching the original bug
 * report), then SUCCEEDS on the retry by emitting a scripted assistant reply.
 *
 * This drives Pi's real auto-retry machinery (exponential backoff, idle
 * between attempts) through the Ralph loop, with no network or API key. It is
 * loaded only by tests/live-rpc.test.ts.
 *
 * The attempt counter lives on globalThis because pi reloads extension modules
 * across the fresh sessions Ralph creates per iteration; a module-level counter
 * would reset and fail on every iteration instead of only the first.
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

const ATTEMPT_KEY = "__ralph_fake_provider_attempts__";
// One scripted reply per Ralph iteration. The first emission of each iteration
// fails with a retryable error; the retry succeeds with this text.
const REPLY = "Iteration done.\n<promise>COMPLETE</promise>";

function nextAttempt(): number {
	const store = globalThis as Record<string, unknown>;
	const current = ((store[ATTEMPT_KEY] as number) ?? 0) + 1;
	store[ATTEMPT_KEY] = current;
	return current;
}

function streamFakeProvider(
	model: Model<Api>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
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

		// First attempt fails with a retryable transport error; the retry passes.
		if (nextAttempt() === 1) {
			output.stopReason = "error";
			output.errorMessage = "Connection error: WebSocket error";
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		output.content.push({ type: "text", text: "" });
		const block = output.content[0];
		if (block.type === "text") {
			block.text = REPLY;
			stream.push({ type: "text_delta", contentIndex: 0, delta: REPLY, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: REPLY, partial: output });
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
				id: "flaky",
				name: "Ralph Fake Flaky Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeProvider,
	});
}
