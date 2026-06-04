import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isRecord } from "./schema.js";
import type { RalphBundle, VerificationGate } from "./types.js";

const VERIFICATION_GATE_TIMEOUT_MS = 120_000;
const VERIFICATION_GATE_OUTPUT_LIMIT = 4_000;
const VERIFICATION_GATE_RUNNER_OUTPUT_LIMIT = 64 * 1024;
const VERIFICATION_GATE_RUNNER_PATH = fileURLToPath(
	new URL("./verification-gate-runner.mjs", import.meta.url),
);

type VerificationGateFailure = {
	reason: string;
	stdout: string;
	stderr: string;
};

function capGateOutput(output: unknown): string {
	const text = Buffer.isBuffer(output)
		? output.toString("utf8")
		: String(output ?? "");
	const trimmed = text.trim();
	if (trimmed.length <= VERIFICATION_GATE_OUTPUT_LIMIT) return trimmed;
	return `${trimmed.slice(0, VERIFICATION_GATE_OUTPUT_LIMIT)}\n... output truncated ...`;
}

function getErrorCode(error: unknown): string | null {
	return isRecord(error) && typeof error.code === "string"
		? error.code
		: null;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createRunnerFailure(reason: string, output = ""): VerificationGateFailure {
	return { reason, stdout: "", stderr: capGateOutput(output) };
}

function parseRunnerFailure(output: string): VerificationGateFailure | null {
	const parsed: unknown = JSON.parse(output);
	if (!isRecord(parsed)) {
		return createRunnerFailure("verification runner returned invalid output", output);
	}
	if (parsed.ok === true) return null;

	const failure = parsed.failure;
	if (!isRecord(failure)) {
		return createRunnerFailure("verification runner returned invalid failure", output);
	}

	return {
		reason:
			typeof failure.reason === "string"
				? failure.reason
				: "verification runner failed",
		stdout: typeof failure.stdout === "string" ? failure.stdout : "",
		stderr: typeof failure.stderr === "string" ? failure.stderr : "",
	};
}

function runVerificationGate(
	root: string,
	gate: VerificationGate,
): VerificationGateFailure | null {
	const result = spawnSync(process.execPath, [VERIFICATION_GATE_RUNNER_PATH], {
		input: JSON.stringify({
			command: gate.command,
			cwd: root,
			outputLimit: VERIFICATION_GATE_OUTPUT_LIMIT,
			timeoutMs: VERIFICATION_GATE_TIMEOUT_MS,
		}),
		encoding: "utf8",
		maxBuffer: VERIFICATION_GATE_RUNNER_OUTPUT_LIMIT,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const errorCode = getErrorCode(result.error);
	if (errorCode === "ENOBUFS") {
		return createRunnerFailure("verification runner produced too much output");
	}
	if (result.error) {
		return createRunnerFailure(
			`failed to run verification runner (${getErrorMessage(result.error)})`,
			result.stderr,
		);
	}
	if (result.status !== 0) {
		return createRunnerFailure(
			`verification runner exited with code ${result.status ?? "unknown"}`,
			result.stderr || result.stdout,
		);
	}

	try {
		return parseRunnerFailure(result.stdout);
	} catch (err) {
		return createRunnerFailure(
			`verification runner returned malformed output (${getErrorMessage(err)})`,
			result.stderr || result.stdout,
		);
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
		const failure = runVerificationGate(bundle.root, gate);
		if (failure) return formatGateFailure(gate, failure);
	}
	return null;
}
