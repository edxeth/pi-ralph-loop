import type { BundleItem } from "./types.js";

type ImmutableItemSnapshot = Array<{
	category: string;
	description: string;
	steps: string[];
	passes: boolean;
}>;

function parseSnapshot(
	previousSnapshotJson: string | null,
): ImmutableItemSnapshot | string {
	if (!previousSnapshotJson) return "missing pre-iteration item snapshot";

	try {
		return JSON.parse(previousSnapshotJson) as ImmutableItemSnapshot;
	} catch {
		return "invalid pre-iteration item snapshot";
	}
}

function evaluateImmutableItems(
	previous: ImmutableItemSnapshot,
	currentItems: BundleItem[],
): string | null {
	if (previous.length !== currentItems.length) {
		return "item count changed during the iteration";
	}

	for (let index = 0; index < previous.length; index++) {
		const before = previous[index];
		const after = currentItems[index];
		if (
			before.category !== after.category ||
			before.description !== after.description ||
			JSON.stringify(before.steps) !== JSON.stringify(after.steps)
		) {
			return `item ${index + 1} immutable fields changed`;
		}
	}

	return null;
}

export function evaluateNextGate(
	previousSnapshotJson: string | null,
	currentItems: BundleItem[],
): string | null {
	const previous = parseSnapshot(previousSnapshotJson);
	if (typeof previous === "string") return previous;

	const immutableError = evaluateImmutableItems(previous, currentItems);
	if (immutableError) return immutableError;

	let completed = 0;
	for (let index = 0; index < previous.length; index++) {
		if (!previous[index].passes && currentItems[index].passes) completed++;
	}

	if (completed !== 1) {
		return `exactly one item must move from passes=false to passes=true; observed ${completed}`;
	}

	return null;
}

export function evaluateCompleteGate(
	previousSnapshotJson: string | null,
	currentItems: BundleItem[],
): string | null {
	const previous = parseSnapshot(previousSnapshotJson);
	if (typeof previous === "string") return previous;

	const immutableError = evaluateImmutableItems(previous, currentItems);
	if (immutableError) return immutableError;

	if (currentItems.some((item) => !item.passes)) {
		return "COMPLETE requires every item to have passes=true";
	}

	return null;
}
