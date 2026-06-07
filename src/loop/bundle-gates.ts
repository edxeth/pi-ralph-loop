import {
	createBundleSnapshot,
	evaluateBundleCompleteFileGate,
	evaluateBundleFileGate,
	evaluateCompleteGate,
	evaluateNextGate,
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
		// verification_gates are intentionally NOT executed here. They stay in
		// items.json as instructions surfaced to the agent, which runs them during
		// its iteration before emitting a promise. Ralph does not re-run them at
		// promise emission: re-running a heavy gate (e.g. a full test suite) froze
		// the loop and duplicated work the agent already did. Item, progress, and
		// commit gates below are cheap and still enforced.
		if (promise === "NEXT") {
			return (
				evaluateNextGate(snapshot.bundle_items_snapshot, bundle.items.items) ??
				evaluateBundleFileGate(bundle, snapshot)
			);
		}

		return (
			evaluateCompleteGate(
				snapshot.bundle_items_snapshot,
				bundle.items.items,
			) ?? evaluateBundleCompleteFileGate(bundle, snapshot)
		);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
