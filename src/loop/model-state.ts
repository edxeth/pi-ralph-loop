import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RalphLoopState } from "../types.js";
import { readState, updateState } from "../state.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type LoopModelState = Pick<
	RalphLoopState,
	"model_provider" | "model_id" | "thinking_level"
>;

function getThinkingLevel(pi: ExtensionAPI): string | null {
	const getter = (pi as { getThinkingLevel?: () => unknown }).getThinkingLevel;
	const level = getter?.();
	return typeof level === "string" ? level : null;
}

export function readCurrentLoopModelState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): LoopModelState {
	return {
		model_provider: ctx.model?.provider ?? null,
		model_id: ctx.model?.id ?? null,
		thinking_level: getThinkingLevel(pi),
	};
}

function canUpdateLoopModelState(ctx: ExtensionContext): boolean {
	const state = readState(ctx.cwd);
	if (!state?.running || state.transitioning) return false;
	return state.session_id === ctx.sessionManager.getSessionId();
}

export function updateLoopModelStateFromContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (!canUpdateLoopModelState(ctx)) return;

	const current = readCurrentLoopModelState(pi, ctx);
	updateState(ctx.cwd, {
		...(current.model_provider && current.model_id
			? {
					model_provider: current.model_provider,
					model_id: current.model_id,
				}
			: {}),
		thinking_level: current.thinking_level,
	});
}

export function updateLoopSelectedModel(
	ctx: ExtensionContext,
	model: { provider: string; id: string },
): void {
	if (!canUpdateLoopModelState(ctx)) return;
	updateState(ctx.cwd, {
		model_provider: model.provider,
		model_id: model.id,
	});
}

export function updateLoopThinkingLevel(
	ctx: ExtensionContext,
	level: string,
): void {
	if (!canUpdateLoopModelState(ctx)) return;
	updateState(ctx.cwd, { thinking_level: level });
}

export async function restoreLoopModelState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphLoopState,
): Promise<string | null> {
	if (state.model_provider || state.model_id) {
		if (!state.model_provider || !state.model_id) {
			return "Ralph loop saved an incomplete model selection";
		}

		const model = ctx.modelRegistry.find(state.model_provider, state.model_id);
		if (!model) {
			return `Ralph loop saved model ${state.model_provider}/${state.model_id}, but it is not available in this Pi instance`;
		}

		const selected = await pi.setModel(model);
		if (!selected) {
			return `Ralph loop saved model ${state.model_provider}/${state.model_id}, but Pi could not select it`;
		}
	}

	if (state.thinking_level) {
		pi.setThinkingLevel(state.thinking_level as ThinkingLevel);
	}

	return null;
}
