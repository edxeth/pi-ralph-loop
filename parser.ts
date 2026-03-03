import type { ParsedArgs } from "./types.js";

/** Default maximum iterations if not specified */
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Parse the /ralph-loop command arguments.
 *
 * Accepted formats:
 *   /ralph-loop "task text" --max-iterations=10
 *   /ralph-loop "task text" --max-iterations 10
 *   /ralph-loop "task text"                       (defaults to 100)
 *   /ralph-loop task text without quotes --max-iterations=5
 *
 * @returns ParsedArgs or null if parsing fails (empty task)
 */
export function parseArgs(raw: string): ParsedArgs | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let taskPart = trimmed;

  // Extract --max-iterations=N or --max-iterations N
  const eqPattern = /--max-iterations=(\d+)/i;
  const spacePattern = /--max-iterations\s+(\d+)/i;

  const eqMatch = taskPart.match(eqPattern);
  if (eqMatch) {
    maxIterations = parseInt(eqMatch[1], 10);
    taskPart = taskPart.replace(eqPattern, "").trim();
  } else {
    const spaceMatch = taskPart.match(spacePattern);
    if (spaceMatch) {
      maxIterations = parseInt(spaceMatch[1], 10);
      taskPart = taskPart.replace(spacePattern, "").trim();
    }
  }

  // Strip surrounding quotes from the task if present
  if (
    (taskPart.startsWith('"') && taskPart.endsWith('"')) ||
    (taskPart.startsWith("'") && taskPart.endsWith("'"))
  ) {
    taskPart = taskPart.slice(1, -1);
  }

  taskPart = taskPart.trim();
  if (!taskPart) return null;

  if (maxIterations <= 0 || !Number.isFinite(maxIterations)) return null;

  return { task: taskPart, maxIterations };
}
