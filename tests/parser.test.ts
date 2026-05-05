import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../parser.ts";

test("parseArgs parses task and max iterations", () => {
	assert.deepEqual(parseArgs('"do work" --max-iterations=7'), {
		task: "do work",
		maxIterations: 7,
	});

	assert.deepEqual(parseArgs("do work --max-iterations 3"), {
		task: "do work",
		maxIterations: 3,
	});

	assert.deepEqual(parseArgs("do work"), {
		task: "do work",
		maxIterations: 100,
	});

	assert.equal(parseArgs(""), null);
	assert.equal(parseArgs("--max-iterations=0"), null);
});
