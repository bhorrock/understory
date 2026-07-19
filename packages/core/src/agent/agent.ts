import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import {
  anthropicThinkingOptions,
  createModel,
  openaiThinkingBody,
  resolveFallbackConfig,
  resolveModelConfig,
  resolveThinking,
  type ModelConfig,
} from "../providers/index.js";
import { withFallback } from "../providers/fallback.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTreeAdaptive } from "./tools.js";
import { TraceRecorder, TraceStore } from "./trace.js";

/** Task modes for model/thinking resolution. "maintain" reuses the mutate prompt. */
type AgentMode = "query" | "mutate" | "chat" | "maintain";

/** Steps cap per run (LLM_MAX_STEPS, default 12). Injectable env for tests. */
export function resolveMaxSteps(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LLM_MAX_STEPS);
  return Number.isInteger(n) && n > 0 ? n : 12;
}

/** Mutation sampling temperature (LLM_MUTATION_TEMPERATURE, default 0.2). */
export function resolveMutationTemperature(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LLM_MUTATION_TEMPERATURE);
  return Number.isFinite(n) && n >= 0 ? n : 0.2;
}

export interface AgentOptions {
  model?: string;
}

/** Mutation-run options: `kind` selects the mutate vs maintain model/thinking profile. */
export interface MutationOptions extends AgentOptions {
  kind?: "mutate" | "maintain";
}

/** Call-time providerOptions for thinking (anthropic namespace). */
type ThinkingProviderOptions = ReturnType<typeof anthropicThinkingOptions>;

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
}

export type MutationOutcome =
  | { ok: true; result: MutationResult }
  | { ok: false; status: "partial"; filesChanged: string[]; error: string; traceId: string }
  | { ok: false; status: "failed"; error: string };

interface ResolvedAgentModel {
  model: LanguageModel;
  modelChain: string[];
  /** Passed to generateText/streamText — present only when anthropic thinking is on. */
  providerOptions?: ThinkingProviderOptions;
}

async function promptContext(kb: KnowledgeBase, mode: "query" | "mutate" | "chat") {
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree()]);
  const adaptive = formatTreeAdaptive(tree);
  return { existingTypes: types, treeSummary: adaptive.text, treeDegraded: adaptive.degraded, mode };
}

/** OpenAI-format thinking is injected into the request body at model creation. */
function extraBodyFor(config: ModelConfig, thinking: boolean, env: NodeJS.ProcessEnv) {
  return thinking && config.format === "openai" ? openaiThinkingBody(env) : undefined;
}

async function resolveAgentModel(
  options: AgentOptions,
  mode: AgentMode,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedAgentModel> {
  const thinking = resolveThinking(env, mode);
  const primaryConfig = withModelOverride(resolveModelConfig(env), options.model);
  const primary = await createModel(primaryConfig, { extraBody: extraBodyFor(primaryConfig, thinking, env) });
  const fallbackConfig = resolveFallbackConfig(env);

  // Anthropic thinking rides call-time providerOptions (namespaced, so an openai
  // model in the chain simply ignores it).
  const anthropicInChain =
    thinking &&
    (primaryConfig.format === "anthropic" || fallbackConfig?.format === "anthropic");
  const providerOptions = anthropicInChain ? anthropicThinkingOptions(env) : undefined;

  if (!fallbackConfig) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)], providerOptions };
  }

  const allowFor = resolveAllowFor(env.LLM_FALLBACK_ALLOW_FOR);
  if (allowFor && !allowFor.has(mode)) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)], providerOptions };
  }

  const fallback = await createModel(fallbackConfig, {
    extraBody: extraBodyFor(fallbackConfig, thinking, env),
  });
  return {
    model: withFallback(primary, fallback, {
      retry429: env.LLM_FALLBACK_RETRY_429 === "true",
    }),
    modelChain: [modelLabel(primaryConfig), modelLabel(fallbackConfig)],
    providerOptions,
  };
}

function resolveAllowFor(raw: string | undefined): Set<string> | null {
  if (!raw || raw === "*") return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function withModelOverride(config: ModelConfig, model: string | undefined): ModelConfig {
  return model ? { ...config, model } : config;
}

// No baseURL here by design: traces persist under <bundle>/.traces/, and a
// published bundle would otherwise leak internal hostnames/IPs/ports.
function modelLabel(config: ModelConfig): string {
  return `${config.format}:${config.model || "auto"}`;
}

function traceStore(kb: KnowledgeBase): TraceStore {
  return new TraceStore(kb.bundle.root);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query");
  const recorder = new TraceRecorder();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder),
      stopWhen: stepCountIs(resolveMaxSteps()),
      providerOptions: resolved.providerOptions,
    });
    const trace = recorder.finalize("query", question, result.text, "success", modelChain);
    await traceStore(kb).save(trace);
    return { answer: result.text, steps: result.steps.length, traceId: trace.id };
  } catch (err) {
    const trace = recorder.finalize("query", question, errorMessage(err), "failed", modelChain);
    await traceStore(kb).save(trace);
    throw err;
  }
}

/** Knowledge add/update — full toolset, low temperature. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: MutationOptions = {}
): Promise<MutationOutcome> {
  // "maintain" gets its own model/thinking profile but reuses the mutate prompt.
  const kind = options.kind ?? "mutate";
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, kind);
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: {
        ...buildReadTools(kb, recorder),
        ...buildWriteTools(kb, filesChanged, recorder, { modelChain }),
      },
      stopWhen: stepCountIs(resolveMaxSteps()),
      temperature: resolveMutationTemperature(),
      providerOptions: resolved.providerOptions,
    });
    const trace = recorder.finalize("mutation", instruction, result.text, "success", modelChain);
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.text,
        filesChanged: [...filesChanged].sort(),
        steps: result.steps.length,
        traceId: trace.id,
      },
    };
  } catch (err) {
    const files = [...filesChanged].sort();
    const message = errorMessage(err);
    if (files.length > 0) {
      const summary = `Partial mutation: ${files.length} file(s) changed before failure. Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "partial", modelChain);
      await traceStore(kb).save(trace);
      return { ok: false, status: "partial", filesChanged: files, error: message, traceId: trace.id };
    }
    const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    return { ok: false, status: "failed", error: message };
  }
}

/** Interactive chat — full toolset, streaming. Caller converts to a UI stream response. */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
) {
  const ctx = await promptContext(kb, "chat");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  let modelChain: string[] = [];
  // The user turn that started this run, for the trace record.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const input =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content
          ?.map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim() ?? "(chat)";

  try {
    const resolved = await resolveAgentModel(options, "chat");
    modelChain = resolved.modelChain;
    const result = streamText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      messages,
      tools: {
        ...buildReadTools(kb, recorder),
        ...buildWriteTools(kb, filesChanged, recorder, { modelChain }),
      },
      stopWhen: stepCountIs(resolveMaxSteps()),
      providerOptions: resolved.providerOptions,
      onFinish: async ({ text }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          await traceStore(kb).save(recorder.finalize("chat", input, text, "success", modelChain));
        }
      },
    });
    return { result, filesChanged };
  } catch (err) {
    const outcome = filesChanged.size > 0 ? "partial" : "failed";
    await traceStore(kb).save(recorder.finalize("chat", input, errorMessage(err), outcome, modelChain));
    throw err;
  }
}
