import type { HarnessConfig } from "./harness/config.js";
import { runHarness, type HarnessRunResult } from "./harness/harness.js";
import { attachLive } from "./view/attach.js";
import { LiveModel } from "./view/model.js";
import { onViewClosed } from "./view/quit.js";
import type { LiveStore } from "./view/store.js";
import { mountLive } from "./view/tui/app.js";

export interface TicketRunResult {
  run: HarnessRunResult;
  store: LiveStore;
}

// One ticket through both arms, with the live view attached. The view and the
// durable artifacts come from the *same* single `runHarness` call — watching a
// run is a display choice, never a second execution path.
export async function runTicketLive(
  config: HarnessConfig,
  // `abortOnQuit` makes closing the view stop the run rather than outlive it.
  options: { useTui: boolean; logDir?: string; abortOnQuit?: boolean },
): Promise<TicketRunResult> {
  const model = new LiveModel("vivarium", config.ticket);
  for (const arm of config.arms) model.live.register(arm.name);

  const sinks = attachLive(model.live, {
    ...options,
    onLine: (line) => model.appendLog(line),
    onLanding: (record) => model.recordLanding(record),
  });
  const controller = new AbortController();
  const app = options.useTui
    ? mountLive(model, {
        ...options,
        onExit: () => onViewClosed(model, controller, options),
      })
    : undefined;

  try {
    const run = await runHarness(config, sinks, controller.signal);
    if (app) {
      // The ticket stays on screen — the per-arm statuses already carry the
      // outcome, and the entrypoint prints it again once the terminal is back.
      model.finish();
      await app.waitUntilExit();
    }
    await sinks.flush();
    return { run, store: model.live };
  } catch (error) {
    // Hand the terminal back before the error surfaces, or the message would be
    // written onto the alternate screen and vanish with it.
    if (app) {
      model.finish("failed — see the log tab, then the error below");
      await app.waitUntilExit();
    }
    await sinks.flush();
    throw error;
  }
}
