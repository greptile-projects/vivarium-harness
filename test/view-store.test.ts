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

describe("session configuration", () => {
  test("tracks the reasoning effort reported by Codex", () => {
    const store = new LiveStore();
    store.register("komodo");
    store.applyEvent("komodo", {
      type: "session_configured",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      service_tier: "priority",
    });

    expect(store.arms.get("komodo")).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });

  test("summarizes the effective model, effort, and fast tier on one line", () => {
    expect(
      summarize({
        type: "session_configured",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        service_tier: "priority",
      }),
    ).toBe("model gpt-5.6-sol high fast");
  });
});
