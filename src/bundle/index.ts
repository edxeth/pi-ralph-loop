import { readFileSync, realpathSync } from "node:fs";

import { validateRequiredFile } from "./paths.js";
import { parseBundleItemsJson } from "./schema.js";
import { type RalphBundle, REQUIRED_BUNDLE_FILES } from "./types.js";

export {
	evaluateBundleCompleteFileGate,
	evaluateBundleFileGate,
} from "./file-gates.js";
export { evaluateCompleteGate, evaluateNextGate } from "./item-gates.js";
export { parseBundleItemsJson } from "./schema.js";
export { createBundleSnapshot } from "./snapshot.js";
export { evaluateVerificationGates } from "./verification-gates.js";

export function loadRalphBundle(workspaceRoot: string): RalphBundle {
	const root = realpathSync(workspaceRoot);
	const files = Object.fromEntries(
		REQUIRED_BUNDLE_FILES.map((file) => [
			file,
			validateRequiredFile(root, file),
		]),
	) as RalphBundle["files"];
	const items = parseBundleItemsJson(
		readFileSync(files[".ralph/items.json"], "utf8"),
	);
	return { root, files, items };
}
