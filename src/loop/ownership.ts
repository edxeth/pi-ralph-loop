import { existsSync, statSync } from "node:fs";

import { readState, updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";

export const LOOP_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
export const LOOP_OWNER_STALE_AFTER_MS = 60_000;
export const LEGACY_SESSION_STALE_AFTER_MS = 30 * 60_000;

const heartbeatTimers = new Map<string, NodeJS.Timeout>();

export function getLoopOwnerFields(): Pick<
	RalphLoopState,
	"owner_pid" | "owner_heartbeat_at"
> {
	return {
		owner_pid: process.pid,
		owner_heartbeat_at: new Date().toISOString(),
	};
}

export function startLoopHeartbeat(cwd: string, loopToken: string): void {
	stopLoopHeartbeat(cwd);

	const timer = setInterval(() => {
		const state = readState(cwd);
		if (
			!state?.running ||
			state.loop_token !== loopToken ||
			state.owner_pid !== process.pid
		) {
			stopLoopHeartbeat(cwd);
			return;
		}

		updateState(cwd, { owner_heartbeat_at: new Date().toISOString() });
	}, LOOP_OWNER_HEARTBEAT_INTERVAL_MS);
	timer.unref?.();
	heartbeatTimers.set(cwd, timer);
}

export function claimLoopOwnership(cwd: string): void {
	const state = readState(cwd);
	if (!state?.running) return;

	updateState(cwd, getLoopOwnerFields());
	startLoopHeartbeat(cwd, state.loop_token);
}

export function stopLoopHeartbeat(cwd: string): void {
	const timer = heartbeatTimers.get(cwd);
	if (!timer) return;

	clearInterval(timer);
	heartbeatTimers.delete(cwd);
}

function isFreshTimestamp(timestamp: string | null, maxAgeMs: number): boolean {
	if (!timestamp) return false;

	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return false;

	return Date.now() - parsed < maxAgeMs;
}

function isFreshSessionFile(path: string | null): boolean {
	if (!path || !existsSync(path)) return false;

	try {
		return Date.now() - statSync(path).mtimeMs < LEGACY_SESSION_STALE_AFTER_MS;
	} catch {
		return false;
	}
}

export function isLoopOwnerActive(
	state: RalphLoopState,
	currentSessionId: string,
): boolean {
	if (state.owner_pid !== null || state.owner_heartbeat_at !== null) {
		return isFreshTimestamp(
			state.owner_heartbeat_at,
			LOOP_OWNER_STALE_AFTER_MS,
		);
	}

	// Older loop.md files did not have owner heartbeats. When a different Pi
	// session starts in the same workspace, the best durable liveness signal is
	// whether the saved active session file is still being appended. If startup is
	// for the saved session itself, keep the old crash-recovery behavior instead
	// of treating its own recent session file as proof of another live owner.
	return (
		state.session_id !== currentSessionId &&
		isFreshSessionFile(state.last_session_file)
	);
}
