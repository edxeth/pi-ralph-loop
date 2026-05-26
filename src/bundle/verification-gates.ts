import { execFileSync } from "node:child_process";

import { isRecord } from "./schema.js";
import type { RalphBundle, VerificationGate } from "./types.js";

const VERIFICATION_GATE_TIMEOUT_MS = 120_000;
const VERIFICATION_GATE_OUTPUT_LIMIT = 4_000;

function capGateOutput(output: unknown): string {
	const text = Buffer.isBuffer(output)
		? output.toString("utf8")
		: String(output ?? "");
	const trimmed = text.trim();
	if (trimmed.length <= VERIFICATION_GATE_OUTPUT_LIMIT) return trimmed;
	return `${trimmed.slice(0, VERIFICATION_GATE_OUTPUT_LIMIT)}\n... output truncated ...`;
}

function formatGateFailure(gate: VerificationGate, err: unknown): string {
	if (isRecord(err)) {
		const signal = typeof err.signal === "string" ? err.signal : null;
		const status = typeof err.status === "number" ? err.status : null;
		const stdout = capGateOutput(err.stdout);
		const stderr = capGateOutput(err.stderr);
		const output = [stdout, stderr].filter(Boolean).join("\n");
		const reason =
			signal === "SIGTERM"
				? "timed out"
				: status !== null
					? `exited with code ${status}`
					: "failed to run";
		return `verification gate ${gate.name} ${reason}${output ? `: ${output}` : ""}`;
	}
	return `verification gate ${gate.name} failed: ${String(err)}`;
}

export function evaluateVerificationGates(bundle: RalphBundle): string | null {
	const gates = bundle.items.runtime_contract?.verification_gates ?? [];
	for (const gate of gates) {
		try {
			execFileSync(gate.command, {
				cwd: bundle.root,
				shell: true,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: VERIFICATION_GATE_TIMEOUT_MS,
				maxBuffer: VERIFICATION_GATE_OUTPUT_LIMIT * 2,
			});
		} catch (err) {
			return formatGateFailure(gate, err);
		}
	}
	return null;
}
