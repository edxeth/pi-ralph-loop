const OPT_OUT_ENV = "RALPH_LIMIT_REMINDERS_DISABLED";

const LIMIT_REMINDERS = [
	{
		id: "75",
		percent: 75,
		message:
			"This Pi session is getting long and approaching its context limit. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
	{
		id: "80",
		percent: 80,
		message:
			"This Pi session has little context room left. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
	{
		id: "85",
		percent: 85,
		message:
			"This Pi session is almost out of context room. Keep following the original instructions. When a valid promise is appropriate, use <promise>NEXT</promise> or <promise>COMPLETE</promise> according to those instructions.",
	},
] as const;

export function areLimitRemindersDisabled(): boolean {
	const value = process.env[OPT_OUT_ENV];
	return value !== undefined && value !== "" && value !== "0";
}

export type SelectedReminder = {
	message: string;
	/** The updated comma-separated set of sent reminder ids to persist. */
	sentCsv: string;
};

/**
 * Select the next context-limit reminder to send, given the current usage
 * percent and the comma-separated ids already sent this iteration. Returns null
 * when no new reminder applies. Each reminder fires at most once per iteration.
 */
export function selectLimitReminder(
	usagePercent: number,
	sentCsv: string | null,
): SelectedReminder | null {
	const sent = new Set(
		(sentCsv ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
	const reminder = LIMIT_REMINDERS.find(
		(candidate) => usagePercent >= candidate.percent && !sent.has(candidate.id),
	);
	if (!reminder) return null;

	sent.add(reminder.id);
	return { message: reminder.message, sentCsv: Array.from(sent).join(",") };
}
