/** Stop reasons for the Ralph loop */
type StopReason =
	| "complete" // <promise>COMPLETE</promise> detected
	| "max_iterations" // Reached max_iterations limit
	| "user_cancelled" // User pressed Ctrl+C / session_shutdown
	| "error" // Unrecoverable provider error (after retries)
	| "manual_stop"; // /ralph-stop command

/** State persisted in .ralph/loop.md frontmatter */
export interface RalphLoopState {
	running: boolean;
	iteration: number;
	max_iterations: number;
	started_at: string;
	completed_at: string | null;
	stop_reason: StopReason | null;
	session_id: string;
	last_session_file: string | null;
	error_count: number;
	transitioning: boolean;
	cancel_requested: boolean;
	stop_requested: boolean;
	bundle_mode: boolean;
	loop_token: string;
	bundle_snapshot_hash: string | null;
	items_snapshot_hash: string | null;
	progress_size: number | null;
	progress_hash: string | null;
	source_doc_hashes: string | null;
}

/** Parsed arguments from /ralph-loop command */
export interface ParsedArgs {
	task: string;
	maxIterations: number;
}

/** Options for starting or resuming a Ralph loop run */
export interface RunLoopOptions {
	startIteration?: number;
	startedAt?: string;
	initialErrorCount?: number;
	reuseCurrentSession?: boolean;
	bundleMode?: boolean;
}
