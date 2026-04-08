import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const SHOULD_RUN = process.env.PI_RALPH_LIVE === "1";
const MODEL = "ccs-openai-alt/gpt-5.4-mini";
const THINKING = "medium";

type RpcHarness = {
  sendPrompt: (message: string) => void;
  waitForFinalState: (matcher: RegExp, timeoutMs?: number) => Promise<string>;
  stop: () => Promise<void>;
};

function createRpcHarness(): RpcHarness {
  const root = process.cwd();
  const piBin = resolve(root, "node_modules/.bin/pi");
  const extPath = resolve(root, "index.ts");
  const base = mkdtempSync(join(tmpdir(), "ralph-live-"));
  const workdir = join(base, "work");
  const sessionDir = join(base, "sessions");
  const statePath = join(workdir, ".ralph", "loop.md");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const child = spawn(
    piBin,
    [
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
    { cwd: workdir, stdio: ["pipe", "pipe", "pipe"] },
  );

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", () => {});

  return {
    sendPrompt(message: string) {
      child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    },
    async waitForFinalState(matcher: RegExp, timeoutMs = 240_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (existsSync(statePath)) {
          const text = readFileSync(statePath, "utf8");
          if (/running:\s*false/.test(text) && matcher.test(text)) return text;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`Timed out waiting for final state: ${matcher}`);
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
    },
  };
}

test(
  "live pi: NEXT advances and COMPLETE stops",
  { skip: !SHOULD_RUN },
  async () => {
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
  },
);

test(
  "live pi: NEXT on last iteration stops at max_iterations",
  { skip: !SHOULD_RUN },
  async () => {
    const h = createRpcHarness();
    try {
      h.sendPrompt('/ralph-loop "Reply with exactly one line: <promise>NEXT</promise>" --max-iterations=2');
      const state = await h.waitForFinalState(/stop_reason:\s*"max_iterations"/);
      assert.match(state, /iteration:\s*2/);
    } finally {
      await h.stop();
    }
  },
);
