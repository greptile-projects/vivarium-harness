import { armsForDisplay } from "../harness/arms.js";
import type { LiveModel } from "./model.js";
import type { ArmState } from "./store.js";

// What happens when the human closes the live view while sessions are still
// working: the run goes with it.
//
// The alternative — a view that vanishes leaving hours of work running
// invisibly — is the worse trap, because nothing afterwards says so: the
// terminal comes back, the prompt returns, and the arms keep burning tokens
// behind a shell that looks idle. Quitting therefore means quitting, and the
// safety is a confirmation rather than a flag: `q` names what would be stopped
// and waits for `y`, so the key that ends a three-hour climb is never one
// keystroke. Ctrl-C skips the question — it has one meaning everywhere else,
// and it should not acquire a second one here.

// Sessions that have not settled. "starting" counts: the process is up and
// about to work, and a human who quits now still stops something.
export function stillRunning(arms: ArmState[]): ArmState[] {
  return armsForDisplay(arms).filter(
    (arm) => arm.status === "starting" || arm.status === "working",
  );
}

// Whether `q` has to ask before it unmounts. Only when something would be torn
// down: once every arm has settled the view is a report, and confirming the
// closing of a report is noise.
export function needsQuitConfirm(arms: ArmState[]): boolean {
  return stillRunning(arms).length > 0;
}

function describe(running: ArmState[]): { count: string; names: string } {
  return {
    count: `${running.length} session${running.length === 1 ? "" : "s"}`,
    names: running.map((arm) => arm.arm).join(", "),
  };
}

// The in-view question. Names the arms rather than counting them: "stop 2
// sessions" and "stop tuatara, komodo" cost the same row, and only one of them
// tells the human what they are about to lose.
export function confirmQuitPrompt(
  arms: ArmState[],
  canStopAfterSubticket = false,
  canUpdateAndRestart = false,
): string {
  const running = stillRunning(arms);
  const { count, names } = describe(running);
  return `stop ${count} (${names}) and quit?  y / n${
    canStopAfterSubticket ? " / S after task" : ""
  }${
    canUpdateAndRestart ? " / R pull + restart after task" : ""
  }`;
}

// The notice printed once the terminal is back, or null when nothing was left
// running — the ordinary end-of-run unmount, where the closing summary says
// everything worth saying and a second message would only be noise.
export function quitNotice(
  arms: ArmState[],
  options: { feedPath?: string },
): string | null {
  const running = stillRunning(arms);
  if (running.length === 0) return null;

  const { count, names } = describe(running);
  // Name the feed that was active when the view closed. The caller supplies
  // the same target used by the writer, so planner output can be named exactly
  // while a harness target keeps its per-arm placeholder. Before any phase
  // begins, the generic run shape is the honest answer.
  const path =
    options.feedPath ??
    "results/rung-<NN>/run/<N.M>/<arm>/progress.log";
  return [
    "",
    `quit · stopping ${count} (${names})`,
    "what they wrote before the stop is under",
    `  ${path}`,
    "",
  ].join("\n");
}

// The quit path, called once the terminal is back. Reads
// what is still running off the model rather than off the keypress, so the
// ordinary end-of-run unmount — where nothing is left running — falls through
// silently, aborts nothing, and leaves the closing summary to speak for itself.
export function onViewClosed(
  model: LiveModel,
  controller: AbortController,
  options: { feedPath?: string },
): void {
  const notice = quitNotice(model.live.snapshot(), {
    feedPath: options.feedPath,
  });
  if (!notice) return;

  process.stdout.write(`${notice}\n`);
  controller.abort(new Error("the live view was quit"));
}

// The box the view holds up over the panes. Two kinds, and the difference is
// the whole point of this file's second safety: a *notice* reports something
// that already happened and any key dismisses it, while a *confirm* stands
// between a key and its consequence and only `y` gets through.
export type Popup =
  | { kind: "notice"; state: "pulling" | "done" | "failed"; message: string }
  | { kind: "confirm"; action: "stop-after-task"; message: string };

// `S` used to schedule the stop on the keystroke itself — one key behind `q`,
// with no second question. That is one key too few for something that ends a
// climb: on 2026-08-18 a `q`/`s` pair reached the view seconds after an SSH
// reattach and stopped a run nobody meant to stop, and the log could not say
// whether it was a human or the terminal replaying key bytes. So the graceful
// stop now asks in the same box the pull already uses, and names the step it
// would finish first — the run keeps going until `y`.
export function stopAfterTaskPopup(step?: string): Popup {
  return {
    kind: "confirm",
    action: "stop-after-task",
    message: `finish ${step ?? "the task in flight"} and stop the climb?  y / n`,
  };
}

// What a key means while a popup is up, and the reason the two kinds have
// opposite defaults. A pull in flight ignores everything (there is nothing to
// answer yet, and dismissing it would hide the result). A finished notice takes
// any key. A confirm takes only `y`: every other key cancels, so a stray
// keystroke can never be the thing that says yes.
export function popupKey(
  popup: Popup,
  input: string,
): "accept" | "dismiss" | "ignore" {
  if (popup.kind === "confirm") {
    return input === "y" || input === "Y" ? "accept" : "dismiss";
  }
  return popup.state === "pulling" ? "ignore" : "dismiss";
}
