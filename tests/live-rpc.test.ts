import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import test from "node:test";

const SHOULD_RUN = process.env.PI_RALPH_LIVE === "1";
const MODEL = process.env.PI_RALPH_TEST_MODEL ?? "ccs-openai-alt/gpt-5.4-mini";
const THINKING = process.env.PI_RALPH_TEST_THINKING ?? "medium";
const TIA_BIN = process.env.PI_RALPH_TIA_BIN ?? "tia";

type RpcHarness = {
	workdir: string;
	sessionDir: string;
	sendPrompt: (message: string) => void;
	waitForState: (matcher: RegExp, timeoutMs?: number) => Promise<string>;
	waitForFinalState: (matcher: RegExp, timeoutMs?: number) => Promise<string>;
	stop: () => Promise<void>;
};

function createTempAgentConfig(base: string, extensionRoot: string): string {
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });

	const sourceAgentDir = join(homedir(), ".pi", "agent");
	const settingsPath = join(sourceAgentDir, "settings.json");
	const settings = existsSync(settingsPath)
		? JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>
		: {};
	settings.packages = [`${extensionRoot}/`];
	settings.permissionLevel = "bypassed";
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

	for (const name of ["models.json", "auth.json"]) {
		const source = join(sourceAgentDir, name);
		if (existsSync(source)) cpSync(source, join(agentDir, name));
	}

	return agentDir;
}

function createRpcHarness(): RpcHarness {
	const root = process.cwd();
	const extPath = resolve(root, "index.ts");
	const base = mkdtempSync(join(tmpdir(), "ralph-live-"));
	const workdir = join(base, "work");
	const sessionDir = join(base, "sessions");
	const statePath = join(workdir, ".ralph", "loop.md");
	const agentDir = createTempAgentConfig(base, root);
	mkdirSync(workdir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const child = spawn(
		TIA_BIN,
		[
			"pi",
			"--mode",
			"rpc",
			"--extension",
			extPath,
			"--session-dir",
			sessionDir,
			"--model",
			MODEL,
			"--thinking",
			THINKING,
		],
		{
			cwd: workdir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const rl = readline.createInterface({ input: child.stdout });
	rl.on("line", () => {});

	return {
		workdir,
		sessionDir,
		sendPrompt(message: string) {
			child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		},
		async waitForState(matcher: RegExp, timeoutMs = 240_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (existsSync(statePath)) {
					const text = readFileSync(statePath, "utf8");
					if (matcher.test(text)) return text;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new Error(`Timed out waiting for state: ${matcher}`);
		},
		async waitForFinalState(matcher: RegExp, timeoutMs = 240_000) {
			return this.waitForState(new RegExp(`running:\\s*false[\\s\\S]*${matcher.source}`), timeoutMs);
		},
		async stop() {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.on("exit", resolve));
		},
	};
}

function writeBundle(workdir: string, prompt = "Reply with exactly one line: <promise>NEXT</promise>"): void {
	const ralphDir = join(workdir, ".ralph");
	mkdirSync(ralphDir, { recursive: true });
	writeFileSync(join(ralphDir, "plan.md"), "# Live bundle plan\n");
	writeFileSync(join(ralphDir, "prompt.md"), prompt);
	writeFileSync(join(ralphDir, "progress.md"), "# Live progress\n");
	writeFileSync(join(ralphDir, "items.json"), `${JSON.stringify({
		version: 1,
		runtime_contract: {
			require_progress_append: true,
			require_one_item_per_iteration: true,
			require_clean_source_docs: true,
		},
		items: [
			{
				category: "live",
				description: "Complete the first live bundle item.",
				steps: ["Mark only this item passing during iteration 1."],
				passes: false,
				regression_notes: "",
			},
			{
				category: "live",
				description: "Complete the second live bundle item.",
				steps: ["Mark only this item passing during iteration 2."],
				passes: false,
				regression_notes: "",
			},
		],
	}, null, 2)}\n`);
}

test("live pi through tia: NEXT advances and COMPLETE stops", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createRpcHarness();
	try {
		h.sendPrompt(
			'/ralph-loop "Read .ralph/loop.md to get the current iteration number from frontmatter. If iteration is less than 2, reply with exactly two lines: Iteration <n> and <promise>NEXT</promise>. Otherwise reply with exactly two lines: Iteration <n> and <promise>COMPLETE</promise>. Do not use code fences." --max-iterations=3',
		);
		const state = await h.waitForFinalState(/stop_reason:\s*"complete"/);
		assert.match(state, /iteration:\s*2/);
	} finally {
		await h.stop();
	}
});

test("live pi through tia: NEXT on last iteration stops at max_iterations", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createRpcHarness();
	try {
		h.sendPrompt(
			'/ralph-loop "Reply with exactly one line: <promise>NEXT</promise>" --max-iterations=2',
		);
		const state = await h.waitForFinalState(/stop_reason:\s*"max_iterations"/);
		assert.match(state, /iteration:\s*2/);
	} finally {
		await h.stop();
	}
});

test("live pi through tia: accepted bundle NEXT creates a fresh session", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createRpcHarness();
	try {
		writeBundle(h.workdir);
		h.sendPrompt('/ralph-loop "@.ralph/prompt.md" --max-iterations=3');
		await h.waitForState(/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/);
		const itemsPath = join(h.workdir, ".ralph", "items.json");
		const items = JSON.parse(readFileSync(itemsPath, "utf8")) as { items: Array<{ passes: boolean }> };
		items.items[0].passes = true;
		writeFileSync(itemsPath, `${JSON.stringify(items, null, 2)}\n`);
		writeFileSync(join(h.workdir, ".ralph", "progress.md"), "# Live progress\n- Test harness completed first item.\n");
		const state = await h.waitForState(/running:\s*true[\s\S]*iteration:\s*2[\s\S]*transitioning:\s*false/, 360_000);
		assert.match(state, /last_session_file:\s*".*\.jsonl"/);
	} finally {
		await h.stop();
	}
});

test("live pi through tia: rejected bundle NEXT stays in the same session", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createRpcHarness();
	try {
		writeBundle(h.workdir);
		h.sendPrompt('/ralph-loop "@.ralph/prompt.md" --max-iterations=2');
		await h.waitForState(/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/);
		writeFileSync(join(h.workdir, ".ralph", "progress.md"), "# Live progress\n- Test harness appended progress without item completion.\n");
		await new Promise((resolve) => setTimeout(resolve, 15_000));
		const state = await h.waitForState(/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/, 1_000);
		assert.doesNotMatch(state, /iteration:\s*2/);
	} finally {
		await h.stop();
	}
});
