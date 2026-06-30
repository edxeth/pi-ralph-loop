import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	renderStatus,
	type StatusView,
	type ThemeLike,
} from "../src/loop/status-render.ts";
import type { ColorMode } from "../src/loop/status-model.ts";

// Identity theme: no wrapping, so visible width equals raw text for width math.
const identityTheme: ThemeLike = {
	fg: (_c, t) => t,
	bold: (t) => t,
};

function taggingTheme(): { theme: ThemeLike; calls: string[] } {
	const calls: string[] = [];
	const theme: ThemeLike = {
		fg: (c, t) => {
			calls.push(`fg:${c}`);
			return t;
		},
		bold: (t) => {
			calls.push("bold");
			return t;
		},
	};
	return { theme, calls };
}

function view(overrides: Partial<StatusView> = {}): StatusView {
	return {
		phase: "working",
		countLabel: "3/5",
		countSuffix: null,
		elapsed: "12m 04s",
		errorCount: 0,
		bundleMode: false,
		current: null,
		progressTail: null,
		taskSummary: "implement the thing",
		stalled: false,
		resultSummary: null,
		...overrides,
	};
}

function opts(
	width: number,
	theme: ThemeLike = identityTheme,
	colorMode: ColorMode = "ansi16",
	frameTick = 0,
) {
	return { theme, width, colorMode, frameTick };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("active render: two lines (identity + work)", () => {
	const lines = renderStatus(view(), opts(80));
	assert.equal(lines.length, 2);
});

test("identity line shows the phase label and elapsed inline", () => {
	const lines = renderStatus(view(), opts(80));
	assert.match(strip(lines[0]), /Loop Running/);
	assert.match(strip(lines[0]), /· 12m 04s/);
});

test("label shimmers in truecolor while working; static otherwise", () => {
	const tc = renderStatus(view({ phase: "working" }), opts(80, identityTheme, "truecolor", 2));
	assert.ok(tc[0].includes("\x1b[38;2;"));
	// Visible text is unchanged by the shimmer.
	assert.match(strip(tc[0]), /Loop Running/);
	// Non-truecolor never emits 38;2.
	const plain = renderStatus(view({ phase: "working" }), opts(80, identityTheme, "ansi16", 2));
	assert.ok(!plain[0].includes("\x1b[38;2;"));
});

test("shimmer advances with the frame tick (truecolor, working)", () => {
	const a = renderStatus(view({ phase: "working" }), opts(80, identityTheme, "truecolor", 0))[0];
	const b = renderStatus(view({ phase: "working" }), opts(80, identityTheme, "truecolor", 3))[0];
	assert.notEqual(a, b);
});

test("trouble phases do not shimmer even in truecolor", () => {
	for (const phase of ["stalled", "recovering", "stopping"] as const) {
		const out = renderStatus(view({ phase }), opts(80, identityTheme, "truecolor", 5))[0];
		assert.ok(!out.includes("\x1b[38;2;"), `phase=${phase} should be static`);
	}
});

test("work line shows the count and the current work", () => {
	const lines = renderStatus(view({ countLabel: "2/8" }), opts(80));
	assert.match(strip(lines[1]), /2\/8/);
	assert.match(strip(lines[1]), /implement the thing/);
});

test("bundle mode work line prefers current item, then progress tail", () => {
	const withCurrent = renderStatus(
		view({ bundleMode: true, current: "item A", progressTail: "did B", taskSummary: null }),
		opts(80),
	);
	assert.match(strip(withCurrent[1]), /item A/);

	const tailOnly = renderStatus(
		view({ bundleMode: true, current: null, progressTail: "did B", taskSummary: null }),
		opts(80),
	);
	assert.match(strip(tailOnly[1]), /did B/);
});

test("err count only shown when > 0", () => {
	assert.ok(!strip(renderStatus(view({ errorCount: 0 }), opts(80)).join("\n")).includes("err"));
	assert.ok(strip(renderStatus(view({ errorCount: 2 }), opts(80)).join("\n")).includes("err 2"));
});

test("result summary: single line, overrides body, leads with glyph", () => {
	const lines = renderStatus(
		view({ resultSummary: "Ralph complete — 7/7", phase: "done" }),
		opts(80),
	);
	assert.equal(lines.length, 1);
	assert.match(strip(lines[0]), /Ralph complete/);
	assert.match(strip(lines[0]), /✓/);
});

test("every line stays within width across widths/views", () => {
	const views = [
		view(),
		view({ bundleMode: true, current: "do the bundle thing with a very long description that overflows", countLabel: "4/7", taskSummary: null }),
		view({ phase: "stalled", errorCount: 3 }),
		view({ phase: "recovering", errorCount: 1 }),
		view({ resultSummary: "Ralph complete — 7/7, 12 iterations, 8m", phase: "done" }),
		view({ elapsed: null }),
		view({ taskSummary: "x".repeat(200) }),
		// Long fixed-width parts: 3-digit count, non-zero err, long elapsed — the
		// values that previously overflowed because fixed parts were not truncated.
		view({ countLabel: "100/100", errorCount: 5, elapsed: "100h 00m" }),
		view({ countLabel: "100/100", errorCount: 5, elapsed: "100h 00m", phase: "stalled" }),
	];
	for (const width of [1, 4, 8, 10, 12, 16, 20, 30, 40, 56, 80, 120]) {
		for (const v of views) {
			const lines = renderStatus(v, opts(width));
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`width=${width} phase=${v.phase} got=${visibleWidth(line)} :: ${JSON.stringify(line)}`,
				);
			}
		}
	}
});

test("phase tone is applied via theme tokens", () => {
	const { theme, calls } = taggingTheme();
	renderStatus(view({ phase: "failed", errorCount: 2, resultSummary: "Ralph failed" }), opts(80, theme));
	assert.ok(calls.includes("fg:error"));
});

test("identical (view, width, tick) renders identically (deterministic)", () => {
	const a = renderStatus(view(), opts(80, identityTheme, "truecolor", 4));
	const b = renderStatus(view(), opts(80, identityTheme, "truecolor", 4));
	assert.deepEqual(a, b);
});
