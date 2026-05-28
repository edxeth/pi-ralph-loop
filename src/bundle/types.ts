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

export type CommitPolicy = "none" | "optional" | "exactly_one" | "at_least_one";

export type RuntimeContract = {
	source_docs?: string[];
	verification_gates?: VerificationGate[];
	require_progress_append?: boolean;
	require_one_item_per_iteration?: boolean;
	require_clean_source_docs?: boolean;
	commit_policy?: CommitPolicy;
	git_root?: string;
	/** @deprecated Use commit_policy instead. */
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
	progress_snapshot: string;
	source_doc_hashes: string;
	bundle_items_snapshot: string;
	git_head: string | null;
};

export type BundleFileGateSnapshot = {
	progress_size: number | null;
	progress_snapshot: string | null;
	source_doc_hashes: string | null;
	git_head?: string | null;
};
