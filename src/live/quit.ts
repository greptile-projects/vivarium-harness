import { armDisplayName, armsForDisplay } from "../arms.js";
import type { LiveModel } from "./model.js";
import type { ArmState } from "./store.js";

// What happens when the human closes the live view while sessions are still
// working.
//
// Quitting the view is not quitting the run, and it must not become that by
// accident: a climb is meant to run for days, and `q` is how you stop watching
// one. But a view that vanishes leaving hours of work running invisibly is its
// own trap — the terminal comes back, the prompt returns, and nothing says the
// arms are still going. So the quit path says so, names them, and points at the
// log that keeps filling. `--abort-on-quit` is for when you did mean to stop
// everything.

// Sessions that have not settled. "starting" counts: the process is up and
// about to work, and a human who quits now still leaves something running.
export function stillRunning(arms: ArmState[]): ArmState[] {
  return armsForDisplay(arms).filter(
    (arm) => arm.status === "starting" || arm.status === "working",
  );
}

// The notice shown when the view is closed early, or null when nothing was
// left running — the ordinary end-of-run unmount, where the closing summary
// says everything worth saying and a second message would only be noise.
export function quitNotice(
  arms: ArmState[],
  options: { logDir?: string; aborting: boolean },
): string | null {
  const running = stillRunning(arms);
  if (running.length === 0) return null;

  const names = running.map((arm) => armDisplayName(arm.arm)).join(", ");
  const count = `${running.length} session${running.length === 1 ? "" : "s"}`;

  if (options.aborting) {
    return `\nstopping ${count} (${names}) — --abort-on-quit\n`;
  }

  const lines = [
    "",
    `live view closed · ${count} still running (${names})`,
    "the run continues in the background; its feed keeps landing in",
    `  ${options.logDir ?? "results/live-<ts>"}/<arm>/progress.log`,
    "re-run with --abort-on-quit if you meant to stop the run itself.",
    "",
  ];
  return lines.join("\n");
}

// The quit path both run modes share, called once the terminal is back. Reads
// what is still running off the model rather than off the keypress, so the
// ordinary end-of-run unmount — where nothing is left running — falls through
// silently and leaves the closing summary to speak for itself.
export function onViewClosed(
  model: LiveModel,
  controller: AbortController,
  options: { logDir?: string; abortOnQuit?: boolean },
): void {
  const notice = quitNotice(model.live.snapshot(), {
    logDir: options.logDir,
    aborting: Boolean(options.abortOnQuit),
  });
  if (!notice) return;

  process.stdout.write(`${notice}\n`);
  if (options.abortOnQuit) {
    controller.abort(new Error("the live view was quit (--abort-on-quit)"));
  }
}
