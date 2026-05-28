import { readFileSync, statSync } from "node:fs";

import { hashSourceDocs, readGitHead } from "./snapshot.js";
import type { BundleFileGateSnapshot, RalphBundle } from "./types.js";

function evaluateProgressAppend(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	if (bundle.items.runtime_contract?.require_progress_append !== true)
		return null;
	if (snapshot.progress_size === null || snapshot.progress_snapshot === null) {
		return "missing pre-iteration progress snapshot";
	}

	const previous = Buffer.from(snapshot.progress_snapshot, "base64").toString(
		"utf8",
	);
	const current = readFileSync(bundle.files[".ralph/progress.md"], "utf8");
	const currentSize = statSync(bundle.files[".ralph/progress.md"]).size;
	if (currentSize <= snapshot.progress_size) {
		return ".ralph/progress.md must grow by appending progress for this iteration";
	}
	if (!current.startsWith(previous)) {
		return ".ralph/progress.md must retain its previous content as an exact prefix";
	}
	return null;
}

function evaluateSourceDocs(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	if (bundle.items.runtime_contract?.require_clean_source_docs !== true)
		return null;
	if (snapshot.source_doc_hashes === null)
		return "missing pre-iteration source document snapshot";

	let previous: Record<string, string>;
	try {
		previous = JSON.parse(snapshot.source_doc_hashes) as Record<string, string>;
	} catch {
		return "invalid pre-iteration source document snapshot";
	}

	const current = hashSourceDocs(
		bundle.root,
		bundle.items.runtime_contract?.source_docs,
	);
	for (const [sourceDoc, previousHash] of Object.entries(previous)) {
		if (current[sourceDoc] !== previousHash) {
			return `${sourceDoc} changed during the iteration`;
		}
	}
	return null;
}

function evaluateCommitRequirement(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	if (bundle.items.runtime_contract?.require_commit !== true) return null;
	if (snapshot.git_head === undefined) {
		return "missing pre-iteration git HEAD snapshot";
	}

	const currentHead = readGitHead(bundle.root);
	if (currentHead === snapshot.git_head) {
		return "at least one commit must be created in the Ralph workspace root for this iteration";
	}

	return null;
}

export function evaluateBundleFileGate(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	return (
		evaluateProgressAppend(bundle, snapshot) ??
		evaluateSourceDocs(bundle, snapshot) ??
		evaluateCommitRequirement(bundle, snapshot)
	);
}

export function evaluateBundleCompleteFileGate(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	return (
		evaluateSourceDocs(bundle, snapshot) ??
		evaluateCommitRequirement(bundle, snapshot)
	);
}
