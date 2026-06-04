import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	evaluateVerificationGates,
	loadRalphBundle,
	parseBundleItemsJson,
} from "../src/bundle/index.ts";

function withWorkspace(fn: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "ralph-bundle-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeBundle(root: string, itemsJson = validItemsJson()): void {
	mkdirSync(path.join(root, ".ralph"), { recursive: true });
	writeFileSync(path.join(root, ".ralph/plan.md"), "plan");
	writeFileSync(path.join(root, ".ralph/items.json"), itemsJson);
	writeFileSync(path.join(root, ".ralph/prompt.md"), "prompt");
	writeFileSync(path.join(root, ".ralph/progress.md"), "progress");
}

function itemsJsonWithGate(command: string): string {
	return JSON.stringify({
		version: 1,
		runtime_contract: {
			source_docs: [".pi/plans/prds/example.md"],
			verification_gates: [{ name: "tests", command }],
			require_progress_append: true,
			require_one_item_per_iteration: true,
			require_clean_source_docs: true,
			require_commit: true,
		},
		items: [
			{
				category: "bundle-contract",
				description: "Validate bundle shape.",
				steps: ["Load files", "Validate schema"],
				passes: false,
				regression_notes: "",
				extra: "allowed",
			},
		],
		extra_top_level: "allowed",
	});
}

function validItemsJson(): string {
	return itemsJsonWithGate("npm test");
}

function nodeScriptCommand(scriptPath: string): string {
	return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
}

test("parseBundleItemsJson accepts the generated bundle schema and optional metadata", () => {
	const parsed = parseBundleItemsJson(validItemsJson());

	assert.equal(parsed.version, 1);
	assert.equal(parsed.items.length, 1);
	assert.equal(parsed.items[0].description, "Validate bundle shape.");
	assert.deepEqual(parsed.runtime_contract?.verification_gates, [
		{ name: "tests", command: "npm test" },
	]);
});

test("parseBundleItemsJson accepts distilled-only runtime contracts", () => {
	const parsed = parseBundleItemsJson(
		JSON.stringify({
			version: 1,
			runtime_contract: {
				source_docs: [],
				verification_gates: [],
				require_progress_append: true,
				require_one_item_per_iteration: true,
				require_commit: true,
			},
			items: [
				{
					category: "distilled-only",
					description:
						"Use the generated bundle without rereading source docs.",
					steps: ["Read .ralph/plan.md", "Complete one item"],
					passes: false,
					regression_notes: "",
				},
			],
		}),
	);

	assert.deepEqual(parsed.runtime_contract?.source_docs, []);
	assert.equal(parsed.runtime_contract?.require_clean_source_docs, undefined);
	assert.equal(parsed.runtime_contract?.require_commit, true);
});

test("parseBundleItemsJson rejects commit_policy", () => {
	assert.throws(
		() =>
			parseBundleItemsJson(
				JSON.stringify({
					version: 1,
					runtime_contract: { commit_policy: "exactly_one" },
					items: [
						{
							category: "commit-contract",
							description: "Use require_commit for commit enforcement.",
							steps: ["Load the bundle"],
							passes: false,
							regression_notes: "",
						},
					],
				}),
			),
		/commit_policy is no longer supported/,
	);
});

test("parseBundleItemsJson rejects git_root", () => {
	assert.throws(
		() =>
			parseBundleItemsJson(
				JSON.stringify({
					version: 1,
					runtime_contract: { git_root: "." },
					items: [
						{
							category: "workspace-root",
							description: "Use the Ralph workspace root for commits.",
							steps: ["Load the bundle"],
							passes: false,
							regression_notes: "",
						},
					],
				}),
			),
		/git_root is no longer supported/,
	);
});

test("parseBundleItemsJson rejects malformed and invalid items.json", () => {
	assert.throws(() => parseBundleItemsJson("{"), /malformed JSON/);
	assert.throws(
		() => parseBundleItemsJson(JSON.stringify({ version: 2, items: [] })),
		/version must be 1/,
	);
	assert.throws(
		() => parseBundleItemsJson(JSON.stringify({ version: 1, items: [] })),
		/non-empty array/,
	);
	assert.throws(
		() =>
			parseBundleItemsJson(
				JSON.stringify({
					version: 1,
					items: [
						{
							category: "x",
							description: "x",
							steps: [],
							passes: false,
							regression_notes: "",
						},
					],
				}),
			),
		/steps must be a non-empty string array/,
	);
	assert.throws(
		() =>
			parseBundleItemsJson(
				JSON.stringify({
					version: 1,
					items: [
						{
							category: "x",
							description: "x",
							steps: ["x"],
							passes: "no",
							regression_notes: "",
						},
					],
				}),
			),
		/passes must be boolean/,
	);
});

test("loadRalphBundle validates all required files", () => {
	withWorkspace((root) => {
		writeBundle(root);
		const bundle = loadRalphBundle(root);

		assert.equal(bundle.root, root);
		assert.equal(bundle.items.items[0].category, "bundle-contract");
		assert.match(bundle.files[".ralph/prompt.md"], /\.ralph\/prompt\.md$/);
	});
});

test("loadRalphBundle rejects missing required files and unsafe symlinks", () => {
	withWorkspace((root) => {
		writeBundle(root);
		rmSync(path.join(root, ".ralph/progress.md"));
		assert.throws(() => loadRalphBundle(root), /progress\.md is missing/);
	});

	withWorkspace((root) => {
		writeBundle(root);
		rmSync(path.join(root, ".ralph/prompt.md"));
		symlinkSync(
			path.join(root, ".ralph/plan.md"),
			path.join(root, ".ralph/prompt.md"),
		);
		assert.throws(
			() => loadRalphBundle(root),
			/prompt\.md must not be a symlink/,
		);
	});
});

test("evaluateVerificationGates allows noisy passing commands", () => {
	withWorkspace((root) => {
		const scriptPath = path.join(root, "noisy-pass.js");
		writeFileSync(scriptPath, `process.stdout.write("x".repeat(20_000));\n`);
		writeBundle(root, itemsJsonWithGate(nodeScriptCommand(scriptPath)));

		assert.equal(evaluateVerificationGates(loadRalphBundle(root)), null);
	});
});

test("evaluateVerificationGates reports noisy failures as command failures", () => {
	withWorkspace((root) => {
		const scriptPath = path.join(root, "noisy-fail.js");
		writeFileSync(
			scriptPath,
			`process.stdout.write("x".repeat(20_000));\nprocess.exit(1);\n`,
		);
		writeBundle(root, itemsJsonWithGate(nodeScriptCommand(scriptPath)));

		const failure = evaluateVerificationGates(loadRalphBundle(root));

		assert.notEqual(failure, null);
		assert.match(failure ?? "", /verification gate tests exited with code 1/);
		assert.doesNotMatch(failure ?? "", /timed out/);
		assert.match(failure ?? "", /output truncated/);
	});
});

test("evaluateVerificationGates reports truncated whitespace-only output", () => {
	withWorkspace((root) => {
		const scriptPath = path.join(root, "whitespace-fail.js");
		writeFileSync(
			scriptPath,
			`process.stdout.write(" ".repeat(20_000));\nprocess.exit(1);\n`,
		);
		writeBundle(root, itemsJsonWithGate(nodeScriptCommand(scriptPath)));

		const failure = evaluateVerificationGates(loadRalphBundle(root));

		assert.notEqual(failure, null);
		assert.match(failure ?? "", /verification gate tests exited with code 1/);
		assert.match(failure ?? "", /output truncated/);
	});
});
