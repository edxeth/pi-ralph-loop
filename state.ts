import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RalphLoopState } from "./types.js";

/** Relative path to the state file from project root */
const STATE_FILE = join(".ralph", "loop.md");

/**
 * Serialize a frontmatter value to its YAML representation.
 */
function serializeValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	return `"${String(value)}"`;
}

/**
 * Parse a YAML frontmatter value string into a typed value.
 */
function parseValue(raw: string): string | number | boolean | null {
	const trimmed = raw.trim();
	if (trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
	// Strip surrounding quotes
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Read and parse the Ralph loop state file.
 *
 * @param cwd - Project working directory
 * @returns Parsed state or null if file doesn't exist or is malformed
 */
export function readState(cwd: string): RalphLoopState | null {
	const filePath = join(cwd, STATE_FILE);
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf-8");
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) return null;

		const frontmatter = frontmatterMatch[1];
		const data: Record<string, unknown> = {};

		for (const line of frontmatter.split("\n")) {
			const colonIndex = line.indexOf(":");
			if (colonIndex === -1) continue;
			const key = line.slice(0, colonIndex).trim();
			const value = line.slice(colonIndex + 1).trim();
			data[key] = parseValue(value);
		}

		return {
			running: data.running === true,
			iteration: typeof data.iteration === "number" ? data.iteration : 0,
			max_iterations:
				typeof data.max_iterations === "number" ? data.max_iterations : 0,
			started_at: typeof data.started_at === "string" ? data.started_at : "",
			completed_at:
				typeof data.completed_at === "string" ? data.completed_at : null,
			stop_reason:
				typeof data.stop_reason === "string"
					? (data.stop_reason as RalphLoopState["stop_reason"])
					: null,
			session_id: typeof data.session_id === "string" ? data.session_id : "",
			last_session_file:
				typeof data.last_session_file === "string"
					? data.last_session_file
					: null,
			error_count: typeof data.error_count === "number" ? data.error_count : 0,
			transitioning: data.transitioning === true,
			cancel_requested: data.cancel_requested === true,
			stop_requested: data.stop_requested === true,
		};
	} catch {
		return null;
	}
}

/**
 * Write the full state file with frontmatter and task body.
 *
 * @param cwd - Project working directory
 * @param state - Loop state to write
 * @param taskBody - The raw task prompt (body after frontmatter)
 */
export function writeState(
	cwd: string,
	state: RalphLoopState,
	taskBody: string,
): void {
	const dirPath = join(cwd, ".ralph");
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}

	const frontmatter = [
		"---",
		`running: ${serializeValue(state.running)}`,
		`iteration: ${serializeValue(state.iteration)}`,
		`max_iterations: ${serializeValue(state.max_iterations)}`,
		`started_at: ${serializeValue(state.started_at)}`,
		`completed_at: ${serializeValue(state.completed_at)}`,
		`stop_reason: ${serializeValue(state.stop_reason)}`,
		`session_id: ${serializeValue(state.session_id)}`,
		`last_session_file: ${serializeValue(state.last_session_file)}`,
		`error_count: ${serializeValue(state.error_count)}`,
		`transitioning: ${serializeValue(state.transitioning)}`,
		`cancel_requested: ${serializeValue(state.cancel_requested)}`,
		`stop_requested: ${serializeValue(state.stop_requested)}`,
		"---",
	].join("\n");

	const content = `${frontmatter}\n\n${taskBody}\n`;
	writeFileSync(join(cwd, STATE_FILE), content, "utf-8");
}

/**
 * Read, merge partial updates, and write back the state file.
 * Preserves the task body.
 *
 * @param cwd - Project working directory
 * @param updates - Partial state fields to merge
 */
export function updateState(
	cwd: string,
	updates: Partial<RalphLoopState>,
): void {
	const current = readState(cwd);
	if (!current) return;

	const body = getTaskBody(cwd) ?? "";
	const merged = { ...current, ...updates };
	writeState(cwd, merged, body);
}

/**
 * Read just the task body (after frontmatter) from the state file.
 *
 * @param cwd - Project working directory
 * @returns The task body text or null if file doesn't exist
 */
export function getTaskBody(cwd: string): string | null {
	const filePath = join(cwd, STATE_FILE);
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf-8");
		const endOfFrontmatter = content.indexOf("---", 3);
		if (endOfFrontmatter === -1) return null;

		return content.slice(endOfFrontmatter + 3).trim();
	} catch {
		return null;
	}
}
