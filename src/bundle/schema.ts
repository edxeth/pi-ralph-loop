import path from "node:path";

import type { BundleItem, BundleItemsFile, RuntimeContract } from "./types.js";

function fail(message: string): never {
	throw new Error(`Invalid Ralph bundle: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

	if (value.commit_policy !== undefined) {
		if (
			value.commit_policy !== "none" &&
			value.commit_policy !== "optional" &&
			value.commit_policy !== "exactly_one" &&
			value.commit_policy !== "at_least_one"
		) {
			fail(
				"runtime_contract.commit_policy must be one of none, optional, exactly_one, at_least_one",
			);
		}
		contract.commit_policy = value.commit_policy;
	}

	if (value.git_root !== undefined) {
		if (
			typeof value.git_root !== "string" ||
			value.git_root.length === 0 ||
			path.isAbsolute(value.git_root)
		) {
			fail("runtime_contract.git_root must be a non-empty relative path");
		}
		const normalized = path.normalize(value.git_root);
		if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
			fail("runtime_contract.git_root must not escape the workspace");
		}
		contract.git_root = value.git_root;
	}

	for (const key of [
		"require_progress_append",
		"require_one_item_per_iteration",
		"require_clean_source_docs",
		"require_one_commit_per_iteration",
	] as const) {
		if (value[key] !== undefined) {
			if (typeof value[key] !== "boolean")
				fail(`runtime_contract.${key} must be boolean`);
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
		if (
			!Array.isArray(item.steps) ||
			item.steps.length === 0 ||
			!item.steps.every((step) => typeof step === "string" && step)
		) {
			fail(`items[${index}].steps must be a non-empty string array`);
		}
		if (typeof item.passes !== "boolean")
			fail(`items[${index}].passes must be boolean`);
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
