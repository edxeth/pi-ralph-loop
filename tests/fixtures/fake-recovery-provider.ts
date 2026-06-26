/**
 * Test-only fake provider for Ralph's own provider-error recovery nudge.
 *
 * It keeps failing while Pi retries the original user prompt. When Ralph's
 * recovery path later injects `continue`, the provider succeeds with COMPLETE.
 * This proves the extension's wait -> countdown -> nudge path in a real Pi RPC
 * process without depending on an external provider outage.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromMessage(message: Message): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function latestUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const text = textFromMessage(context.messages[i]);
		if (text) return text;
	}
	return "";
}

function streamFakeRecoveryProvider(
	model: Model<Api>,
	context: Context,
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

		if (!latestUserText(context).startsWith("continue")) {
			output.stopReason = "error";
			output.errorMessage = "Connection error: WebSocket error";
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		const reply = "Recovered after Ralph nudge.\n<promise>COMPLETE</promise>";
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
				id: "recovery",
				name: "Ralph Fake Recovery Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeRecoveryProvider,
	});
}
