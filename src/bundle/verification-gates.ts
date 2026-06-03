import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isRecord } from "./schema.js";
import type { RalphBundle, VerificationGate } from "./types.js";

const VERIFICATION_GATE_TIMEOUT_MS = 120_000;
const VERIFICATION_GATE_OUTPUT_LIMIT = 4_000;
const VERIFICATION_GATE_OUTPUT_READ_LIMIT = VERIFICATION_GATE_OUTPUT_LIMIT + 1;

type VerificationGateFailure = {
	reason: string;
	stdout: string;
	stderr: string;
};

type VerificationGateResult =
	| { ok: true }
	| { ok: false; failure: VerificationGateFailure };

function capGateOutput(output: unknown): string {
	const text = Buffer.isBuffer(output)
		? output.toString("utf8")
		: String(output ?? "");
	const trimmed = text.trim();
	if (trimmed.length <= VERIFICATION_GATE_OUTPUT_LIMIT) return trimmed;
	return `${trimmed.slice(0, VERIFICATION_GATE_OUTPUT_LIMIT)}\n... output truncated ...`;
}

function readCappedFile(pathname: string): string {
	const size = statSync(pathname).size;
	if (size === 0) return "";

	const bytesToRead = Math.min(size, VERIFICATION_GATE_OUTPUT_READ_LIMIT);
	const fd = openSync(pathname, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
		return capGateOutput(buffer.subarray(0, bytesRead));
	} finally {
		closeSync(fd);
	}
}

function getErrorCode(error: unknown): string | null {
	return isRecord(error) && typeof error.code === "string"
		? error.code
		: null;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function closeFile(fd: number | null): null {
	if (fd !== null) closeSync(fd);
	return null;
}

function createGateFailure(
	reason: string,
	stdout: string,
	stderr: string,
): VerificationGateResult {
	return { ok: false, failure: { reason, stdout, stderr } };
}

function executeVerificationGate(
	root: string,
	gate: VerificationGate,
): VerificationGateResult {
	const tempDir = mkdtempSync(path.join(tmpdir(), "ralph-gate-"));
	const stdoutPath = path.join(tempDir, "stdout.log");
	const stderrPath = path.join(tempDir, "stderr.log");
	let stdoutFd: number | null = null;
	let stderrFd: number | null = null;

	try {
		stdoutFd = openSync(stdoutPath, "w");
		stderrFd = openSync(stderrPath, "w");
		const result = spawnSync(gate.command, {
			cwd: root,
			shell: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			timeout: VERIFICATION_GATE_TIMEOUT_MS,
		});
		stdoutFd = closeFile(stdoutFd);
		stderrFd = closeFile(stderrFd);

		const stdout = readCappedFile(stdoutPath);
		const stderr = readCappedFile(stderrPath);
		if (result.status === 0 && result.signal === null && !result.error) {
			return { ok: true };
		}

		const errorCode = getErrorCode(result.error);
		if (errorCode === "ETIMEDOUT") {
			return createGateFailure("timed out", stdout, stderr);
		}
		if (errorCode === "ENOBUFS") {
			return createGateFailure(
				"exceeded the output capture buffer",
				stdout,
				stderr,
			);
		}
		if (typeof result.status === "number") {
			return createGateFailure(
				`exited with code ${result.status}`,
				stdout,
				stderr,
			);
		}
		if (typeof result.signal === "string") {
			return createGateFailure(
				`terminated by signal ${result.signal}`,
				stdout,
				stderr,
			);
		}
		return createGateFailure(
			`failed to run (${getErrorMessage(result.error)})`,
			stdout,
			stderr,
		);
	} finally {
		stdoutFd = closeFile(stdoutFd);
		stderrFd = closeFile(stderrFd);
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function formatGateFailure(
	gate: VerificationGate,
	failure: VerificationGateFailure,
): string {
	const output = [failure.stdout, failure.stderr].filter(Boolean).join("\n");
	return `verification gate ${gate.name} ${failure.reason}${output ? `: ${output}` : ""}`;
}

export function evaluateVerificationGates(bundle: RalphBundle): string | null {
	const gates = bundle.items.runtime_contract?.verification_gates ?? [];
	for (const gate of gates) {
		const result = executeVerificationGate(bundle.root, gate);
		if (!result.ok) return formatGateFailure(gate, result.failure);
	}
	return null;
}
