import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { readState, updateState } from "./state.js";

function isLoopRunning(cwd: string): boolean {
  return readState(cwd)?.running === true;
}

function restoreLoopStatus(ctx: ExtensionContext): void {
  const state = readState(ctx.cwd);
  if (!state?.running) return;

  const theme = ctx.ui.theme;
  ctx.ui.setStatus(
    "ralph-loop",
    theme.fg("accent", `Ralph ${state.iteration}/${state.max_iterations}`),
  );
}

function handleSessionBeforeSwitch(
  event: { reason: "new" | "resume" },
  ctx: ExtensionContext,
) {
  const state = readState(ctx.cwd);
  if (!state?.running) return;

  if (event.reason === "resume") {
    ctx.ui.notify(
      "Ralph loop is running. /resume is blocked. Use another pi instance or /ralph-stop.",
      "warning",
    );
    return { cancel: true };
  }

  if (event.reason === "new" && !state.transitioning) {
    ctx.ui.notify(
      "Ralph loop is running. /new is blocked. Use another pi instance or /ralph-stop.",
      "warning",
    );
    return { cancel: true };
  }
}

function handleBlockedSessionMutation(
  commandName: "fork" | "tree",
  ctx: ExtensionContext,
) {
  if (!isLoopRunning(ctx.cwd)) return;

  ctx.ui.notify(
    `Ralph loop is running. /${commandName} is blocked. Use another pi instance or /ralph-stop.`,
    "warning",
  );
  return { cancel: true };
}

function handleSessionShutdown(ctx: ExtensionContext) {
  const state = readState(ctx.cwd);
  if (state?.running && !state.transitioning) {
    updateState(ctx.cwd, { cancel_requested: true });
  }
}

function handleSessionStart(
  pi: ExtensionAPI,
  event: { reason: string },
  ctx: ExtensionContext,
) {
  const state = readState(ctx.cwd);
  if (!state?.running) return;

  if (event.reason === "startup") {
    updateState(ctx.cwd, {
      running: false,
      completed_at: new Date().toISOString(),
      stop_reason: "error",
      transitioning: false,
      cancel_requested: false,
      stop_requested: false,
      next_message: "",
    });
    ctx.ui.setStatus("ralph-loop", undefined);
    return;
  }

  restoreLoopStatus(ctx);
  if (event.reason === "new" && state.transitioning) {
    pi.sendUserMessage("/ralph-continue");
  }
}

export function registerEventHandlers(pi: ExtensionAPI): void {
  pi.on("session_before_switch", handleSessionBeforeSwitch);
  pi.on("session_before_fork", async (_event, ctx) =>
    handleBlockedSessionMutation("fork", ctx),
  );
  pi.on("session_before_tree", async (_event, ctx) =>
    handleBlockedSessionMutation("tree", ctx),
  );
  pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));
  pi.on("session_start", handleSessionStart.bind(null, pi));
}
