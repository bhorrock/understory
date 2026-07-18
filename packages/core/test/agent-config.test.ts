import { describe, it, expect, afterEach, vi } from "vitest";
import { makeBodyInjectingFetch, resolveThinking } from "../src/providers/index.js";
import { resolveMaxSteps, resolveMutationTemperature } from "../src/agent/index.js";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── resolveThinking (LLM_THINKING csv / "*" / empty) ─────────────────

describe("resolveThinking", () => {
  it("disables everything when unset or empty", () => {
    for (const mode of ["query", "mutate", "chat", "maintain"]) {
      expect(resolveThinking(env({}), mode)).toBe(false);
      expect(resolveThinking(env({ LLM_THINKING: "" }), mode)).toBe(false);
      expect(resolveThinking(env({ LLM_THINKING: "   " }), mode)).toBe(false);
    }
  });

  it('enables every mode for "*"', () => {
    for (const mode of ["query", "mutate", "chat", "maintain"]) {
      expect(resolveThinking(env({ LLM_THINKING: "*" }), mode)).toBe(true);
    }
  });

  it("enables only the listed modes, tolerating whitespace", () => {
    const e = env({ LLM_THINKING: "mutate, maintain" });
    expect(resolveThinking(e, "mutate")).toBe(true);
    expect(resolveThinking(e, "maintain")).toBe(true);
    expect(resolveThinking(e, "query")).toBe(false);
    expect(resolveThinking(e, "chat")).toBe(false);
  });
});

// ── makeBodyInjectingFetch (final request body) ──────────────────────

describe("makeBodyInjectingFetch", () => {
  it("shallow-merges extra() into POST JSON bodies before dispatch", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const wrapped = makeBodyInjectingFetch(() => ({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: "high",
    }));
    await wrapped("http://host/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], temperature: 0.2 }),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(spy.mock.calls[0][1]!.body as string);
    expect(sent).toEqual({
      model: "m",
      messages: [],
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: "high",
    });
  });

  it("leaves non-POST requests untouched", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const wrapped = makeBodyInjectingFetch(() => ({ injected: true }));
    await wrapped("http://host/v1/models", { method: "GET" });

    expect(spy.mock.calls[0][1]).toEqual({ method: "GET" });
  });

  it("forwards non-JSON POST bodies unchanged without throwing", async () => {
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const wrapped = makeBodyInjectingFetch(() => ({ injected: true }));
    await wrapped("http://host/upload", { method: "POST", body: "not json" });

    expect(spy.mock.calls[0][1]!.body).toBe("not json");
  });
});

// ── LLM_MAX_STEPS / LLM_MUTATION_TEMPERATURE parsing ─────────────────

describe("resolveMaxSteps", () => {
  it("defaults to 12 and parses valid positive integers", () => {
    expect(resolveMaxSteps(env({}))).toBe(12);
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "20" }))).toBe(20);
  });

  it("falls back to 12 on garbage, zero, negative, or non-integer input", () => {
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "abc" }))).toBe(12);
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "0" }))).toBe(12);
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "-5" }))).toBe(12);
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "12.5" }))).toBe(12);
    expect(resolveMaxSteps(env({ LLM_MAX_STEPS: "" }))).toBe(12);
  });
});

describe("resolveMutationTemperature", () => {
  it("defaults to 0.2 and parses valid non-negative numbers", () => {
    expect(resolveMutationTemperature(env({}))).toBe(0.2);
    expect(resolveMutationTemperature(env({ LLM_MUTATION_TEMPERATURE: "0" }))).toBe(0);
    expect(resolveMutationTemperature(env({ LLM_MUTATION_TEMPERATURE: "0.7" }))).toBe(0.7);
  });

  it("falls back to 0.2 on garbage or negative input", () => {
    expect(resolveMutationTemperature(env({ LLM_MUTATION_TEMPERATURE: "abc" }))).toBe(0.2);
    expect(resolveMutationTemperature(env({ LLM_MUTATION_TEMPERATURE: "-1" }))).toBe(0.2);
  });
});
