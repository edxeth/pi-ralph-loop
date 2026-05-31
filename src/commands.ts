import { readFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { loadRalphBundle } from "./bundle/index.js";
import { resumeCurrentSession, runLoop } from "./loop-engine.js";
import { parseArgs } from "./parser.js";
import { getTaskBody, readState, updateState } from "./state.js";

const MAX_ITERATION_SUGGESTIONS = [5, 10, 20, 50, 100] as const;
const MS_PER_SECOND = 1000;

type SavedLoop = {
	state: NonNullable<ReturnType<typeof readState>>;
	task: string;
};

function parseResumeArgs(args: string): { force: boolean } | null {
	const trimmed = args.trim();
	if (!trimmed) return { force: false };
	if (trimmed === "--force") return { force: true };
	return null;
}

function isLoopRunning(cwd: string): boolean {
	return readState(cwd)?.running === true;
}

function notifyLoopAlreadyRunning(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("A Ralph loop is already running", "error");
}

function ensureLoopNotRunning(ctx: ExtensionCommandContext): boolean {
	if (!isLoopRunning(ctx.cwd)) return true;
	notifyLoopAlreadyRunning(ctx);
	return false;
}

function normalizeBundlePromptReference(task: string): string | null {
	const trimmed = task.trim();
	if (!trimmed.startsWith("@")) return null;

	const reference = trimmed.slice(1);
	const normalized = path.posix.normalize(reference.replaceAll("\\", "/"));
	return normalized === ".ralph/prompt.md" ? normalized : null;
}

function getLoopArgumentCompletions(prefix: string) {
	if (prefix.includes("--max-iterations")) return null;

	const items = MAX_ITERATION_SUGGESTIONS.map(
		(value) => `--max-iterations=${value}`,
	)
		.filter((value) => value.startsWith(prefix) || !prefix)
		.map((value) => ({ value, label: value }));

	return items.length > 0 ? items : null;
}

function readSavedLoop(cwd: string): SavedLoop | null {
	const state = readState(cwd);
	const task = getTaskBody(cwd);
	if (!state || !task) return null;
	return { state, task };
}

function formatResumeNotification(
	state: SavedLoop["state"],
	reuseCurrentSession: boolean,
): string {
	return reuseCurrentSession
		? `Resuming Ralph loop in current session from iteration ${state.iteration}/${state.max_iterations}`
		: `Resuming Ralph loop from iteration ${state.iteration}/${state.max_iterations} in a fresh session`;
}

function formatStatusMessage(state: SavedLoop["state"]): string {
	const elapsed = state.started_at
		? Math.round(
				(Date.now() - new Date(state.started_at).getTime()) / MS_PER_SECOND,
			)
		: 0;

	return [
		`Ralph loop: iteration ${state.iteration}/${state.max_iterations}`,
		`   Started: ${state.started_at}`,
		`   Elapsed: ${elapsed}s`,
		`   Errors: ${state.error_count}`,
		`   Session: ${state.session_id || "unknown"}`,
		`   Transitioning: ${state.transitioning ? "yes" : "no"}`,
	].join("\n");
}

async function handleLoopCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureLoopNotRunning(ctx)) return;

	const parsed = parseArgs(args);
	if (!parsed) {
		ctx.ui.notify(
			'Usage: /ralph-loop "task text" [--max-iterations=N]',
			"error",
		);
		return;
	}

	let task = parsed.task;
	const bundleMode = normalizeBundlePromptReference(task) !== null;
	if (bundleMode) {
		try {
			const bundle = loadRalphBundle(ctx.cwd);
			task = readFileSync(bundle.files[".ralph/prompt.md"], "utf8");
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
	}

	await runLoop(pi, ctx, task, parsed.maxIterations, { bundleMode });
}

async function handleResumeCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureLoopNotRunning(ctx)) return;

	const parsedArgs = parseResumeArgs(args);
	if (!parsedArgs) {
		ctx.ui.notify("Usage: /ralph-resume [--force]", "error");
		return;
	}

	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop) {
		ctx.ui.notify(
			"No resumable Ralph loop state found in .ralph/loop.md",
			"error",
		);
		return;
	}

	const { state, task } = savedLoop;
	if (state.iteration <= 0 || state.max_iterations <= 0) {
		ctx.ui.notify("Ralph loop state is invalid and cannot be resumed", "error");
		return;
	}

	if (state.stop_reason === "complete" && !parsedArgs.force) {
		ctx.ui.notify(
			"Ralph loop already completed; use /ralph-resume --force or /ralph-restart",
			"info",
		);
		return;
	}

	if (state.iteration > state.max_iterations) {
		ctx.ui.notify(
			"Saved Ralph loop is already past max iterations and cannot be resumed",
			"error",
		);
		return;
	}

	const currentSessionId = ctx.sessionManager.getSessionId();
	const reuseCurrentSession =
		Boolean(state.session_id) && currentSessionId === state.session_id;
	ctx.ui.notify(formatResumeNotification(state, reuseCurrentSession), "info");

	if (reuseCurrentSession) {
		await resumeCurrentSession(pi, ctx);
		return;
	}

	await runLoop(pi, ctx, task, state.max_iterations, {
		startIteration: state.iteration,
		startedAt: state.started_at || new Date().toISOString(),
		initialErrorCount: state.error_count,
		bundleMode: state.bundle_mode,
	});
}

async function handleRestartCommand(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureLoopNotRunning(ctx)) return;

	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop) {
		ctx.ui.notify(
			"No restartable Ralph loop state found in .ralph/loop.md",
			"error",
		);
		return;
	}

	const { state, task } = savedLoop;
	if (state.max_iterations <= 0) {
		ctx.ui.notify(
			"Ralph loop state is invalid and cannot be restarted",
			"error",
		);
		return;
	}

	ctx.ui.notify(
		`Restarting Ralph loop from iteration 1/${state.max_iterations} in a fresh session`,
		"info",
	);
	await runLoop(pi, ctx, task, state.max_iterations, {
		startIteration: 1,
		startedAt: new Date().toISOString(),
		initialErrorCount: 0,
		bundleMode: state.bundle_mode,
	});
}

function handleStopCommand(
	_pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isLoopRunning(ctx.cwd)) {
		ctx.ui.notify("No Ralph loop is running", "info");
		return Promise.resolve();
	}

	updateState(ctx.cwd, { stop_requested: true });
	ctx.ui.notify("Ralph loop will stop after the current iteration", "info");
	return Promise.resolve();
}

function handleStatusCommand(
	_pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop?.state.running) {
		if (savedLoop?.state.stop_reason) {
			ctx.ui.notify(
				`Ralph loop (inactive): last run stopped at iteration ${savedLoop.state.iteration}/${savedLoop.state.max_iterations}, reason: ${savedLoop.state.stop_reason}`,
				"info",
			);
		} else {
			ctx.ui.notify("No active Ralph loop", "info");
		}
		return Promise.resolve();
	}

	ctx.ui.notify(formatStatusMessage(savedLoop.state), "info");
	return Promise.resolve();
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ralph-loop", {
		description:
			'Start a Ralph loop — run a task iteratively in fresh sessions until <promise>COMPLETE</promise> or max iterations. Usage: /ralph-loop "task" [--max-iterations=N]',
		getArgumentCompletions: getLoopArgumentCompletions,
		handler: handleLoopCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-resume", {
		description:
			"Resume a saved Ralph loop from .ralph/loop.md. Completed loops require --force. From the session that owns the saved iteration, it resumes in place without re-sending the prompt (acting on an already-emitted promise or nudging continue); from any other session, it restarts the saved iteration in a fresh session.",
		handler: handleResumeCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-restart", {
		description:
			"Restart the saved Ralph loop from iteration 1 in a fresh session, reusing the prompt and max_iterations from .ralph/loop.md.",
		handler: handleRestartCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-stop", {
		description:
			"Stop the currently running Ralph loop after the current iteration",
		handler: handleStopCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-status", {
		description: "Show the current Ralph loop status",
		handler: handleStatusCommand.bind(null, pi),
	});
}
