export type ControlPromise = "NEXT" | "COMPLETE" | "STOP";

export function extractControlPromise(
	msg: { content?: unknown } | null,
): ControlPromise | null {
	if (!msg || !Array.isArray(msg.content)) return null;

	const text = (msg.content as Array<{ type: string; text?: string }>)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	if (!text) return null;

	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return null;

	const finalLine = lines[lines.length - 1].replace(/^`+|`+$/g, "");
	const match = finalLine.match(/<promise>(NEXT|COMPLETE|STOP)<\/promise>$/);
	return match ? (match[1] as ControlPromise) : null;
}
