import {
	createBundleSnapshot,
	evaluateBundleCompleteFileGate,
	evaluateBundleFileGate,
	evaluateCompleteGate,
	evaluateNextGate,
	evaluateVerificationGates,
	loadRalphBundle,
} from "../bundle/index.js";
import { updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";

export function snapshotBundleIteration(cwd: string): void {
	const bundle = loadRalphBundle(cwd);
	updateState(cwd, createBundleSnapshot(bundle));
}

export function validateBundlePromise(
	cwd: string,
	state: RalphLoopState,
	promise: "NEXT" | "COMPLETE",
): string | null {
	if (!state.bundle_mode) return null;
	try {
		const bundle = loadRalphBundle(cwd);
		if (promise === "NEXT") {
			return (
				evaluateNextGate(state.bundle_items_snapshot, bundle.items.items) ??
				evaluateBundleFileGate(bundle, state) ??
				evaluateVerificationGates(bundle)
			);
		}

		return (
			evaluateCompleteGate(state.bundle_items_snapshot, bundle.items.items) ??
			evaluateBundleCompleteFileGate(bundle, state) ??
			evaluateVerificationGates(bundle)
		);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
