import { describe, expect, it } from "bun:test";
import { LiveModel } from "../src/live/model.js";

describe("LiveModel.finish", () => {
  it("marks the run over without holding the view by default", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish();
    expect(model.finished).toBe(true);
    // A real run unmounts into the closing summary.
    expect(model.hold).toBe(false);
    // Nothing better to say than the ticket, so the subtitle is left alone.
    expect(model.subtitle).toBe("a ticket");
  });

  it("holds the view open when asked (the demo)", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish(undefined, { hold: true });
    expect(model.finished).toBe(true);
    expect(model.hold).toBe(true);
  });

  it("treats an absent hold as 'leave it as it is'", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish(undefined, { hold: true });
    // A later finish (the error path re-finishes with a message) must not
    // silently drop the hold and close the view out from under the human.
    model.finish("failed — see the log tab, then the error below");
    expect(model.hold).toBe(true);
    expect(model.subtitle).toBe("failed — see the log tab, then the error below");
  });

  it("notifies subscribers so the view can repaint the final frame", () => {
    const model = new LiveModel("vivarium", "a ticket");
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.finish(undefined, { hold: true });
    expect(notifications).toBe(1);
  });
});
