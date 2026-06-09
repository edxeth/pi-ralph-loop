/**
 * Test-only fake provider for the live active-owner startup regression.
 *
 * It keeps the primary Ralph iteration alive briefly, then emits COMPLETE.
 * During that delay the live test starts a second Pi process in the same
 * workspace. Pre-fix, the second process' startup cleanup finalized the active
 * loop as stop_reason "error" before this provider could finish.
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

const REPLY = "Still alive.\n<promise>COMPLETE</promise>";
const DELAY_MS = 12_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamFakeSlowComplete(
	model: Model<Api>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
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
		await sleep(DELAY_MS);

		if (options?.signal?.aborted) {
			output.stopReason = "aborted";
			output.errorMessage = "aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const block = output.content[0];
		if (block.type === "text") {
			block.text = REPLY;
			stream.push({ type: "text_delta", contentIndex: 0, delta: REPLY, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: REPLY, partial: output });
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
				id: "slow-complete",
				name: "Ralph Fake Slow Complete Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeSlowComplete,
	});
}
