# understory: scaling, history, and hybrid-search implementation plan (DGX Spark target)

## Context

understory is a self-wiring plain-markdown memory (OKF bundle) driven by an internal "librarian" LLM agent, exposed via MCP/Web UI/CLI. The user will run it on a DGX Spark (GB10, 128GB unified, ARM64) with Qwen3.6-35B-A3B served by llama.cpp/vLLM.

A technical review surfaced nine issues, discussed and settled with the user:
1. **Lossy supersession** — history (log.md/git/traces) exists but is not agent-queryable.
2. **Segmentation fossilizes** — no taxonomy lint / move tool (deferred; not in this build).
3. **Seed decay** — 3,000-char blind truncation + alphabetical sampling.
4. **No aggregate observability** — trace replay ships; stats don't.
5. **O(N) costs** — uncapped full tree in every system prompt (first real cliff); double full-bundle scan per run; whole-bundle re-read per write (index regen); log.md rewritten per append.
6. **Hybrid search (QMD-style)** — biggest architectural win; behind the existing `search_knowledge` contract.
7. **Thinking mode** — per-mode budgets (ON mutate/maintain, OFF query/chat); mutation temperature currently hardcoded 0.2.
8. **No Go/Rust rewrite** (settled: no).
9. **`.events.jsonl` system of record**; log.md becomes a derived projection.

**User decisions:** Full build on branch `claude/dgx-spark-technical-review-u6dkyn`; hybrid search native in-repo (better-sqlite3 + FTS5 + sqlite-vec), embeddings via OpenAI-compatible `/v1/embeddings` endpoint (llama-server on the Spark), NOT in-process GGUF; include DGX Spark deployment config + docs.

**Design principles:** conformance/recall in code, not prompts; markdown bundle is sole source of truth; derived state (`.index/`, `.traces/`) disposable and gitignored by the system itself; content-hash (never mtime) staleness; tiered degradation (FTS-first → embeddings warm in background → naive scan as last resort); OKF surface stays conformant. Each phase ships independently green on `pnpm -r build && pnpm test` (vitest; okf.test.ts temp-dir pattern, providers.test.ts env-injection pattern).

**One deviation from discussion, deliberate:** no log.md monthly rotation — sibling `log-YYYY-MM.md` files would be walked as concepts and fail §9 validation (RESERVED_FILENAMES is exact). log.md stays a full derived projection; if size ever forces it, archive into dot-dir `/.log-archive/` (walkers skip dotfiles).

---

## Phase 1 — Event stream, derived log, git hygiene (foundation)

**New `packages/core/src/okf/events.ts`:**
- `KnowledgeEvent { ts: ISO string; action: LogAction; path; summary; supersedes?; traceId?; modelChain?[] }` — one JSON object per line in `<bundle>/.events.jsonl`; readers tolerate unknown keys and skip corrupt lines.
- `appendEvent(bundle, ev)` — `fs.appendFile`, O(1).
- `readEvents(bundle, filter?: {pathContains?, action?, since?, until?, limit=50})` — newest-first.
- `backfillEventsFromLog(bundle)` — one-time synthesis from legacy log.md (reuse readLog regex; `ts = date + "T00:00:00.000Z"`).

**Modify `okf/logger.ts`:** add `projectLog(bundle, events)` regenerating log.md byte-compatible with today's format (`# Directory Update Log`, `## YYYY-MM-DD`, `* **Action**: summary`, newest-first). `readLog` prefers events, falls back to legacy regex parse.

**Modify `okf/knowledge-base.ts`:**
- Mutation methods gain optional trailing `meta?: {traceId?, modelChain?}`; `afterMutation` order: `appendEvent` → `projectLog` → `regenerateIndexChain` → git.
- Public `readEvents(filter?)` (needed by P2 seed, P5 tool, P6 stats).
- Lazy init: `backfillEventsFromLog`; when `gitAutocommit`, `ensureGitignore()` — idempotently appends `.index/`, `.traces/` to `<bundle>/.gitignore`. Keep `git.add(".")` (correct once ignored). `.events.jsonl` IS committed (append-only, clean diffs).

**Modify `agent/trace.ts` + `tools.ts` + `agent.ts`:** move trace id generation to `TraceRecorder` constructor (`readonly id`; format unchanged, still matches TraceStore's `^[a-z0-9-]+$`); `buildWriteTools(kb, filesChanged, trace?, meta?)` passes `{traceId, modelChain}` into KB mutations.

**Tests (`core/test/events.test.ts`, temp-dir pattern):** append/read round-trip with filters + newest-first; log.md projection byte-format equivalence; legacy fallback + backfill; corrupt-line tolerance; gitignore creation in a `simpleGit(root).init()` temp repo.

---

## Phase 2 — Scaling caps + config knobs

**2a. Altitude-adaptive tree (`agent/tools.ts`, `system-prompt.ts`, `agent.ts`):**
- `formatTreeAdaptive(tree, budgetChars = env UNDERSTORY_TREE_BUDGET ?? 4000): {text, degraded, conceptCount}` — full listing when under budget; else one line per directory (`dir/ — N concepts (Type A, Type B)`), depth-capped if still over.
- When degraded, system prompt appends: "memory is large; this is only a directory overview — ALWAYS search before concluding anything about contents."
- Use it also in the `search_knowledge` miss-path and `list_directory` (no full-tree dumps in tool results).

**2b. Seed altitude (`server/src/mcp/seed.ts`):** replace blind slice + alphabetical sampling. Rank descriptions per segment by recency (from `kb.readEvents`) + inbound-link degree (from `kb.graph()` node `links`); if over `MAX_SEED_CHARS`, rebuild at degraded altitude (counts+types+top-3 descriptions per segment) instead of mid-word truncation. `buildSeedMemory(kb)` signature unchanged.

**2c. Memoized scans (`okf/knowledge-base.ts`):** `generation` counter (++ per mutation) + 30s-TTL read cache wrapping `listTree`/`listTypes`/`graph` (TTL guards out-of-band edits). Kills the per-run double full scan.

**2d. Incremental index regen (`okf/indexer.ts`):** `IndexCache` of per-directory `DirSummary {count, types, titles}` owned by KnowledgeBase, invalidated along the touched chain only; `summarizeDirectory` consults it before walking. `cache` param optional — existing callers/tests unchanged. Equivalence-test against from-scratch regen.

**2e. Config knobs + thinking (`agent/agent.ts`, `providers/index.ts`, `server/src/mcp/server.ts`):**
- `LLM_MAX_STEPS` (default 12), `LLM_MUTATION_TEMPERATURE` (default 0.2), resolved per call with env-param injection for tests.
- Thread mode `"maintain"`: `runMutation` gains `options.kind: "mutate"|"maintain"`; `memory_maintain` passes it; system prompt still gets `"mutate"`.
- `LLM_THINKING` (csv of query,mutate,chat,maintain or `*`) → `resolveThinking(env, mode)`. Provider options via `thinkingProviderOptions(enabled, env)`: anthropic `{thinking:{type:"enabled", budgetTokens: LLM_THINKING_BUDGET ?? 8000}}`; openai-compatible — **primary implementation: body-injecting fetch** `makeBodyInjectingFetch(() => extraBody)` passed to `createOpenAICompatible` (merges e.g. `{chat_template_kwargs:{enable_thinking:true}}` + user `LLM_EXTRA_BODY` JSON env into POST bodies) since `@ai-sdk/openai-compatible` passthrough of unknown keys is unverified (RISK #1 — first step: `pnpm install` and inspect its dist for providerOptions handling; use SDK-native path if it works).
- New env vars added to both compose files: `LLM_MAX_STEPS`, `LLM_MUTATION_TEMPERATURE`, `LLM_THINKING`, `LLM_THINKING_BUDGET`, `LLM_REASONING_EFFORT`, `LLM_EXTRA_BODY`, `UNDERSTORY_TREE_BUDGET`.

**Tests:** `core/test/agent-config.test.ts` (env-injection; `resolveThinking` matrix; fetch-body merge via `vi.stubGlobal`); `formatTreeAdaptive` degradation on synthetic 200-concept tree; indexer equivalence; `server/test/seed.test.ts` (budget respected, high-degree description survives, no mid-word cuts).

---

## Phase 3 — Hybrid search: FTS tier (+ Docker base switch first)

**3a. Docker base → `node:22-slim` (both stages).** better-sqlite3 ships glibc prebuilds for linux-x64/arm64 but NOT musl; alpine would force source builds under qemu on arm64 (RISK #3). Add build-stage smoke check `RUN node -e "require('better-sqlite3')"`. ~50MB size cost accepted.

**3b. Deps (`core/package.json`):** `better-sqlite3 ^12`, `sqlite-vec ^0.1` (pin exactly; RISK #8 — 0.1.x query-syntax drift), dev `@types/better-sqlite3`. ALL loading via dynamic `await import(...)` in try/catch — naive scan remains the universal fallback.

**3c. New `packages/core/src/index/`:**
- `db.ts` — `openIndexDb(bundleRoot): Promise<IndexDb|null>` → `<bundle>/.index/index.db`, WAL, idempotent DDL, `sqlite-vec` load attempt → `vecAvailable`; any failure → warn once, null. Schema-version mismatch → drop and rebuild (derived/disposable). Tables: `meta(key,value)` (schema_version, embedder_id, embedder_dims); `files(path PK, hash sha256, type, title, description, tags JSON, indexed_at)`; `fts` = FTS5(path UNINDEXED, title, description, tags, body, porter unicode61); `chunks(id, path, seq, text, embedded)` (populated P4); `vec0` virtual table created in P4 when dims known.
- `sync.ts` — `syncIndex(bundle, idx)`: sha256 content-hash diff against `files` (NOT mtime — git checkout mangles mtimes); transactional upserts/deletes across files/fts/chunks.
- `fts-search.ts` — `ftsSearch(idx, query, options)`: terms double-quoted/escaped OR-joined MATCH (punctuation-safe); `bm25(fts, 8,4,2,2,1)` column weights mirroring the naive scan's title>description/tags>body ranking; `score = -rank`; snippet via `snippet()`; type filter in SQL, tags post-filtered; empty-query browse mode routes around MATCH (FTS5 errors on empty MATCH).
- `search-index.ts` — `SearchIndex` facade: `open` (openIndexDb + synchronous initial FTS sync — fast), `afterMutation()` (hash-diff resync), `search()`, `close()`.

**3d. Wire into `okf/knowledge-base.ts`:** lazy `SearchIndex` init; `search()` = index if available else `searchBundle`, with try/catch fallback preserving the exact `SearchHit` contract (`path/type/title/description/snippet/score`) — **the librarian's tool surface does not change**. Startup log line: `[understory] search index: fts|naive-fallback`.

**Tests (`core/test/index.test.ts`, `describe.skipIf(!canNative)`):** ranking (title beats body); filters; browse mode; hash-sync proof (out-of-band edit with mtime restored via `utimes` still detected); out-of-band delete; corrupted-DB fallback + rebuild; query-syntax safety (`'billing" OR x('` doesn't throw).

---

## Phase 4 — Vector tier: embeddings, RRF, background warm-up

**4a. Embedding provider (`providers/index.ts`):** `resolveEmbeddingConfig(env)` — `LLM_EMBEDDING_API_BASE_URL` (enables), `LLM_EMBEDDING_API_KEY`, `LLM_EMBEDDING_MODEL` (default: /v1/models discovery, reuse existing), `LLM_EMBEDDING_DIMS` (else learned from first response). `embedTexts(cfg, texts)` via `createOpenAICompatible(...).textEmbeddingModel` + ai `embedMany`, or plain fetch to `/v1/embeddings` if the SDK fights. Embedder identity `baseURL|model|dims` stamped in `meta`; mismatch → drop vec table, reset `chunks.embedded=0`, recreate with new dims (RISK #2: verify sqlite-vec linux-arm64 glibc prebuild exists; degrade to BM25-only if extension load fails — already the code path).

**4b. New in `core/src/index/`:**
- `chunk.ts` — split body on H1 headings, sub-split >~1400 chars on paragraphs, prefix each chunk with `title — description:` identity, cap ~24/concept.
- `embedder.ts` — `EmbedWorker`: background drain loop (batches of 16 → `embedTexts` → transactional `vec` inserts + `embedded=1`), `kick()` after every sync, `warm` getter, query-embedding LRU(32), exponential backoff on endpoint errors, never crashes the process.
- `hybrid.ts` — `rrfFuse(rankedLists, k=60)` (pure, unit-testable) + `hybridSearch`: BM25 top-50 always; if warm && vecAvailable && non-empty query, KNN top-50 path-level (`MIN(distance) GROUP BY path`), fuse ranks, take limit; before warm → identical to P3 BM25-only. Tiered degradation is the invariant.
- `search-index.ts` owns the worker; `KnowledgeBase.close()` added (stop worker, close DB) — called from server shutdown and test teardown.
- `GET /api/config` gains `search: "naive"|"fts"|"hybrid"`, `embeddingWarm`. `search_knowledge` description notes semantic matching when active.
- New env vars (+ compose): `LLM_EMBEDDING_API_BASE_URL/KEY/MODEL/DIMS`.

**Tests:** `rrfFuse` pure units; `chunkConcept`; stubbed-fetch deterministic vectors — planted semantic match ("car"→"automobile" doc) that BM25 misses is found post-warm and NOT pre-warm; embedder-identity change resets vec; skipIf on extension unavailability.

---

## Phase 5 — History tool + Event-concept rule

- `agent/tools.ts` `buildReadTools` += `read_history` tool (filters: path_contains, action enum, since/until, limit≤200) → `kb.readEvents`, returning `{ts, action, path, summary}` (omit traceId/modelChain noise). Trace-notation case added (`history (N)`).
- `server/src/mcp/server.ts` += deterministic `memory_history` MCP tool (same filters, direct `kb.readEvents`, no LLM — parity with `memory_status`).
- `agent/system-prompt.ts` MUTATE protocol += rule: meaningful state changes (move, launch, reversal, role change) additionally get an Event-typed concept under `/events/` with a `date` frontmatter field, describing from→to, linked both ways; the updated concept states the new truth, the Event preserves that the change happened.
- Optional if cheap: lint warning for `type: Event` concepts missing `date`.

**Tests:** `core/test/tools.test.ts` — call `buildReadTools(kb).read_history.execute!(...)` directly against a temp KB; assert filtering/shape.

---

## Phase 6 — Observability: GET /api/stats + StatsView

- New `server/src/api/stats.ts` — `statsRouter(kb)` mounting `GET /stats`: traces block (total, byKind, byOutcome, steps/durationMs avg+p50+p95, byModelChain with failure counts — from `TraceStore.list()`, ≤50 entries) + events block (total, byAction, perDay last 30d, top-10 most-touched paths — from `kb.readEvents({limit: 10_000})`). Pure helpers `aggregateTraces`/`aggregateEvents` exported for tests. Mount in `server/src/index.ts`.
- Web: `web/src/components/StatsView.tsx` (definition list + pure-div 30-day bar strip, no chart dep), `App.tsx` View union + toolbar button, `api.ts` fetcher.

**Tests:** `server/test/stats.test.ts` — synthetic arrays through the aggregators; fixed dates (no clock dependence).

---

## Phase 7 — DGX Spark deployment

- **New `docs/DGX-SPARK.md`:** topology (understory container + host llama-server chat :8080 + embeddings :8081, or llama-swap — discovery already prefers loaded model); llama-server invocations for Qwen3.6-35B-A3B (`--jinja`, ctx sizing, thinking via `chat_template_kwargs` ↔ `LLM_THINKING`/`LLM_EXTRA_BODY`) and an embedding model (`--embedding`, e.g. Qwen3-Embedding-0.6B); vLLM alternative; full env reference table; glibc/native-module note and what `search index: fts` vs `naive-fallback` means; git-as-backup note (autocommit is local-only — remote + push policy needed for real backup).
- **New `docker-compose.spark.yml`:** ghcr image + named volume base, `extra_hosts: host.docker.internal:host-gateway`, example `LLM_API_BASE_URL=http://host.docker.internal:8080`, embedding URL, `LLM_THINKING=mutate,maintain`, fallback block, `GIT_AUTOCOMMIT=true`, `AUTH_TOKEN` required, all new env vars with `${VAR:-default}`.

**Verify:** `docker compose -f docker-compose.spark.yml config`; end-to-end on arm64: pull, point at llama-server, `memory_add` + paraphrased `memory_query`, check `/api/stats`.

---

## Risk register (fallback per item)

1. `@ai-sdk/openai-compatible` providerOptions passthrough unverified → body-injecting fetch is the primary path (works regardless).
2. sqlite-vec linux-arm64 glibc prebuild → verify at install; degrade to BM25-only; worst case vendor `vec0.so`.
3. better-sqlite3 musl → mooted by node:22-slim switch; build-stage smoke check.
4. OKF §7 rotation → not doing rotation (see deviation note).
5. Trace-id refactor → verified nothing depends on finalize-time generation.
6. Memoization vs out-of-band edits → 30s TTL + content-hash resync.
7. FTS5 availability → bundled SQLite in better-sqlite3 has FTS5; openIndexDb try/catch covers surprises.
8. sqlite-vec 0.1.x KNN syntax drift → pin exact version, lock query form in a test.

## Critical files

- `packages/core/src/okf/knowledge-base.ts` (P1–P4: events, gitignore, memoization, index cache, SearchIndex)
- `packages/core/src/okf/events.ts` (new — the schema everything downstream depends on)
- `packages/core/src/agent/agent.ts` (knobs, thinking, maintain mode, meta threading)
- `packages/core/src/agent/tools.ts` (adaptive tree, read_history, write-tool meta)
- `packages/core/src/providers/index.ts` (thinking fetch injection, embedding config)
- `packages/core/src/index/*` (new — db/sync/fts-search/chunk/embedder/hybrid/search-index)
- `packages/server/src/mcp/seed.ts`, `packages/server/src/api/stats.ts`, `Dockerfile`, `docs/DGX-SPARK.md`, `docker-compose.spark.yml`

## Execution strategy (multi-agent, per user direction)

**Integration branch:** `claude/dgx-spark-technical-review-u6dkyn` (the designated branch). Per-phase work happens on child branches `claude/dgx-spark-p<N>-<slug>` cut from the integration branch; each phase is PR'd into the **integration branch** (never main), merged only after verifier sign-off. Final push of the integration branch when all phases land.

**Per phase, three roles:**
1. **Builder agent (Opus, worktree isolation):** implements the phase exactly per this plan, writes the phase's tests, runs `pnpm -r build && pnpm test` until green, commits with descriptive messages, pushes its branch, opens the PR into the integration branch. Reports what it built — its assertions are treated as claims, not evidence.
2. **Verifier agent (Opus, fresh context, worktree on the PR branch):** receives ONLY the phase's acceptance criteria from this plan + the PR diff — not the builder's self-report. Must independently: run build + full test suite; exercise behavior beyond the builder's tests (e.g. P1: mutate a temp bundle and inspect `.events.jsonl`/log.md bytes; P2: assert prompt size stays under budget on a generated 500-concept bundle; P3: out-of-band edit with restored mtime is still re-indexed; P4: paraphrase query hits post-warm and not pre-warm with stubbed vectors; P5/P6: call the tool/endpoint directly); check the phase changed nothing outside its file scope; verify fallback paths (kill the index DB, unset embedding env). Emits a structured findings list (CONFIRMED defects with repro, not style notes).
3. **Fix loop:** builder receives verifier findings, fixes, pushes; verifier re-checks. Max 3 rounds; if still failing, the phase is escalated to me instead of merged. On sign-off: merge the PR into the integration branch.

**Dependency order / parallelism:** P1 first (everything downstream reads events). Then P2 and P3 in parallel — both touch `knowledge-base.ts` (P2c memoization vs P3d SearchIndex wiring), so whichever PR lands second must rebase onto the integration branch before its verifier round. Then P4 (needs P3). Then P5 ∥ P6 (disjoint files; both need P1 only). P7 last (documents env vars from P2/P4). Builders run with `isolation: worktree` so parallel phases never collide in the working tree.

**Final review (me, not delegated):** after all merges — read the full integration-branch diff end-to-end, re-run build/tests, run the server against a sample-bundle copy and smoke the MCP + REST + fallback paths, check cross-phase seams the per-phase verifiers couldn't see (event schema consistency P1↔P5↔P6, env-var docs completeness P2/P4↔P7, knowledge-base.ts merge result). Report all problems found as a numbered list for a follow-up pass — no silent fixes of substantive issues.

## Verification (overall)

Per phase: `pnpm -r build && pnpm test` green, plus the verifier-agent behavioral checks above. After P3/P4: docker build both arches; run against sample-bundle; confirm startup index-status log, `/api/search` paraphrase test, `.events.jsonl` growth, `GET /api/log` shape unchanged. Final: all phase PRs merged into `claude/dgx-spark-technical-review-u6dkyn`, pushed (`git push -u origin`, exponential-backoff retries on network failure).
