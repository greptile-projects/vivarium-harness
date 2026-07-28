import { describe, expect, test } from "bun:test";
import { LiveStore, summarize } from "../src/view/store.js";

describe("token counts", () => {
  const event = {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 607_667 },
      last_token_usage: { total_tokens: 28_208 },
      model_context_window: 258_400,
    },
  };

  test("tracks the latest call as context occupancy, not cumulative usage", () => {
    const store = new LiveStore();
    store.register("tuatara");
    store.applyEvent("tuatara", event);

    expect(store.arms.get("tuatara")?.tokens).toBe(28_208);
  });

  test("summarizes the same context value written to the live view", () => {
    expect(summarize(event)).toBe("context tokens 28208");
  });
});
