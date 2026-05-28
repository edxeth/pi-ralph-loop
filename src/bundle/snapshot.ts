import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";

import { resolveWorkspacePath } from "./paths.js";
import type { BundleItem, BundleSnapshot, RalphBundle } from "./types.js";

function fail(message: string): never {
	throw new Error(`Invalid Ralph bundle: ${message}`);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hashJson(value: unknown): string {
	return hashText(JSON.stringify(value));
}

function snapshotItems(items: BundleItem[]): Array<{
	category: string;
	description: string;
	steps: string[];
	passes: boolean;
}> {
	return items.map((item) => ({
		category: item.category,
		description: item.description,
		steps: item.steps,
		passes: item.passes,
	}));
}

export function readGitHead(root: string): string | null {
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || null
		);
	} catch {
		return null;
	}
}

export function hashSourceDocs(
	root: string,
	sourceDocs: string[] | undefined,
): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const sourceDoc of sourceDocs ?? []) {
		const resolved = resolveWorkspacePath(root, sourceDoc);
		let realPath: string;
		try {
			realPath = realpathSync(resolved);
			accessSync(realPath, constants.R_OK);
		} catch {
			fail(`${sourceDoc} is unreadable`);
		}
		const relative = path.relative(root, realPath);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			fail(`${sourceDoc} resolves outside the workspace`);
		}
		hashes[sourceDoc] = hashText(readFileSync(realPath, "utf8"));
	}
	return hashes;
}

export function createBundleSnapshot(bundle: RalphBundle): BundleSnapshot {
	const progress = readFileSync(bundle.files[".ralph/progress.md"], "utf8");
	const immutableItems = snapshotItems(bundle.items.items);
	const sourceHashes = hashSourceDocs(
		bundle.root,
		bundle.items.runtime_contract?.source_docs,
	);
	const gitHead = readGitHead(bundle.root);
	const progressSize = statSync(bundle.files[".ralph/progress.md"]).size;

	return {
		bundle_snapshot_hash: hashJson({
			immutableItems,
			progressSize,
			sourceHashes,
			gitHead,
		}),
		items_snapshot_hash: hashJson(immutableItems),
		progress_size: progressSize,
		progress_hash: hashText(progress),
		progress_snapshot: Buffer.from(progress, "utf8").toString("base64"),
		source_doc_hashes: JSON.stringify(sourceHashes),
		bundle_items_snapshot: JSON.stringify(immutableItems),
		git_head: gitHead,
	};
}
