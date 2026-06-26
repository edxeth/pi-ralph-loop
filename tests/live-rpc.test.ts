import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import test from "node:test";

const SHOULD_RUN = process.env.PI_RALPH_LIVE === "1";
const MODEL = process.env.PI_RALPH_TEST_MODEL ?? "ccs-openai-alt/gpt-5.4-mini";
const THINKING = process.env.PI_RALPH_TEST_THINKING ?? "medium";

type RpcHarness = {
	workdir: string;
	sessionDir: string;
	sendPrompt: (message: string) => void;
	waitForStartup: (timeoutMs?: number) => Promise<void>;
	waitForState: (matcher: RegExp, timeoutMs?: number) => Promise<string>;
	waitForFinalState: (matcher: RegExp, timeoutMs?: number) => Promise<string>;
	readStateText: () => string;
	stateField: (text: string, key: string) => string | null;
	editState: (replacer: (text: string) => string) => void;
	listSessions: () => string[];
	userTexts: (file: string | null) => string[];
	waitForUserTextCount: (
		file: string,
		min: number,
		timeoutMs?: number,
	) => Promise<string[]>;
	stop: () => Promise<void>;
};

function createTempAgentConfig(base: string, extensionRoot: string): string {
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });

	const sourceAgentDir = join(homedir(), ".pi", "agent");
	const settingsPath = join(sourceAgentDir, "settings.json");
	const settings = existsSync(settingsPath)
		? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
				string,
				unknown
			>)
		: {};
	settings.packages = [`${extensionRoot}/`];
	settings.permissionLevel = "bypassed";
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(settings, null, 2)}\n`,
	);

	for (const name of ["models.json", "auth.json"]) {
		const source = join(sourceAgentDir, name);
		if (existsSync(source)) cpSync(source, join(agentDir, name));
	}

	return agentDir;
}

function createRpcHarness(
	options: {
		extraExtensions?: string[];
		model?: string;
		env?: Record<string, string>;
		workdir?: string;
	} = {},
): RpcHarness {
	const root = process.cwd();
	const extPath = resolve(root, "src", "index.ts");
	const base = mkdtempSync(join(tmpdir(), "ralph-live-"));
	const workdir = options.workdir ?? join(base, "work");
	const sessionDir = join(base, "sessions");
	const statePath = join(workdir, ".ralph", "loop.md");
	const agentDir = createTempAgentConfig(base, root);
	mkdirSync(workdir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const extensionArgs = ["--extension", extPath];
	for (const extra of options.extraExtensions ?? []) {
		extensionArgs.push("--extension", extra);
	}

	const child = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			...extensionArgs,
			"--session-dir",
			sessionDir,
			"--model",
			options.model ?? MODEL,
			"--thinking",
			THINKING,
		],
		{
			cwd: workdir,
			env: {
				...process.env,
				...(options.env ?? {}),
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const stderr: string[] = [];
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
	const rl = readline.createInterface({ input: child.stdout });
	rl.on("line", () => {});
	let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	child.on("exit", (code, signal) => {
		exited = { code, signal };
	});

	const readStateText = () =>
		existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
	const stateField = (text: string, key: string): string | null => {
		const m = text.match(new RegExp(`${key}:\\s*(?:"([^"]*)"|([^\\n]*))`));
		return m ? (m[1] ?? m[2] ?? "").trim() : null;
	};
	const listSessions = () =>
		readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f));
	const userTexts = (file: string | null): string[] => {
		if (!file || !existsSync(file)) return [];
		const out: string[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const e = entry as {
				type?: string;
				message?: { role?: string; content?: unknown };
			};
			if (e?.type !== "message" || e.message?.role !== "user") continue;
			const c = e.message.content;
			const text =
				typeof c === "string"
					? c
					: Array.isArray(c)
						? c
								.map((b) =>
									b && typeof b === "object" && (b as { type?: string }).type === "text"
										? ((b as { text?: string }).text ?? "")
										: "",
								)
								.join("")
						: "";
			out.push(text.trim());
		}
		return out;
	};

	function getExitError(): Error | null {
		if (!exited) return null;
		const tail = stderr.join("").trim().split("\n").slice(-20).join("\n");
		return new Error(
			`Pi RPC process exited with code ${exited.code} signal ${exited.signal}${tail ? `:\n${tail}` : ""}`,
		);
	}

	return {
		workdir,
		sessionDir,
		readStateText,
		stateField,
		listSessions,
		userTexts,
		async waitForStartup(timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			const stableUntil = Date.now() + 2_000;
			while (Date.now() < deadline) {
				const exitError = getExitError();
				if (exitError) throw exitError;
				if (Date.now() >= stableUntil) return;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error("Timed out waiting for Pi RPC startup");
		},
		editState(replacer: (text: string) => string) {
			writeFileSync(statePath, replacer(readFileSync(statePath, "utf8")), "utf8");
		},
		sendPrompt(message: string) {
			child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		},
		async waitForState(matcher: RegExp, timeoutMs = 240_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const exitError = getExitError();
				if (exitError) throw exitError;
				if (existsSync(statePath)) {
					const text = readFileSync(statePath, "utf8");
					if (matcher.test(text)) return text;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new Error(`Timed out waiting for state: ${matcher}`);
		},
		async waitForFinalState(matcher: RegExp, timeoutMs = 240_000) {
			return this.waitForState(
				new RegExp(`running:\\s*false[\\s\\S]*${matcher.source}`),
				timeoutMs,
			);
		},
		async waitForUserTextCount(file: string, min: number, timeoutMs = 90_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const exitError = getExitError();
				if (exitError) throw exitError;
				const texts = userTexts(file);
				if (texts.length >= min) return texts;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new Error(
				`Timed out waiting for >= ${min} user messages in ${file}`,
			);
		},
		async stop() {
			if (exited) return;
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((resolve) => child.on("exit", resolve)),
				new Promise((resolve) => setTimeout(resolve, 5_000)),
			]);
			if (!exited) child.kill("SIGKILL");
		},
	};
}

function scriptedProviderPath(): string {
	return resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-scripted-provider.ts",
	);
}

function createScriptedHarness(): RpcHarness {
	return createRpcHarness({
		extraExtensions: [scriptedProviderPath()],
		model: "ralph-fake/scripted",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
}

function writeBundle(
	workdir: string,
	prompt = "Reply with exactly one line: <promise>NEXT</promise>",
): void {
	const ralphDir = join(workdir, ".ralph");
	mkdirSync(ralphDir, { recursive: true });
	writeFileSync(join(ralphDir, "plan.md"), "# Live bundle plan\n");
	writeFileSync(join(ralphDir, "prompt.md"), prompt);
	writeFileSync(join(ralphDir, "progress.md"), "# Live progress\n");
	writeFileSync(
		join(ralphDir, "items.json"),
		`${JSON.stringify(
			{
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
			},
			null,
			2,
		)}\n`,
	);
}
// A two-item bundle whose only runtime_contract verification gate PASSES
// (exit 0) but emits ~20 KB of output. Pre-fix, the buffered gate runner
// misread that volume as a failure and rejected NEXT, so the iteration-2 fresh
// session was never opened. require_progress_append + require_one_item is what
// the fake driver provider satisfies each iteration.
function writeNoisyGateBundle(workdir: string): void {
	const ralphDir = join(workdir, ".ralph");
	mkdirSync(ralphDir, { recursive: true });
	const noisyScript = join(workdir, "noisy-pass.js");
	writeFileSync(noisyScript, `process.stdout.write("x".repeat(20000));\n`);
	const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(noisyScript)}`;

	writeFileSync(join(ralphDir, "plan.md"), "# Noisy gate plan\n");
	writeFileSync(join(ralphDir, "prompt.md"), "Drive the bundle one item per iteration.");
	writeFileSync(join(ralphDir, "progress.md"), "# progress\n");
	writeFileSync(
		join(ralphDir, "items.json"),
		`${JSON.stringify(
			{
				version: 1,
				runtime_contract: {
					verification_gates: [{ name: "noisy", command: gateCommand }],
					require_progress_append: true,
					require_one_item_per_iteration: true,
					require_commit: false,
				},
				items: [
					{ category: "functional", description: "Item one.", steps: ["a"], passes: false, regression_notes: "" },
					{ category: "functional", description: "Item two.", steps: ["b"], passes: false, regression_notes: "" },
				],
			},
			null,
			2,
		)}\n`,
	);
}

test("live pi RPC: NEXT advances and COMPLETE stops", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		h.sendPrompt(
			'/ralph-loop "Read .ralph/loop.md to get the current iteration number from frontmatter. If iteration is less than 3, reply with exactly two lines: Iteration <n> and <promise>NEXT</promise>. Otherwise reply with exactly two lines: Iteration <n> and <promise>COMPLETE</promise>. Do not use code fences." --max-iterations=4',
		);
		const state = await h.waitForFinalState(/stop_reason:\s*"complete"/);
		assert.match(state, /iteration:\s*3/);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: NEXT on last iteration stops at max_iterations", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
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

test("live pi RPC: observer startup preserves an active loop owner", {
	skip: !SHOULD_RUN,
}, async () => {
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-slow-complete-provider.ts",
	);
	const owner = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/slow-complete",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
	let observer: RpcHarness | null = null;
	try {
		owner.sendPrompt(
			'/ralph-loop "Stay active briefly, then complete." --max-iterations=1',
		);
		const active = await owner.waitForState(
			/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/,
			60_000,
		);
		assert.match(active, /owner_pid:\s*\d+/);
		assert.match(active, /owner_heartbeat_at:\s*"[^"]+"/);

		observer = createRpcHarness({
			workdir: owner.workdir,
			extraExtensions: [fakeProvider],
			model: "ralph-fake/slow-complete",
			env: { RALPH_FAKE_API_KEY: "unused-but-present" },
		});
		await observer.waitForStartup();
		await new Promise((resolve) => setTimeout(resolve, 2_000));

		const afterObserverStartup = owner.readStateText();
		assert.match(afterObserverStartup, /running:\s*true/);
		assert.doesNotMatch(afterObserverStartup, /stop_reason:\s*"error"/);

		const finalState = await owner.waitForFinalState(
			/stop_reason:\s*"complete"/,
			120_000,
		);
		assert.match(finalState, /owner_pid:\s*null/);
		assert.match(finalState, /owner_heartbeat_at:\s*null/);
	} finally {
		if (observer) await observer.stop();
		await owner.stop();
	}
});

test("live pi RPC: a non-owner process quitting does not cancel the loop", {
	skip: !SHOULD_RUN,
}, async () => {
	// Reproduces the false "user_cancelled": any other pi process in the same
	// workdir (here a second RPC pi process) loads the extension and exits,
	// firing session_shutdown reason "quit" from a pid that is not the owner.
	// The owner loop must keep running and complete normally.
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-slow-complete-provider.ts",
	);
	const owner = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/slow-complete",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
	let sibling: RpcHarness | null = null;
	try {
		owner.sendPrompt(
			'/ralph-loop "Stay active briefly, then complete." --max-iterations=1',
		);
		const active = await owner.waitForState(
			/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/,
			60_000,
		);
		assert.match(active, /owner_pid:\s*\d+/);

		// Start a second pi in the SAME workdir, let it load the extension, then
		// stop it. Its .stop() sends SIGTERM -> rpc shutdown -> runtimeHost.dispose()
		// -> session_shutdown reason "quit", from a pid != owner_pid.
		sibling = createRpcHarness({
			workdir: owner.workdir,
			extraExtensions: [fakeProvider],
			model: "ralph-fake/slow-complete",
			env: { RALPH_FAKE_API_KEY: "unused-but-present" },
		});
		await sibling.waitForStartup();
		await sibling.stop();
		// Give the owner a moment to observe (and, before the fix, react to) the
		// sibling's shutdown before it completes on its own.
		await new Promise((resolve) => setTimeout(resolve, 3_000));

		const afterSiblingQuit = owner.readStateText();
		assert.doesNotMatch(afterSiblingQuit, /cancel_requested:\s*true/);
		assert.doesNotMatch(afterSiblingQuit, /stop_reason:\s*"user_cancelled"/);

		const finalState = await owner.waitForFinalState(
			/stop_reason:\s*"complete"/,
			120_000,
	);
		assert.match(finalState, /stop_reason:\s*"complete"/);
	} finally {
		if (sibling) await sibling.stop();
		await owner.stop();
	}
});

test("live pi RPC: accepted bundle NEXT creates a fresh session", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		writeBundle(h.workdir);
		h.sendPrompt('/ralph-loop "@.ralph/prompt.md" --max-iterations=3');
		await h.waitForState(
			/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/,
		);
		const itemsPath = join(h.workdir, ".ralph", "items.json");
		const items = JSON.parse(readFileSync(itemsPath, "utf8")) as {
			items: Array<{ passes: boolean }>;
		};
		items.items[0].passes = true;
		writeFileSync(itemsPath, `${JSON.stringify(items, null, 2)}\n`);
		writeFileSync(
			join(h.workdir, ".ralph", "progress.md"),
			"# Live progress\n- Test harness completed first item.\n",
		);
		const state = await h.waitForState(
			/running:\s*true[\s\S]*iteration:\s*2[\s\S]*transitioning:\s*false/,
			360_000,
		);
		assert.match(state, /last_session_file:\s*".*\.jsonl"/);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: rejected bundle NEXT stays in the same session", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		writeBundle(h.workdir);
		const sessionsBefore = h.listSessions().length;
		h.sendPrompt('/ralph-loop "@.ralph/prompt.md" --max-iterations=2');
		const started = await h.waitForState(
			/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/,
		);
		const session = h.stateField(started, "last_session_file");
		assert.ok(session);
		writeFileSync(
			join(h.workdir, ".ralph", "progress.md"),
			"# Live progress\n- Test harness appended progress without item completion.\n",
		);

		const state = await h.waitForFinalState(
			/stop_reason:\s*"manual_stop"/,
			60_000,
		);
		assert.match(state, /iteration:\s*1/);
		assert.match(state, /bundle_rejection_count:\s*1/);
		assert.equal(h.stateField(state, "last_session_file"), session);
		assert.equal(
			h.listSessions().length,
			sessionsBefore + 1,
			"rejected NEXT must not open a fresh iteration session",
		);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: recovers from a provider error via Pi's auto-retry", {
	skip: !SHOULD_RUN,
}, async () => {
	// Drive Pi's real retry machinery: the fake provider's first stream fails
	// with a retryable "WebSocket error", then the retry succeeds with COMPLETE.
	// Pi backs off ~2s between attempts and is idle during that window, which is
	// exactly when the pre-fix loop wrongly finalized as "error". The loop must
	// instead wait out the backoff and finalize "complete".
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-provider.ts",
	);
	const h = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/flaky",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
	try {
		h.sendPrompt(
			'/ralph-loop "Do the work and report the result." --max-iterations=2',
		);
		const state = await h.waitForFinalState(
			/stop_reason:\s*"complete"/,
			120_000,
		);
		// The provider error was seen and counted, but recovery still completed.
		assert.match(state, /error_count:\s*1/);
		assert.doesNotMatch(state, /stop_reason:\s*"error"/);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: Ralph recovery nudge resumes after Pi retry exhaustion", {
	skip: !SHOULD_RUN,
}, async () => {
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-recovery-provider.ts",
	);
	const h = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/recovery",
		env: {
			RALPH_FAKE_API_KEY: "unused-but-present",
			RALPH_TEST_PROVIDER_RETRY_WAIT_MS: "50",
			RALPH_TEST_PROVIDER_RECOVERY_NUDGE_DELAY_MS: "50",
			RALPH_TEST_PROVIDER_RECOVERY_FALLBACK_DELAY_MS: "50",
		},
	});
	try {
		h.sendPrompt(
			'/ralph-loop "Fail until Ralph sends continue, then complete." --max-iterations=1',
		);
		const state = await h.waitForFinalState(
			/stop_reason:\s*"complete"/,
			120_000,
		);
		assert.match(state, /error_count:\s*[1-9]/);
		const session = h.stateField(state, "last_session_file");
		const userMessages = h.userTexts(session);
		assert.ok(
			userMessages.some((message) => message.startsWith("continue")),
			"Ralph recovery should inject a continue nudge after Pi retries exhaust",
		);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: provider error resets the missing-promise nudge chain", {
	skip: !SHOULD_RUN,
}, async () => {
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-nudge-reset-provider.ts",
	);
	const h = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/nudge-reset",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
	try {
		h.sendPrompt(
			'/ralph-loop "Do one unit of work, then end with a promise tag." --max-iterations=1',
		);
		const state = await h.waitForFinalState(
			/stop_reason:\s*"manual_stop"/,
			120_000,
		);

		assert.match(state, /error_count:\s*1/);
		assert.doesNotMatch(state, /stop_reason:\s*"error"/);
		const session = h.stateField(state, "last_session_file");
		const userMessages = h.userTexts(session);
		assert.equal(
			userMessages.filter((message) => message === "continue").length,
			5,
			"Ralph should send a fresh continue nudge after provider recovery",
		);
	} finally {
		await h.stop();
	}
});

// ── /ralph-resume same-session routing (reuse path) ─────────────────────
// These exercise the three reuse-path conditions through the real runtime:
// the seed prompt must be delivered exactly once per session, so resume must
// either route an already-emitted promise or nudge "continue" — never re-seed.

test("live pi RPC: resume re-finalizes an already-emitted COMPLETE without re-seeding", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		h.sendPrompt(
			'/ralph-loop "Read .ralph/loop.md frontmatter for iteration n. Reply with EXACTLY two lines: first \\"Iteration <n>\\", second \\"<promise>COMPLETE</promise>\\". No code fences." --max-iterations=3',
		);
		const s = await h.waitForFinalState(/stop_reason:\s*"complete"/);
		const session = h.stateField(s, "last_session_file");
		assert.ok(session, "expected a session file in state");
		const before = h.userTexts(session).length;

		h.sendPrompt("/ralph-resume --force");
		await new Promise((resolve) => setTimeout(resolve, 8000));

		const after = h.userTexts(session).length;
		assert.equal(after, before, "resume must not re-seed the prompt");
		assert.match(h.readStateText(), /stop_reason:\s*"complete"/);
		assert.match(h.readStateText(), /running:\s*false/);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: resume advances on an already-emitted NEXT and opens a fresh session", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		h.sendPrompt(
			'/ralph-loop "Reply with EXACTLY two lines and nothing else: first \\"Iteration done\\", second \\"<promise>NEXT</promise>\\". No code fences." --max-iterations=1',
		);
		const s = await h.waitForFinalState(/stop_reason:\s*"max_iterations"/);
		const session = h.stateField(s, "last_session_file");
		assert.ok(session);
		const seedCount = h.userTexts(session).length;
		const sessionsBefore = h.listSessions().length;

		// Realistic resume: raise the cap, then continue the saved iteration.
		h.editState((t) => t.replace(/max_iterations:\s*1/, "max_iterations: 2"));
		h.sendPrompt("/ralph-resume");
		const s2 = await h.waitForState(
			/running:\s*false[\s\S]*iteration:\s*2/,
		);

		assert.match(s2, /iteration:\s*2/);
		assert.equal(
			h.listSessions().length,
			sessionsBefore + 1,
			"NEXT on resume must open a fresh session",
		);
		assert.equal(
			h.userTexts(session).length,
			seedCount,
			"resume must not re-seed the original session",
		);
	} finally {
		await h.stop();
	}
});

test("live pi RPC: resume nudges 'continue' when no promise was emitted yet", {
	skip: !SHOULD_RUN,
}, async () => {
	const h = createScriptedHarness();
	try {
		// A prompt that never emits a promise gets nudged with "continue". We let
		// exactly one nudge land (proving a no-promise turn happened), then stop the
		// loop cleanly so the saved session ends mid-work with no promise on its
		// last turn -- the State B precondition, without burning the 5-nudge budget.
		h.sendPrompt(
			'/ralph-loop "Reply with exactly one short sentence about the weather. Do not output any promise tag." --max-iterations=1',
		);
		const started = await h.waitForState(
			/running:\s*true[\s\S]*iteration:\s*1[\s\S]*transitioning:\s*false/,
		);
		const session = h.stateField(started, "last_session_file");
		assert.ok(session);
		// Wait until at least one "continue" nudge has been appended (a no-promise
		// turn was observed), then request a clean stop.
		await h.waitForUserTextCount(session, 2, 120_000);
		h.sendPrompt("/ralph-stop");
		const stopped = await h.waitForFinalState(/stop_reason:\s*"manual_stop"/, 120_000);
		assert.equal(h.stateField(stopped, "last_session_file"), session);
		const before = h.userTexts(session);
		const seedCount = before.filter((t) => t.includes("about the weather")).length;

		h.sendPrompt("/ralph-resume");
		const after = await h.waitForUserTextCount(session, before.length + 1);

		assert.equal(
			after[before.length],
			"continue",
			"resume must nudge continue, not re-seed the prompt",
		);
		assert.equal(
			after.filter((t) => t.includes("about the weather")).length,
			seedCount,
			"resume must never re-seed the prompt",
		);
	} finally {
		await h.stop();
	}
});

// ── Regression: noisy-but-passing verification gate must not block the
// fresh-session-after-NEXT handoff ──────────────────────────────────────
//
// Symptom this guards: "a new session never starts after <promise>NEXT</promise>".
// Root cause it reproduces: a verification gate that PASSES (exit 0) but emits
// more output than the old buffered runner allowed was misclassified as a
// failure. validateBundlePromise then rejected NEXT, handleNextPromise returned
// before scheduleNextIteration, and openFreshIterationSession was never reached.
// The handoff machinery is fine; it was simply never invoked.
//
// Pre-fix (buffered gate): NEXT rejected up to MAX_BUNDLE_REJECTIONS, loop ends
//   stop_reason "error", stuck at iteration 1, only one session file.
// Post-fix (file-backed gate): NEXT accepted, iteration 2 opens a FRESH session,
//   second item completes, loop ends "complete" with >= 2 session files.
test("live pi RPC: accepted NEXT opens a fresh session even when a passing gate is noisy", {
	skip: !SHOULD_RUN,
}, async () => {
	const fakeProvider = resolve(
		process.cwd(),
		"tests",
		"fixtures",
		"fake-driver-provider.ts",
	);
	const h = createRpcHarness({
		extraExtensions: [fakeProvider],
		model: "ralph-fake/driver",
		env: { RALPH_FAKE_API_KEY: "unused-but-present" },
	});
	try {
		writeNoisyGateBundle(h.workdir);
		const sessionsBefore = h.listSessions().length;
		h.sendPrompt('/ralph-loop "@.ralph/prompt.md" --max-iterations=2');

		// Wait for the loop to finish for ANY reason, then assert on the reason.
		// This fails fast and crisply on the bug (stop_reason "error") instead of
		// hanging until the timeout waiting for a "complete" that never comes.
		const state = await h.waitForState(/running:\s*false/, 150_000);

		// NEXT was accepted on the first try -- the noisy passing gate did not
		// reject it, so the loop did not error out under repeated rejections.
		assert.match(
			state,
			/stop_reason:\s*"complete"/,
			`loop did not complete; stop_reason was ${h.stateField(state, "stop_reason")}, bundle_rejection_count ${h.stateField(state, "bundle_rejection_count")} (noisy gate likely rejected NEXT)`,
		);
		// The fresh session for iteration 2 was actually opened.
		assert.match(state, /iteration:\s*2/);
		assert.ok(
			h.listSessions().length >= sessionsBefore + 2,
			"each iteration must open a fresh session; NEXT handoff was blocked",
		);
		assert.match(state, /bundle_rejection_count:\s*0/);
	} finally {
		await h.stop();
	}
});
