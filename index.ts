/**
 * pi-ralph-loop — Ralph Wiggum loop extension for pi
 *
 * Implements iterative task execution with fresh context windows per iteration.
 * The loop sends the same task prompt in a new session each iteration, checking
 * for <promise>COMPLETE</promise> to know when the task is done.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerCommands } from "./commands.js";
import { registerEventHandlers } from "./events.js";

export default function ralphLoopExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerEventHandlers(pi);
}
