// Provider-error wait generation counter.
//
// A provider-error turn arms a wait that captures the current generation; any
// later agent_end or loop finalization supersedes it by bumping the generation.
// A wait fires its effect only while its generation is still current, i.e. Pi
// stayed silent for the whole window and retries are genuinely exhausted.
//
// The counter is module-level because there is one active loop per process and
// the wait is only ever touched within a single session. It resets each fresh
// iteration via supersede(), matching the prior per-iteration reset.
let generation = 0;

/**
 * Arm a new wait and return its generation token. Supersedes any prior wait.
 */
export function armProviderWait(): number {
	return ++generation;
}

/**
 * Supersede any pending wait without arming a new one (e.g. on a fresh
 * agent_end turn or loop finalization).
 */
export function supersedeProviderWait(): void {
	generation++;
}

/**
 * Whether the wait identified by `token` is still the current one. A superseded
 * wait returns false and should take no action.
 */
export function isProviderWaitCurrent(token: number): boolean {
	return token === generation;
}
