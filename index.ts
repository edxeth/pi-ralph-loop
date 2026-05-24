/**
 * pi-ralph-loop — Ralph Wiggum loop extension for pi
 *
 * Implements iterative task execution with fresh context windows per iteration.
 * The loop sends the same task prompt in a new session each iteration, checking
 * for <promise>COMPLETE</promise> to know when the task is done.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerCommands } from "./commands.js";
import { registerEventHandlers } from "./events.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

function registerBundledResources(pi: ExtensionAPI): void {
	pi.on("resources_discover", async () => ({
		skillPaths: [join(extensionDir, "skills")],
	}));
}

export default function ralphLoopExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerEventHandlers(pi);
	registerBundledResources(pi);
}
