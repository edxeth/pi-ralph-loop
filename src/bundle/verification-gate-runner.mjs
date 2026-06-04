import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const KILL_GRACE_MS = 5_000;

class CappedOutput {
	chunks = [];
	capturedBytes = 0;
	truncated = false;

	constructor(outputLimit) {
		this.outputLimit = outputLimit;
		this.captureLimit = outputLimit + 1;
	}

	append(chunk) {
		if (this.capturedBytes >= this.captureLimit) {
			this.truncated = true;
			return;
		}

		const remaining = this.captureLimit - this.capturedBytes;
		if (chunk.length > remaining) {
			this.chunks.push(chunk.subarray(0, remaining));
			this.capturedBytes += remaining;
			this.truncated = true;
			return;
		}

		this.chunks.push(chunk);
		this.capturedBytes += chunk.length;
	}

	toText() {
		const text = Buffer.concat(this.chunks).toString("utf8").trim();
		if (!this.truncated && text.length <= this.outputLimit) return text;

		const visible = text.slice(0, this.outputLimit);
		return visible ? `${visible}\n... output truncated ...` : "... output truncated ...";
	}
}

function getErrorCode(error) {
	return error && typeof error === "object" && typeof error.code === "string"
		? error.code
		: null;
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function createFailure(reason, stdout, stderr) {
	return {
		ok: false,
		failure: {
			reason,
			stdout: stdout.toText(),
			stderr: stderr.toText(),
		},
	};
}

function runGate(input) {
	return new Promise((resolve) => {
		const stdout = new CappedOutput(input.outputLimit);
		const stderr = new CappedOutput(input.outputLimit);
		const child = spawn(input.command, {
			cwd: input.cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		let settled = false;
		let forceKillTimer = null;

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, KILL_GRACE_MS);
		}, input.timeoutMs);

		function settle(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			resolve(result);
		}

		child.stdout.on("data", (chunk) => stdout.append(chunk));
		child.stderr.on("data", (chunk) => stderr.append(chunk));
		child.once("error", (error) => {
			const errorCode = getErrorCode(error);
			if (errorCode === "ENOBUFS") {
				settle(
					createFailure(
						"exceeded the output capture buffer",
						stdout,
						stderr,
					),
				);
				return;
			}
			settle(
				createFailure(
					`failed to run (${getErrorMessage(error)})`,
					stdout,
					stderr,
				),
			);
		});
		child.once("close", (code, signal) => {
			if (code === 0 && !timedOut) {
				settle({ ok: true });
				return;
			}
			if (timedOut) {
				settle(createFailure("timed out", stdout, stderr));
				return;
			}
			if (typeof code === "number") {
				settle(createFailure(`exited with code ${code}`, stdout, stderr));
				return;
			}
			if (typeof signal === "string") {
				settle(
					createFailure(`terminated by signal ${signal}`, stdout, stderr),
				);
				return;
			}
			settle(createFailure("failed to run", stdout, stderr));
		});
	});
}

async function main() {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const result = await runGate(input);
	process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
	process.stdout.write(
		JSON.stringify({
			ok: false,
			failure: {
				reason: `failed to run verification runner (${getErrorMessage(error)})`,
				stdout: "",
				stderr: "",
			},
		}),
	);
});
