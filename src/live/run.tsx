import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
import { attachLive } from "./attach.js";
import { LiveModel } from "./model.js";
import type { LiveStore } from "./store.js";
import { mountLive } from "./tui/app.js";

export interface TicketRunResult {
  run: HarnessRunResult;
  store: LiveStore;
}

// One ticket through both arms, with the live view attached. The view and the
// durable artifacts come from the *same* single `runHarness` call — watching a
// run is a display choice, never a second execution path.
export async function runTicketLive(
  config: HarnessConfig,
  // `hold` keeps the view up after the arms settle instead of unmounting into
  // the closing summary — the demo's whole purpose is the view itself.
  options: { useTui: boolean; logPath?: string; hold?: boolean },
): Promise<TicketRunResult> {
  const model = new LiveModel("vivarium", config.ticket);
  for (const arm of config.arms) model.live.register(arm.name);

  const sinks = attachLive(model.live, {
    ...options,
    onLine: (line) => model.appendLog(line),
  });
  const app = options.useTui ? mountLive(model, options) : undefined;

  try {
    const run = await runHarness(config, sinks.onEvent, sinks.onArmComplete);
    if (app) {
      // The ticket stays on screen — the per-arm statuses already carry the
      // outcome, and the entrypoint prints it again once the terminal is back.
      model.finish(undefined, { hold: options.hold });
      await app.waitUntilExit();
    }
    await sinks.flush();
    return { run, store: model.live };
  } catch (error) {
    // Hand the terminal back before the error surfaces, or the message would be
    // written onto the alternate screen and vanish with it.
    if (app) {
      model.finish("failed — see the log tab, then the error below", {
        hold: options.hold,
      });
      await app.waitUntilExit();
    }
    await sinks.flush();
    throw error;
  }
}
