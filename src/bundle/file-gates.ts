import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { hashSourceDocs, readGitHead, resolveGitRoot } from "./snapshot.js";
import type {
	BundleFileGateSnapshot,
	CommitPolicy,
	RalphBundle,
	RuntimeContract,
} from "./types.js";

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

function getCommitPolicy(contract: RuntimeContract | undefined): CommitPolicy {
	if (contract?.commit_policy) return contract.commit_policy;
	const legacyContract = contract as
		| { require_one_commit_per_iteration?: boolean }
		| undefined;
	return legacyContract?.require_one_commit_per_iteration === true
		? "exactly_one"
		: "optional";
}

function countIterationCommits(
	root: string,
	beforeHead: string | null,
	afterHead: string | null,
): number | null {
	if (afterHead === null) return beforeHead === null ? 0 : null;

	try {
		const count =
			beforeHead === null
				? execFileSync("git", ["rev-list", "--count", afterHead], {
						cwd: root,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}).trim()
				: execFileSync(
						"git",
						["rev-list", "--count", `${beforeHead}..${afterHead}`],
						{
							cwd: root,
							encoding: "utf8",
							stdio: ["ignore", "pipe", "ignore"],
						},
					).trim();
		return Number.parseInt(count, 10);
	} catch {
		return null;
	}
}

function evaluateCommitPolicy(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	const policy = getCommitPolicy(bundle.items.runtime_contract);
	if (policy === "optional") return null;
	if (snapshot.git_head === undefined)
		return "missing pre-iteration git HEAD snapshot";

	const gitRoot = resolveGitRoot(bundle.root, bundle.items.runtime_contract);
	const currentHead = readGitHead(gitRoot);
	const commitCount = countIterationCommits(
		gitRoot,
		snapshot.git_head,
		currentHead,
	);
	if (commitCount === null || Number.isNaN(commitCount)) {
		return `could not verify commit policy ${policy} for this iteration`;
	}

	const relativeGitRoot = path.relative(bundle.root, gitRoot) || ".";
	if (policy === "none" && commitCount !== 0) {
		return `no commits are allowed in ${relativeGitRoot} for this iteration; observed ${commitCount}`;
	}
	if (policy === "exactly_one" && commitCount !== 1) {
		return `exactly one commit must be created in ${relativeGitRoot} for this iteration; observed ${commitCount}`;
	}
	if (policy === "at_least_one" && commitCount < 1) {
		return `at least one commit must be created in ${relativeGitRoot} for this iteration; observed ${commitCount}`;
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
		evaluateCommitPolicy(bundle, snapshot)
	);
}

export function evaluateBundleCompleteFileGate(
	bundle: RalphBundle,
	snapshot: BundleFileGateSnapshot,
): string | null {
	return (
		evaluateSourceDocs(bundle, snapshot) ??
		evaluateCommitPolicy(bundle, snapshot)
	);
}
