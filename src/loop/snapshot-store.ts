import type { RalphLoopState } from "../types.js";

// In-memory authority for pre-iteration bundle snapshots.
//
// Two lookups back one store: an exact (token, iteration) key for the snapshot
// taken at the start of the current iteration, and a (token) key for the latest
// snapshot regardless of iteration. The exact key wins; the latest is the
// fallback when an exact match is absent.
//
// This in-memory copy is authoritative over the snapshot persisted in loop.md:
// if the runtime file is restored from git mid-iteration, the persisted fields
// go stale, but the store still holds the true pre-iteration snapshot. The
// caller falls back to persisted state only when the store misses entirely
// (e.g. after a process restart).
const exactSnapshots = new Map<string, Partial<RalphLoopState>>();
const latestSnapshots = new Map<string, Partial<RalphLoopState>>();

function exactKey(cwd: string, state: RalphLoopState): string {
	return `${state.loop_token}:${state.iteration}:${cwd}`;
}

function latestKey(cwd: string, state: RalphLoopState): string {
	return `${state.loop_token}:${cwd}`;
}

export function recordSnapshot(
	cwd: string,
	state: RalphLoopState,
	snapshot: Partial<RalphLoopState>,
): void {
	exactSnapshots.set(exactKey(cwd, state), snapshot);
	latestSnapshots.set(latestKey(cwd, state), {
		...snapshot,
		iteration: state.iteration,
	});
}

export function getSnapshot(
	cwd: string,
	state: RalphLoopState,
): Partial<RalphLoopState> | undefined {
	return (
		exactSnapshots.get(exactKey(cwd, state)) ??
		latestSnapshots.get(latestKey(cwd, state))
	);
}
