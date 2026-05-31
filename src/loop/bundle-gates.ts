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
import { getSnapshot, recordSnapshot } from "./snapshot-store.js";

export function snapshotBundleIteration(
	cwd: string,
	state: RalphLoopState,
): void {
	const bundle = loadRalphBundle(cwd);
	const snapshot = createBundleSnapshot(bundle);
	recordSnapshot(cwd, state, snapshot);
	updateState(cwd, snapshot);
}

function getValidationSnapshot(
	cwd: string,
	state: RalphLoopState,
): RalphLoopState {
	const snapshot = getSnapshot(cwd, state);
	return snapshot ? { ...state, ...snapshot } : state;
}

export function validateBundlePromise(
	cwd: string,
	state: RalphLoopState,
	promise: "NEXT" | "COMPLETE",
): string | null {
	if (!state.bundle_mode) return null;
	try {
		const bundle = loadRalphBundle(cwd);
		const snapshot = getValidationSnapshot(cwd, state);
		if (promise === "NEXT") {
			return (
				evaluateNextGate(snapshot.bundle_items_snapshot, bundle.items.items) ??
				evaluateBundleFileGate(bundle, snapshot) ??
				evaluateVerificationGates(bundle)
			);
		}

		return (
			evaluateCompleteGate(
				snapshot.bundle_items_snapshot,
				bundle.items.items,
			) ??
			evaluateBundleCompleteFileGate(bundle, snapshot) ??
			evaluateVerificationGates(bundle)
		);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
