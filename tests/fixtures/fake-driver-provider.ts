/**
 * Test-only fake provider that drives a multi-item Ralph bundle deterministically,
 * with no network or API key. Used by the fresh-session-after-NEXT regression test.
 *
 * Each iteration (identified by the `iteration:` field in .ralph/loop.md, so that
 * rejection re-calls within the same iteration never double-flip an item):
 *   - mark the first not-yet-passing item passes:true
 *   - append one line to .ralph/progress.md (satisfies require_progress_append)
 *   - emit <promise>COMPLETE</promise> once every item passes, else <promise>NEXT</promise>
 *
 * The per-iteration guard lives on globalThis because Pi reloads extension modules
 * across the fresh sessions Ralph opens per iteration; a module-level guard would
 * reset every iteration. Keyed by iteration number so a fresh session for the next
 * iteration is free to act again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const ACTED_KEY = "__ralph_fake_driver_acted_iters__";

function currentIteration(ralphDir: string): number {
	try {
		const loop = readFileSync(join(ralphDir, "loop.md"), "utf8");
		const match = loop.match(/iteration:\s*(\d+)/);
		return match ? Number(match[1]) : 0;
	} catch {
		return 0;
	}
}

function driveBundle(): string {
	const ralphDir = join(process.cwd(), ".ralph");
	const itemsPath = join(ralphDir, "items.json");
	const progressPath = join(ralphDir, "progress.md");
	const iteration = currentIteration(ralphDir);

	const store = globalThis as Record<string, unknown>;
	const acted = (store[ACTED_KEY] as Record<number, boolean> | undefined) ?? {};
	store[ACTED_KEY] = acted;

	const bundle = JSON.parse(readFileSync(itemsPath, "utf8")) as {
		items: Array<{ passes: boolean }>;
	};

	if (!acted[iteration]) {
		const target = bundle.items.find((item) => !item.passes);
		if (target) {
			target.passes = true;
			writeFileSync(itemsPath, `${JSON.stringify(bundle, null, 2)}\n`);
			const previous = readFileSync(progressPath, "utf8");
			writeFileSync(
				progressPath,
				`${previous}- iteration ${iteration}: marked one item passing\n`,
			);
		}
		acted[iteration] = true;
	}

	return bundle.items.every((item) => item.passes)
		? "Done.\n<promise>COMPLETE</promise>"
		: "Item done.\n<promise>NEXT</promise>";
}

function streamFakeDriver(
	model: Model<Api>,
	_context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const reply = driveBundle();
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
				id: "driver",
				name: "Ralph Fake Driver Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFakeDriver,
	});
}
