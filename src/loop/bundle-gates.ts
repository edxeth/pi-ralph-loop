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

const liveSnapshots = new Map<string, Partial<RalphLoopState>>();
const latestSnapshots = new Map<string, Partial<RalphLoopState>>();

function snapshotKey(cwd: string, state: RalphLoopState): string {
	return `${state.loop_token}:${state.iteration}:${cwd}`;
}

function latestSnapshotKey(cwd: string, state: RalphLoopState): string {
	return `${state.loop_token}:${cwd}`;
}

export function snapshotBundleIteration(
	cwd: string,
	state: RalphLoopState,
): void {
	const bundle = loadRalphBundle(cwd);
	const snapshot = createBundleSnapshot(bundle);
	liveSnapshots.set(snapshotKey(cwd, state), snapshot);
	latestSnapshots.set(latestSnapshotKey(cwd, state), {
		...snapshot,
		iteration: state.iteration,
	});
	updateState(cwd, snapshot);
}

function getValidationSnapshot(
	cwd: string,
	state: RalphLoopState,
): RalphLoopState {
	const snapshot =
		liveSnapshots.get(snapshotKey(cwd, state)) ??
		latestSnapshots.get(latestSnapshotKey(cwd, state));
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
			evaluateCompleteGate(snapshot.bundle_items_snapshot, bundle.items.items) ??
			evaluateBundleCompleteFileGate(bundle, snapshot) ??
			evaluateVerificationGates(bundle)
		);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
