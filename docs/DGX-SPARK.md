# Running understory on a DGX Spark

This guide covers running understory on an NVIDIA DGX Spark (GB10, 128 GB unified
memory, ARM64) with a local Qwen3.6-35B-A3B chat model and a local embedding model,
both served by [llama.cpp](https://github.com/ggml-org/llama.cpp) (or vLLM) on the
host. understory itself runs in a container and talks to the host servers over
`host.docker.internal`.

Everything here is optional convenience over the generic setup in the
[README](../README.md) — understory only ever sees OpenAI-compatible endpoints. If
you already run llama-server elsewhere, the same env vars apply; only the URLs change.

- [Topology](#topology)
- [Serving the models (llama.cpp)](#serving-the-models-llamacpp)
- [Thinking mode](#thinking-mode)
- [vLLM alternative](#vllm-alternative)
- [Running understory](#running-understory)
- [Environment reference](#environment-reference)
- [Native modules & the search index](#native-modules--the-search-index)
- [Git as backup](#git-as-backup)

## Topology

```
┌─────────────────────────── DGX Spark (host, ARM64) ───────────────────────────┐
│                                                                                │
│   llama-server (chat)          llama-server (embeddings)                       │
│   Qwen3.6-35B-A3B  :8080       Qwen3-Embedding-0.6B  :8081                     │
│        ▲                              ▲                                        │
│        │ /v1/chat/completions         │ /v1/embeddings                        │
│        │                              │                                        │
│   ┌────┴──────────────────────────────┴────┐                                  │
│   │  understory container                   │   host.docker.internal:8080     │
│   │  (ghcr.io/thecodacus/understory:latest) │   host.docker.internal:8081     │
│   │  :3800  web + /api + /mcp               │                                 │
│   │  /bundle  ← named volume (OKF markdown) │                                 │
│   └─────────────────────────────────────────┘                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Chat model** on `:8080` — drives the librarian agent (search / read / write tool loop).
- **Embedding model** on `:8081` — powers the vector tier of hybrid search. Optional;
  without it, search stays FTS/BM25-only and still works.
- The container reaches both through `host.docker.internal`, which
  `docker-compose.spark.yml` maps to the host gateway via
  `extra_hosts: ["host.docker.internal:host-gateway"]`.

### One-port alternative: llama-swap

You don't need two processes. [llama-swap](https://github.com/mostlygeek/llama-swap)
can front a single port and hot-swap models on demand. Point both
`LLM_API_BASE_URL` and `LLM_EMBEDDING_API_BASE_URL` at the same llama-swap URL:
understory's `/v1/models` discovery **prefers the model reported as `loaded`**
(see `discoverLlamaCppModel` in `packages/core/src/providers/index.ts`), so a query
uses whatever is currently resident instead of forcing a multi-minute swap. That
makes llama-swap work out of the box — no model ids to pin. (Pin one anyway with
`LLM_MODEL=` / `LLM_EMBEDDING_MODEL=` if you want deterministic routing.)

## Serving the models (llama.cpp)

llama.cpp ships CUDA ARM64 builds that use the Spark's unified memory. The GB10's
128 GB is shared between CPU and GPU, so the chat model, its KV cache, and the
embedding model all draw from the same pool — size the context window with that
budget in mind.

### Chat model — Qwen3.6-35B-A3B on :8080

```bash
llama-server \
  -m Qwen3.6-35B-A3B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  --jinja \                 # REQUIRED: enables the model's chat template → OpenAI tool calling
  --ctx-size 32768 \        # see sizing note below
  --n-gpu-layers 999 \      # offload everything to the GPU (unified memory)
  --flash-attn
```

- `--jinja` is **required** — it activates the model's own chat template, which is
  what turns understory's tool definitions into working OpenAI-style tool calls (and
  is also what makes `chat_template_kwargs.enable_thinking` do anything; see
  [Thinking mode](#thinking-mode)).
- **Context sizing for 128 GB unified memory.** A3B is a Mixture-of-Experts model:
  ~35 B total weights, ~3 B active per token, so it is fast but the full weight set
  still sits in memory. At Q4_K_M the weights are roughly 20–22 GB. That leaves plenty
  of headroom for context on a 128 GB box — `--ctx-size 32768` is a comfortable start,
  and you can push to 65536+ if your workload needs it, watching the KV-cache growth
  (larger with longer context). understory keeps its own prompt bounded with
  `UNDERSTORY_TREE_BUDGET`, so you rarely need a huge window just for the agent; give
  the extra room to embeddings and headroom rather than over-allocating KV cache.
- `--n-gpu-layers 999` offloads all layers; on unified memory there is no host↔device
  copy penalty, so full offload is the norm.

### Embedding model — on :8081

```bash
llama-server \
  -m Qwen3-Embedding-0.6B-Q8_0.gguf \   # or nomic-embed-text-v1.5
  --host 0.0.0.0 --port 8081 \
  --embedding \             # REQUIRED: serve /v1/embeddings instead of chat
  --ctx-size 8192 \
  --n-gpu-layers 999
```

- `--embedding` switches the server into embedding mode, exposing
  `POST /v1/embeddings`. This is the endpoint understory's vector tier calls
  (`embedTexts` → plain fetch POST; see `packages/core/src/providers/index.ts`).
- Any small embedding model works: **Qwen3-Embedding-0.6B** pairs naturally with the
  Qwen chat model; **nomic-embed-text-v1.5** is a common alternative. understory
  learns the vector dimensionality from the first response (`LLM_EMBEDDING_DIMS` left
  blank), and stamps the endpoint/model/dims as an embedder identity — changing any of
  them transparently rebuilds the vector index.
- 0.6 GB at Q8 is negligible next to the chat model; both fit the unified pool easily.

## Thinking mode

Qwen3.6 is a hybrid reasoning model: thinking can be toggled per request. understory
exposes this per **task mode** through `LLM_THINKING` — a CSV of `query`, `mutate`,
`chat`, `maintain` (or `*` for all). The recommended split is **thinking ON for
`mutate` and `maintain`, OFF for `query` and `chat`**: writes and graph maintenance
benefit from deliberation; reads and conversational turns should stay fast.

```bash
LLM_THINKING=mutate,maintain
```

### How the toggle reaches llama.cpp

For an **OpenAI-format** endpoint (llama.cpp, vLLM), understory injects
`chat_template_kwargs: { enable_thinking: true }` into the request body when thinking
is enabled for the current mode. This is done by a wrapping fetch that shallow-merges
the extra keys into the outgoing POST JSON (`makeBodyInjectingFetch` /
`openaiThinkingBody` in `packages/core/src/providers/index.ts`) — it does not rely on
the AI SDK forwarding unknown keys, so it works regardless of SDK internals. The Qwen
chat template reads `enable_thinking` and emits (or suppresses) the `<think>` block
accordingly. `--jinja` must be on for the template — and therefore this switch — to
take effect.

For an **Anthropic-format** endpoint, thinking instead rides call-time
`providerOptions` with `LLM_THINKING_BUDGET` as the token budget
(`anthropicThinkingOptions`). Mixed chains are safe: the Anthropic option is
namespaced and an OpenAI model in the chain simply ignores it, and vice versa.

### Temperature and thinking

When thinking is enabled for mutations, set `LLM_MUTATION_TEMPERATURE` to **~0.6**
rather than the default `0.2`. Qwen's own guidance is that combining a low temperature
with thinking risks repetition loops in the generated reasoning; a moderate
temperature avoids that. `docker-compose.spark.yml` defaults this to `0.6` for exactly
this reason.

```bash
LLM_THINKING=mutate,maintain
LLM_MUTATION_TEMPERATURE=0.6
```

### The escape hatch: LLM_EXTRA_BODY

`LLM_EXTRA_BODY` is a JSON object shallow-merged into every OpenAI-format request body,
after the thinking keys. Use it to pass model- or server-specific parameters understory
doesn't model directly — sampling knobs, custom `chat_template_kwargs`, etc.:

```bash
LLM_EXTRA_BODY={"top_p":0.8,"top_k":20,"chat_template_kwargs":{"enable_thinking":true}}
```

Because it merges last, `LLM_EXTRA_BODY` can override understory's own keys (including
`enable_thinking`) if you need full manual control. `LLM_REASONING_EFFORT`, if set, is
also included in the OpenAI-format body as `reasoning_effort`.

## vLLM alternative

vLLM also serves an OpenAI-compatible API on `/v1`, so the understory side is
**identical** — same env vars, same URLs. Only the server invocation changes:

```bash
vllm serve Qwen/Qwen3.6-35B-A3B \
  --host 0.0.0.0 --port 8080 \
  --enable-auto-tool-choice \          # REQUIRED for tool calling
  --tool-call-parser hermes \          # match the parser to the model family
  --max-model-len 32768
```

- `--enable-auto-tool-choice` plus a matching `--tool-call-parser` is vLLM's
  equivalent of llama.cpp's `--jinja` for tool calling — without it, the model's tool
  calls aren't parsed out of the response and understory's agent loop stalls. Pick the
  parser for your model family (Qwen typically uses the `hermes` parser; check the vLLM
  docs for the current recommendation).
- Thinking still travels as `chat_template_kwargs.enable_thinking` in the request body,
  which vLLM honors when the model's chat template supports it — so `LLM_THINKING` works
  unchanged.
- Serve embeddings with a second vLLM instance (`vllm serve <embedding-model>
  --task embed --port 8081`) or keep llama.cpp for that side; understory doesn't care
  which server answers `/v1/embeddings`.

## Running understory

Use [`docker-compose.spark.yml`](../docker-compose.spark.yml) at the repo root. It is
the Portainer/GHCR stack plus the Spark specifics: `extra_hosts` for
`host.docker.internal`, host-pointed chat/embedding URLs, `LLM_THINKING=mutate,maintain`,
`LLM_MUTATION_TEMPERATURE=0.6`, `GIT_AUTOCOMMIT=true`, and a **required** `AUTH_TOKEN`.

```bash
# Generate an auth token (required by the compose file):
export AUTH_TOKEN=$(openssl rand -hex 24)

# Validate the merged config, then start:
docker compose -f docker-compose.spark.yml config
docker compose -f docker-compose.spark.yml up -d
```

Then:

- **Web UI** → `http://<spark>:3800` (prompts for the auth token)
- **MCP endpoint** → `http://<spark>:3800/mcp` with an `Authorization: Bearer <token>` header
- Check wiring at `http://<spark>:3800/api/config` — it reports the resolved model,
  whether a fallback is configured, the active `search` tier, and `embeddingWarm`.

Every variable in the compose file uses `${VAR:-default}` passthrough, so you can
override any of them from the shell environment or an `.env` file without editing the
compose. `AUTH_TOKEN` uses `${AUTH_TOKEN:?...}` — the stack refuses to start until you
set it.

## Environment reference

Defaults below are what understory's code applies when the variable is unset (not the
`docker-compose.spark.yml` defaults, which differ where noted). Cross-checked against
`packages/core/src/providers/index.ts`, `packages/core/src/agent/agent.ts`,
`packages/core/src/agent/tools.ts`, and `packages/server/src/index.ts`.

### Server

| Variable | Default | Description |
|---|---|---|
| `BUNDLE_ROOT` | — (**required**) | Path to the OKF bundle directory the agent manages. In-container: `/bundle`. |
| `PORT` | `3800` | HTTP port for the web UI, `/api`, and `/mcp`. |
| `AUTH_TOKEN` | unset (open) | If set, `/mcp` and `/api` require `Authorization: Bearer <token>`. The static web UI stays reachable and prompts for it. Set this before exposing understory beyond localhost. |
| `GIT_AUTOCOMMIT` | `false` | `true` commits every bundle mutation to git (local only — see [Git as backup](#git-as-backup)). |

### Primary model

| Variable | Default | Description |
|---|---|---|
| `LLM_API_BASE_URL` | — | OpenAI- or Anthropic-compatible base URL. Presence selects the generic provider path. On Spark: `http://host.docker.internal:8080`. |
| `LLM_API_KEY` | `not-needed` | API key/bearer for the endpoint. Local llama.cpp ignores it. |
| `LLM_API_FORMAT` | `openai` | `openai` or `anthropic`. |
| `LLM_MODEL` | `""` | Model id to request. Empty → discovered from `/v1/models` (OpenAI format only; prefers the `loaded` model). |

### Fallback model (optional)

| Variable | Default | Description |
|---|---|---|
| `LLM_FALLBACK_API_BASE_URL` | unset (disabled) | Base URL of a fallback model used when the primary fails with a retryable error. Empty disables fallback. |
| `LLM_FALLBACK_API_KEY` | `not-needed` | Fallback endpoint key. |
| `LLM_FALLBACK_API_FORMAT` | `openai` | `openai` or `anthropic`. |
| `LLM_FALLBACK_MODEL` | `""` | Fallback model id (same discovery rules as `LLM_MODEL`). |
| `LLM_FALLBACK_ALLOW_FOR` | unset → all modes | CSV of modes (`query,mutate,chat,maintain`) or `*` that are allowed to fall back. Unset or `*` = no restriction. The Spark compose defaults it to `query` (read-only failover). |
| `LLM_FALLBACK_RETRY_429` | `false` | `true` also fails over on `429` (rate-limit) responses, not just timeouts/5xx. |

### Agent tuning

| Variable | Default | Description |
|---|---|---|
| `LLM_MAX_STEPS` | `12` | Max tool-calling steps per agent run. |
| `LLM_MUTATION_TEMPERATURE` | `0.2` | Sampling temperature for mutations. Use `~0.6` when thinking is enabled for mutations (Qwen: low temp + thinking risks repetition loops). Spark compose defaults to `0.6`. |

### Thinking / reasoning

| Variable | Default | Description |
|---|---|---|
| `LLM_THINKING` | unset (off) | CSV of task modes to enable thinking for (`query,mutate,chat,maintain`) or `*`. Recommended: `mutate,maintain`. |
| `LLM_THINKING_BUDGET` | `8000` | Anthropic-format thinking token budget (ignored by OpenAI-format endpoints). |
| `LLM_REASONING_EFFORT` | unset | OpenAI-format `reasoning_effort` (e.g. `low` / `medium` / `high`) injected into the request body when set. |
| `LLM_EXTRA_BODY` | unset | JSON object shallow-merged (last) into every OpenAI-format request body. Escape hatch for arbitrary params, including custom `chat_template_kwargs`. |

### Prompt sizing

| Variable | Default | Description |
|---|---|---|
| `UNDERSTORY_TREE_BUDGET` | `4000` | Character budget for the bundle tree in the system prompt. Past this, the tree degrades to a directory overview so the prompt stays bounded as the memory grows. |

### Hybrid search: embeddings (vector tier)

| Variable | Default | Description |
|---|---|---|
| `LLM_EMBEDDING_API_BASE_URL` | unset → FTS-only | OpenAI-compatible `/v1/embeddings` base URL. Presence enables the vector tier. On Spark: `http://host.docker.internal:8081`. |
| `LLM_EMBEDDING_API_KEY` | `not-needed` | Embedding endpoint key. |
| `LLM_EMBEDDING_MODEL` | `""` | Embedding model id. Empty → discovered from `/v1/models`. |
| `LLM_EMBEDDING_DIMS` | learned | Embedding dimensionality. Empty → learned from the first response. |

### Legacy (deprecated, still honored)

`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
`LLAMACPP_BASE_URL`, `LLAMACPP_API_KEY`, `LOCAL_BASE_URL`, `LOCAL_API_KEY` — mapped
automatically to the `LLM_API_*` path. Prefer the `LLM_API_*` variables above.

## Native modules & the search index

The image is built on `node:22-slim` — **Debian, glibc** (not Alpine/musl). This is
deliberate: `better-sqlite3` and `sqlite-vec` ship glibc prebuilt binaries for
`linux-arm64`, so on the Spark they install without a source build under emulation.
The Dockerfile smoke-checks the binding at build time (`node -e
"require('better-sqlite3')"`), so a broken native install fails the build rather than
degrading silently at runtime.

At startup understory logs which search tier came up:

- `[understory] search index: fts` — the SQLite index opened; full-text (BM25) search
  is active.
- `[understory] search index: hybrid (embedding worker started)` — the index opened
  **and** an embedding endpoint was configured, so vectors warm in the background and
  search fuses BM25 + semantic results.
- `[understory] search index: naive-fallback (...)` — the native index could not open
  (missing binding, corrupt DB, etc.); understory falls back to the in-process naive
  scan. The librarian's tool surface is unchanged — search still works, just without
  BM25/vector ranking. The parenthetical gives the reason.

For debugging, `GET /api/config` reports the live `search` tier
(`"naive" | "fts" | "hybrid"`) and `embeddingWarm` (whether the background vector
warm-up has finished). Immediately after start, expect `search: "hybrid"` with
`embeddingWarm: false`, flipping to `true` once the bundle's vectors are embedded.

## Git as backup

`GIT_AUTOCOMMIT=true` commits every mutation to the bundle's git repo — but **only
locally**. It is a change log and undo history, **not** a backup: a lost disk or
deleted volume takes the commits with it. For real durability, add a remote and a push
policy. Two simple options:

**Cron'd push from the host** (bundle on a bind mount, or `docker exec` into the
container):

```bash
# crontab -e — push the bundle every 15 minutes
*/15 * * * * cd /srv/okf-bundle && git push origin HEAD >/dev/null 2>&1
```

**A bare repo on another host** as the remote:

```bash
# on the backup host, once:
git init --bare /srv/backups/okf-bundle.git

# in the bundle, once:
git remote add backup ssh://backup-host/srv/backups/okf-bundle.git

# then push (from cron, a systemd timer, or a git post-commit hook)
git push backup HEAD
```

Either way the goal is the same: get the auto-committed history off the Spark on a
schedule so the markdown — the sole source of truth — survives hardware loss.
