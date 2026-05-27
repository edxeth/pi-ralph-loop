import { randomUUID } from "node:crypto";
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
			bundle_mode: data.bundle_mode === true,
			loop_token:
				typeof data.loop_token === "string" && data.loop_token.length > 0
					? data.loop_token
					: randomUUID(),
			bundle_snapshot_hash:
				typeof data.bundle_snapshot_hash === "string"
					? data.bundle_snapshot_hash
					: null,
			items_snapshot_hash:
				typeof data.items_snapshot_hash === "string"
					? data.items_snapshot_hash
					: null,
			progress_size:
				typeof data.progress_size === "number" ? data.progress_size : null,
			progress_hash:
				typeof data.progress_hash === "string" ? data.progress_hash : null,
			progress_snapshot:
				typeof data.progress_snapshot === "string"
					? data.progress_snapshot
					: null,
			source_doc_hashes:
				typeof data.source_doc_hashes === "string"
					? data.source_doc_hashes
					: null,
			bundle_items_snapshot:
				typeof data.bundle_items_snapshot === "string"
					? data.bundle_items_snapshot
					: null,
			git_head: typeof data.git_head === "string" ? data.git_head : null,
			bundle_rejection_count:
				typeof data.bundle_rejection_count === "number"
					? data.bundle_rejection_count
					: 0,
			limit_reminders:
				typeof data.limit_reminders === "string" ? data.limit_reminders : null,
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
		`bundle_mode: ${serializeValue(state.bundle_mode)}`,
		`loop_token: ${serializeValue(state.loop_token)}`,
		`bundle_snapshot_hash: ${serializeValue(state.bundle_snapshot_hash)}`,
		`items_snapshot_hash: ${serializeValue(state.items_snapshot_hash)}`,
		`progress_size: ${serializeValue(state.progress_size)}`,
		`progress_hash: ${serializeValue(state.progress_hash)}`,
		`progress_snapshot: ${serializeValue(state.progress_snapshot)}`,
		`source_doc_hashes: ${serializeValue(state.source_doc_hashes)}`,
		`bundle_items_snapshot: ${serializeValue(state.bundle_items_snapshot)}`,
		`git_head: ${serializeValue(state.git_head)}`,
		`bundle_rejection_count: ${serializeValue(state.bundle_rejection_count)}`,
		`limit_reminders: ${serializeValue(state.limit_reminders)}`,
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
