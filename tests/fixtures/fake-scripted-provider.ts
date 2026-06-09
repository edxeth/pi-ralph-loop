/**
 * Test-only fake provider for prompt-contract live tests.
 *
 * It removes real-model flakiness from the live RPC suite while still driving
 * Pi, extension loading, session persistence, command handling, and Ralph's
 * fresh-session loop mechanics end-to-end.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function currentIteration(): number {
	try {
		const loop = readFileSync(join(process.cwd(), ".ralph", "loop.md"), "utf8");
		const match = loop.match(/iteration:\s*(\d+)/);
		return match ? Number(match[1]) : 1;
	} catch {
		return 1;
	}
}

async function waitForHarnessBundleMutation(): Promise<void> {
	const progressPath = join(process.cwd(), ".ralph", "progress.md");
	if (!existsSync(progressPath)) return;

	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const progress = readFileSync(progressPath, "utf8");
		if (progress.includes("Test harness")) return;
		await sleep(100);
	}
}

async function replyFor(context: Context): Promise<string> {
	const latest = latestUserText(context);

	if (latest.startsWith("continue")) {
		return "Still working.";
	}
	if (latest.includes("Ralph rejected")) {
		return "Blocked after rejection.\n<promise>STOP</promise>";
	}
	if (latest.includes("about the weather")) {
		return "The weather is calm.";
	}
	if (latest.includes("Read .ralph/loop.md")) {
		const iteration = currentIteration();
		return iteration < 3
			? `Iteration ${iteration}\n<promise>NEXT</promise>`
			: `Iteration ${iteration}\n<promise>COMPLETE</promise>`;
	}
	if (latest.includes("Read .ralph/loop.md frontmatter")) {
		return `Iteration ${currentIteration()}\n<promise>COMPLETE</promise>`;
	}
	if (latest.includes("Iteration done")) {
		return "Iteration done\n<promise>NEXT</promise>";
	}
	if (latest.includes("<promise>NEXT</promise>")) {
		await sleep(2_000);
		await waitForHarnessBundleMutation();
		return "<promise>NEXT</promise>";
	}
	if (latest.includes("<promise>COMPLETE</promise>")) {
		return "<promise>COMPLETE</promise>";
	}

	return "Done.\n<promise>COMPLETE</promise>";
}

function streamFakeScripted(
	model: Model<Api>,
	context: Context,
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
		const reply = await replyFor(context);

		if (options?.signal?.aborted) {
			output.stopReason = "aborted";
			output.errorMessage = "aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const block = output.content[0];
		if (block.type === "text") {
			block.text = reply;
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
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
				id: "scripted",
				name: "Ralph Fake Scripted Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeScripted,
	});
}
