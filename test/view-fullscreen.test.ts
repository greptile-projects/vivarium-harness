import { describe, expect, test } from "bun:test";
import {
  enterFullscreen,
  restoreOnExit,
} from "../src/view/tui/fullscreen.js";

// A stand-in for process.stdout that records what was written to it.
function fakeStream(): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream & { written: string[] };
}

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

describe("enterFullscreen", () => {
  test("enters the alternate screen and leaves it on restore", () => {
    const stream = fakeStream();
    const restore = enterFullscreen(stream);

    expect(stream.written.join("")).toContain(ENTER_ALT);
    expect(stream.written.join("")).not.toContain(LEAVE_ALT);

    restore();
    expect(stream.written.join("")).toContain(LEAVE_ALT);
  });

  test("restoring twice writes the leave sequence once", () => {
    const stream = fakeStream();
    const restore = enterFullscreen(stream);
    restore();
    restore();
    restore();

    const leaves = stream.written
      .join("")
      .split(LEAVE_ALT).length - 1;
    expect(leaves).toBe(1);
  });
});

describe("restoreOnExit", () => {
  // The regression: the terminal used to come back only when the caller got
  // around to awaiting the handle, which happens after the whole run. Quitting
  // the view mid-run left the alternate screen up with the cursor hidden for
  // the rest of it.
  test("restores when the view exits, before anyone awaits the handle", async () => {
    let restored = false;
    let exit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      exit = resolve;
    });

    // The handle is deliberately never awaited here — this is the caller still
    // sitting inside a long `runHarness`.
    restoreOnExit(exitPromise, () => {
      restored = true;
    });
    expect(restored).toBe(false);

    exit(); // the human presses `q`
    await Promise.resolve();
    await Promise.resolve();

    expect(restored).toBe(true);
  });

  test("restores when the view exits with an error, and the handle still settles", async () => {
    let restored = false;
    const handle = restoreOnExit(
      Promise.reject(new Error("ink unmounted with an error")),
      () => {
        restored = true;
      },
    );

    // Resolves rather than rejecting: a broken view is not the run's failure,
    // and the caller awaits this only to know the terminal is back.
    await expect(handle()).resolves.toBeUndefined();
    expect(restored).toBe(true);
  });

  test("awaiting the handle repeatedly restores only once", async () => {
    let restores = 0;
    const handle = restoreOnExit(Promise.resolve(), () => {
      restores += 1;
    });

    await handle();
    await handle();
    await handle();

    expect(restores).toBe(1);
  });

  test("the handle resolves after the restore has run", async () => {
    const order: string[] = [];
    const handle = restoreOnExit(Promise.resolve(), () =>
      order.push("restore"),
    );

    await handle();
    order.push("awaited");

    expect(order).toEqual(["restore", "awaited"]);
  });
});
