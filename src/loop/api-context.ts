import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Stored on globalThis because pi reloads extension modules on newSession().
// Fresh sessions get a fresh ExtensionAPI, and replacement callbacks must use
// that post-replacement API rather than a captured pre-replacement `pi` object.
const API_KEY = "__ralph_loop_extension_api__";

export function getLoopApi(): ExtensionAPI | null {
	return (
		((globalThis as Record<string, unknown>)[API_KEY] as ExtensionAPI | null) ??
		null
	);
}

export function setLoopApi(pi: ExtensionAPI): void {
	(globalThis as Record<string, unknown>)[API_KEY] = pi;
}
