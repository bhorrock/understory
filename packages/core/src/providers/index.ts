import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

type ResolvedLanguageModel = Extract<LanguageModel, { doGenerate: unknown }>;

export type ApiFormat = "openai" | "anthropic";

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
}

const LEGACY_NOTICE =
  "[understory] using legacy env vars. Migrate to LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT.";

/** Ensure the URL ends in /v1 — llama-server serves the OpenAI API there. */
export function normalizeV1(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseFormat(value: string | undefined, fallback: ApiFormat, envName: string): ApiFormat {
  const format = value ?? fallback;
  if (format !== "openai" && format !== "anthropic") {
    throw new Error(`${envName} must be "openai" or "anthropic"`);
  }
  return format;
}

let legacyNoticed = false;

function legacyNotice(): void {
  if (legacyNoticed) return;
  legacyNoticed = true;
  console.error(LEGACY_NOTICE);
}

function legacyConfig(env: NodeJS.ProcessEnv): ModelConfig | null {
  const provider = env.LLM_PROVIDER;
  if (provider) {
    switch (provider) {
      case "anthropic":
        if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for legacy anthropic provider");
        legacyNotice();
        return {
          baseURL: "https://api.anthropic.com/v1",
          apiKey: env.ANTHROPIC_API_KEY,
          format: "anthropic",
          model: env.LLM_MODEL ?? "claude-sonnet-5",
        };
      case "openrouter":
        if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for legacy openrouter provider");
        legacyNotice();
        return {
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: env.OPENROUTER_API_KEY,
          format: "openai",
          model: env.LLM_MODEL ?? "anthropic/claude-sonnet-5",
        };
      case "llamacpp":
        if (!env.LLAMACPP_BASE_URL) throw new Error("LLAMACPP_BASE_URL is required for legacy llamacpp provider");
        legacyNotice();
        return {
          baseURL: env.LLAMACPP_BASE_URL,
          apiKey: env.LLAMACPP_API_KEY ?? "not-needed",
          format: "openai",
          model: env.LLM_MODEL ?? "",
        };
      case "deepseek":
        if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for legacy deepseek provider");
        legacyNotice();
        return {
          baseURL: "https://api.deepseek.com/v1",
          apiKey: env.DEEPSEEK_API_KEY,
          format: "openai",
          model: env.LLM_MODEL ?? "deepseek-chat",
        };
      case "local":
        if (!env.LOCAL_BASE_URL) throw new Error("LOCAL_BASE_URL is required for legacy local provider");
        legacyNotice();
        return {
          baseURL: env.LOCAL_BASE_URL,
          apiKey: env.LOCAL_API_KEY ?? "not-needed",
          format: "openai",
          model: env.LLM_MODEL ?? "local-model",
        };
      default:
        throw new Error(`Unknown legacy LLM_PROVIDER "${provider}" (anthropic|openrouter|llamacpp|deepseek|local)`);
    }
  }

  const configured = [
    env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null,
    env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : null,
    env.LLAMACPP_BASE_URL ? "LLAMACPP_BASE_URL" : null,
    env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY" : null,
    env.LOCAL_BASE_URL ? "LOCAL_BASE_URL" : null,
  ].filter(Boolean) as string[];

  if (configured.length === 0) return null;
  if (configured.length === 1 && configured[0] === "ANTHROPIC_API_KEY") {
    legacyNotice();
    return {
      baseURL: "https://api.anthropic.com/v1",
      apiKey: env.ANTHROPIC_API_KEY!,
      format: "anthropic",
      model: env.LLM_MODEL ?? "claude-sonnet-5",
    };
  }

  throw new Error(
    `Ambiguous legacy LLM configuration (${configured.join(", ")}). Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT, or set LLM_PROVIDER explicitly.`
  );
}

export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  if (env.LLM_API_BASE_URL) {
    return {
      baseURL: env.LLM_API_BASE_URL,
      apiKey: env.LLM_API_KEY ?? "not-needed",
      format: parseFormat(env.LLM_API_FORMAT, "openai", "LLM_API_FORMAT"),
      model: env.LLM_MODEL ?? "",
    };
  }

  const legacy = legacyConfig(env);
  if (legacy) return legacy;

  throw new Error(
    "No LLM configured. Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL."
  );
}

export function resolveFallbackConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  if (!env.LLM_FALLBACK_API_BASE_URL) return null;
  return {
    baseURL: env.LLM_FALLBACK_API_BASE_URL,
    apiKey: env.LLM_FALLBACK_API_KEY ?? "not-needed",
    format: parseFormat(env.LLM_FALLBACK_API_FORMAT, "openai", "LLM_FALLBACK_API_FORMAT"),
    model: env.LLM_FALLBACK_MODEL ?? "",
  };
}

// Any OpenAI-compatible endpoint exposes GET /v1/models.
// Cache discovery per base URL for a short TTL — avoids a discovery
// round-trip on every single agent turn, while still noticing within a
// session that the user swapped which model (e.g. via llama-swap) has
// loaded (a process-lifetime cache would never see that again).
const DISCOVERY_TTL_MS = 60_000;
const discoveryCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();

/**
 * Auto-discover the model id from an OpenAI-compatible /v1/models endpoint.
 * Prefers a model reported as "loaded" (e.g. by llama-swap); falls back to
 * the first listed. Results are cached per URL with a 60s TTL so model
 * swaps are noticed within a session.
 */
export async function discoverLlamaCppModel(baseURL: string): Promise<string> {
  const url = normalizeV1(baseURL);
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  const promise = (async () => {
    const res = await fetch(`${url}/models`);
    if (!res.ok) {
      throw new Error(`Model discovery failed: ${res.status} at ${url}/models`);
    }
    const body = (await res.json()) as {
      data?: { id: string; status?: { value?: string } }[];
    };
    const models = body.data ?? [];
    if (models.length === 0) {
      throw new Error(`No models listed at ${url}/models`);
    }
    const loaded = models.find((m) => m.status?.value === "loaded");
    return (loaded ?? models[0]).id;
  })();
  discoveryCache.set(url, { promise, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  // Don't cache failures — the server may just be starting up.
  promise.catch(() => discoveryCache.delete(url));
  return promise;
}

export interface CreateModelOptions {
  /**
   * Keys shallow-merged into every OpenAI-format request body via a wrapping
   * fetch (thinking toggle, reasoning_effort, LLM_EXTRA_BODY). Ignored for the
   * anthropic format, which carries thinking through call-time providerOptions.
   */
  extraBody?: Record<string, unknown>;
}

export async function createModel(
  cfg: ModelConfig,
  opts: CreateModelOptions = {}
): Promise<ResolvedLanguageModel> {
  let model = cfg.model;
  if (!model) {
    if (cfg.format === "openai") {
      try {
        model = await discoverLlamaCppModel(cfg.baseURL);
      } catch {
        throw new Error("LLM_MODEL is required for this endpoint.");
      }
    } else {
      throw new Error("LLM_MODEL is required for this endpoint.");
    }
  }

  switch (cfg.format) {
    case "anthropic":
      return createAnthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })(model) as ResolvedLanguageModel;
    case "openai": {
      // @ai-sdk/openai-compatible does forward unknown providerOptions keys, but
      // only nested under the provider-name key and interleaved with its own body
      // construction. A wrapping fetch that shallow-merges into the POST JSON is
      // provider-name-independent and gives us exact control of the final body.
      const inject = opts.extraBody && Object.keys(opts.extraBody).length > 0;
      return createOpenAICompatible({
        name: "custom",
        baseURL: normalizeV1(cfg.baseURL),
        apiKey: cfg.apiKey,
        ...(inject ? { fetch: makeBodyInjectingFetch(() => opts.extraBody!) } : {}),
      })(model) as ResolvedLanguageModel;
    }
  }
}

/**
 * Wrap fetch so every POST with a JSON string body gets `extra()` shallow-merged
 * in before the request goes out. Non-POST or non-JSON bodies pass through
 * untouched. References the global `fetch` at call time so test stubs apply.
 */
export function makeBodyInjectingFetch(extra: () => Record<string, unknown>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init && typeof init.body === "string" && (init.method ?? "").toUpperCase() === "POST") {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          init = { ...init, body: JSON.stringify({ ...parsed, ...extra() }) };
        }
      } catch {
        // Non-JSON POST body — forward unchanged.
      }
    }
    return fetch(input, init);
  }) as typeof fetch;
}

/**
 * Whether thinking/reasoning is enabled for a task mode, from the LLM_THINKING
 * env (csv of modes, or "*" for all). Empty/unset disables it everywhere.
 */
export function resolveThinking(env: NodeJS.ProcessEnv, mode: string): boolean {
  const raw = env.LLM_THINKING?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)).has(mode);
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    console.error("[understory] LLM_EXTRA_BODY is not valid JSON; ignoring.");
  }
  return undefined;
}

/**
 * Request-body injection enabling thinking on an OpenAI-format endpoint:
 * `chat_template_kwargs.enable_thinking` (the llama-server / Qwen convention),
 * plus optional LLM_REASONING_EFFORT and any user LLM_EXTRA_BODY JSON.
 */
export function openaiThinkingBody(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: true } };
  if (env.LLM_REASONING_EFFORT) body.reasoning_effort = env.LLM_REASONING_EFFORT;
  const extra = parseExtraBody(env.LLM_EXTRA_BODY);
  if (extra) Object.assign(body, extra);
  return body;
}

function thinkingBudgetTokens(env: NodeJS.ProcessEnv): number {
  const n = Number(env.LLM_THINKING_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/** Call-time providerOptions enabling extended thinking on an Anthropic endpoint. */
export function anthropicThinkingOptions(env: NodeJS.ProcessEnv = process.env): {
  anthropic: { thinking: { type: "enabled"; budgetTokens: number } };
} {
  return { anthropic: { thinking: { type: "enabled", budgetTokens: thinkingBudgetTokens(env) } } };
}

// ── Embeddings (Phase 4 — vector search tier) ─────────────────────────────

/**
 * Configuration for the OpenAI-compatible `/v1/embeddings` endpoint that powers
 * the vector search tier. `model` may be empty (discovered from /v1/models on
 * first use); `dims` may be undefined (learned from the first response).
 */
export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dims?: number;
}

/**
 * Resolve the embedding endpoint from the environment. `LLM_EMBEDDING_API_BASE_URL`
 * enables the vector tier; without it the search index stays FTS-only. Returns
 * null when unset (the universal, always-valid default).
 */
export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  if (!env.LLM_EMBEDDING_API_BASE_URL) return null;
  const cfg: EmbeddingConfig = {
    baseURL: env.LLM_EMBEDDING_API_BASE_URL,
    apiKey: env.LLM_EMBEDDING_API_KEY ?? "not-needed",
    model: env.LLM_EMBEDDING_MODEL ?? "",
  };
  const dims = Number(env.LLM_EMBEDDING_DIMS);
  if (Number.isFinite(dims) && dims > 0) cfg.dims = Math.floor(dims);
  return cfg;
}

/**
 * The embedder identity stamped into index meta so a changed endpoint/model/dims
 * invalidates the stored vectors. `${normalizeV1(baseURL)}|${model}|${dims}`.
 */
export function embedderId(baseURL: string, model: string, dims: number): string {
  return `${normalizeV1(baseURL)}|${model}|${dims}`;
}

/**
 * Ensure the embedding config has a concrete model id, discovering it from the
 * endpoint's /v1/models when `LLM_EMBEDDING_MODEL` was left blank. Mutates and
 * returns the same object so callers keep one resolved config.
 */
export async function resolveEmbeddingModel(cfg: EmbeddingConfig): Promise<EmbeddingConfig> {
  if (!cfg.model) cfg.model = await discoverLlamaCppModel(cfg.baseURL);
  return cfg;
}

/**
 * Embed a batch of texts via the OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Implemented with a plain fetch POST rather than the AI SDK's `embedMany`: it
 * gives exact control over the request/response shape (needed to learn `dims`
 * from the first response and to keep the deterministic-vector test stub simple),
 * mirrors the body-injecting-fetch philosophy the chat path already uses, and
 * avoids the SDK's internal batching/reordering. Results are index-ordered.
 */
export async function embedTexts(cfg: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!cfg.model) throw new Error("embedding model unresolved (call resolveEmbeddingModel first)");
  const url = `${normalizeV1(cfg.baseURL)}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`embeddings request failed: ${res.status} at ${url}`);
  }
  const body = (await res.json()) as {
    data?: { embedding: number[]; index?: number }[];
  };
  const data = body.data ?? [];
  if (data.length !== texts.length) {
    throw new Error(`embeddings returned ${data.length} vectors for ${texts.length} inputs`);
  }
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
}
