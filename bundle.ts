import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const REQUIRED_BUNDLE_FILES = [
	".ralph/plan.md",
	".ralph/items.json",
	".ralph/prompt.md",
	".ralph/progress.md",
] as const;

export type BundleItem = {
	category: string;
	description: string;
	steps: string[];
	passes: boolean;
	regression_notes: string;
	[key: string]: unknown;
};

export type VerificationGate = {
	name: string;
	command: string;
};

export type RuntimeContract = {
	source_docs?: string[];
	verification_gates?: VerificationGate[];
	require_progress_append?: boolean;
	require_one_item_per_iteration?: boolean;
	require_clean_source_docs?: boolean;
	require_one_commit_per_iteration?: boolean;
};

export type BundleItemsFile = {
	version: 1;
	items: BundleItem[];
	runtime_contract?: RuntimeContract;
	[key: string]: unknown;
};

export type RalphBundle = {
	root: string;
	files: Record<(typeof REQUIRED_BUNDLE_FILES)[number], string>;
	items: BundleItemsFile;
};

export type BundleSnapshot = {
	bundle_snapshot_hash: string;
	items_snapshot_hash: string;
	progress_size: number;
	progress_hash: string;
	source_doc_hashes: string;
};

function fail(message: string): never {
	throw new Error(`Invalid Ralph bundle: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspacePath(root: string, relativePath: string): string {
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		fail(`${relativePath} escapes the workspace`);
	}
	return resolved;
}

function validateRequiredFile(root: string, relativePath: string): string {
	const resolved = resolveWorkspacePath(root, relativePath);
	let stat;
	try {
		stat = lstatSync(resolved);
	} catch {
		fail(`${relativePath} is missing`);
	}

	if (stat.isSymbolicLink()) fail(`${relativePath} must not be a symlink`);
	if (!stat.isFile()) fail(`${relativePath} is not a file`);

	let realPath: string;
	try {
		realPath = realpathSync(resolved);
		accessSync(realPath, constants.R_OK);
	} catch {
		fail(`${relativePath} is unreadable`);
	}

	const relative = path.relative(root, realPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		fail(`${relativePath} resolves outside the workspace`);
	}

	return realPath;
}

function validateRuntimeContract(value: unknown): RuntimeContract {
	if (value === undefined) return {};
	if (!isRecord(value)) fail("runtime_contract must be an object");

	const contract: RuntimeContract = {};
	if (value.source_docs !== undefined) {
		if (
			!Array.isArray(value.source_docs) ||
			!value.source_docs.every((entry) => typeof entry === "string" && entry)
		) {
			fail("runtime_contract.source_docs must be a string array");
		}
		contract.source_docs = value.source_docs;
	}

	if (value.verification_gates !== undefined) {
		if (!Array.isArray(value.verification_gates)) {
			fail("runtime_contract.verification_gates must be an array");
		}
		contract.verification_gates = value.verification_gates.map((gate) => {
			if (!isRecord(gate)) {
				fail("runtime_contract.verification_gates entries must be objects");
			}
			if (typeof gate.name !== "string" || !gate.name) {
				fail("runtime_contract.verification_gates entries need a name");
			}
			if (typeof gate.command !== "string" || !gate.command) {
				fail("runtime_contract.verification_gates entries need a command");
			}
			return { name: gate.name, command: gate.command };
		});
	}

	for (const key of [
		"require_progress_append",
		"require_one_item_per_iteration",
		"require_clean_source_docs",
		"require_one_commit_per_iteration",
	] as const) {
		if (value[key] !== undefined) {
			if (typeof value[key] !== "boolean") fail(`runtime_contract.${key} must be boolean`);
			contract[key] = value[key];
		}
	}

	return contract;
}

export function parseBundleItemsJson(raw: string): BundleItemsFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		fail("items.json is malformed JSON");
	}

	if (!isRecord(parsed)) fail("items.json must be an object");
	if (parsed.version !== 1) fail("items.json version must be 1");
	if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
		fail("items.json items must be a non-empty array");
	}

	const items = parsed.items.map((item, index): BundleItem => {
		if (!isRecord(item)) fail(`items[${index}] must be an object`);
		if (typeof item.category !== "string" || !item.category) {
			fail(`items[${index}].category must be a non-empty string`);
		}
		if (typeof item.description !== "string" || !item.description) {
			fail(`items[${index}].description must be a non-empty string`);
		}
		if (!Array.isArray(item.steps) || item.steps.length === 0 || !item.steps.every((step) => typeof step === "string" && step)) {
			fail(`items[${index}].steps must be a non-empty string array`);
		}
		if (typeof item.passes !== "boolean") fail(`items[${index}].passes must be boolean`);
		if (typeof item.regression_notes !== "string") {
			fail(`items[${index}].regression_notes must be string`);
		}
		return item as BundleItem;
	});

	return {
		...parsed,
		version: 1,
		items,
		runtime_contract: validateRuntimeContract(parsed.runtime_contract),
	};
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hashJson(value: unknown): string {
	return hashText(JSON.stringify(value));
}

function readGitHead(root: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || null;
	} catch {
		return null;
	}
}

function hashSourceDocs(root: string, sourceDocs: string[] | undefined): Record<string, string> {
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
	const immutableItems = bundle.items.items.map((item) => ({
		category: item.category,
		description: item.description,
		steps: item.steps,
		passes: item.passes,
	}));
	const sourceHashes = hashSourceDocs(bundle.root, bundle.items.runtime_contract?.source_docs);
	const gitHead = readGitHead(bundle.root);
	const progressSize = statSync(bundle.files[".ralph/progress.md"]).size;

	return {
		bundle_snapshot_hash: hashJson({ immutableItems, progressSize, sourceHashes, gitHead }),
		items_snapshot_hash: hashJson(immutableItems),
		progress_size: progressSize,
		progress_hash: hashText(progress),
		source_doc_hashes: JSON.stringify(sourceHashes),
	};
}

export function loadRalphBundle(workspaceRoot: string): RalphBundle {
	const root = realpathSync(workspaceRoot);
	const files = Object.fromEntries(
		REQUIRED_BUNDLE_FILES.map((file) => [file, validateRequiredFile(root, file)]),
	) as RalphBundle["files"];
	const items = parseBundleItemsJson(readFileSync(files[".ralph/items.json"], "utf8"));
	return { root, files, items };
}
