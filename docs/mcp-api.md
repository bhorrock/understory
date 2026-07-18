# Understory MCP Server — API Reference

**Package:** `@understory/server` · **MCP server name:** `understory` v0.1.0
**SDK:** `@modelcontextprotocol/sdk` v1.12

Both transports below are built from the same factory:
`buildMcpServer(kb: KnowledgeBase): Promise<McpServer>` (`packages/server/src/mcp/server.ts`).

## Transports

| Transport | Entry point | Notes |
|---|---|---|
| **stdio** | `packages/server/src/mcp/stdio.ts` (bin, e.g. `dist/mcp/stdio.js`) | For local clients (Claude Code/Desktop): `claude mcp add okf-kb -e BUNDLE_ROOT=/path -e ... -- node dist/mcp/stdio.js`. Stdout is reserved for protocol frames; all logs go to stderr. |
| **Streamable HTTP** | `POST` / `GET` / `DELETE` `/mcp` (mounted in `packages/server/src/index.ts`) | **Stateless** — `sessionIdGenerator: undefined`, a fresh `McpServer` + transport is built per request (`enableJsonResponse: true`, one JSON reply per request, no long-lived SSE). The `KnowledgeBase` itself serializes mutations, so statelessness is safe. |

### HTTP-specific details

- CORS: origin reflected (`origin: true`), exposes `Mcp-Session-Id`, allows headers `Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID`.
- Body limit: 4mb (`express.json({ limit: "4mb" })`).
- **Auth (optional, issue #1):** if env var `AUTH_TOKEN` is set, `/mcp` and `/api` require `Authorization: Bearer <AUTH_TOKEN>` (SHA-256 + `timingSafeEqual` comparison, see `packages/server/src/auth.ts`). Missing/invalid → `401` with `WWW-Authenticate: Bearer realm="understory"` and JSON `{ error: "unauthorized: ..." }`. If unset, both endpoints are open (localhost/homelab default). The stdio transport is never gated (it's a local process).

## `initialize` response

The `instructions` field is populated by `seedInstructions(seed)` — a persistent-memory primer plus a live **seed memory** overview (concept types present, per-directory concept descriptions up to 3000 chars, 3 most recent knowledge-log entries). It is regenerated on every mutation via `RegisteredTool.update()`, which emits `tools/list_changed` for long-lived stdio sessions.

## Tools

| Tool | Input schema | Behavior | Output |
|---|---|---|---|
| **`memory_query`** | `question: string` | LLM-agent search over the OKF knowledge base bundle; description is dynamically seeded with the current memory overview and refreshed after every mutation. | `{ content: [{ type: "text", text: answer }] }` |
| **`memory_add`** | `content: string`, `suggested_path?: string` (e.g. `"/apis/payments.md"`) | Wraps content as an explicit "persist this" directive (prevents the agent treating it as chat), runs a mutation agent that searches for overlapping concepts, patches existing ones or creates new ones, and refreshes the seed. | Mutation outcome (see below) |
| **`memory_update`** | `instruction: string` | Natural-language instruction to correct/deprecate/restructure existing knowledge; agent locates concepts and edits them; refreshes the seed. | Mutation outcome |
| **`memory_status`** | *(none)* | Deterministic, no LLM call. Runs `kb.validate()`, `kb.lint()`, `kb.listTypes()` in parallel. | `{ content: [{ type: "text", text: JSON }] }` with `{ conformant, concepts, directories, types, errors, warnings, graph: { links, orphans, brokenLinks, healthy } }` |
| **`memory_maintain`** | *(none)* | Health-check + repair: if `lint()` is already healthy, no-ops. Otherwise builds an instruction listing orphaned concepts and broken links and runs a mutation agent to wire orphans into related concepts / fix or remove broken links (never invents relationships). | Text summary + before/after orphan & broken-link counts + files changed |

### Mutation outcome shape (shared by `memory_add` / `memory_update` / `memory_maintain`)

From `runMutation()` in `@understory/core`, mapped by `mutationOutcomeResponse()`:

- **success** (`outcome.ok`): `content: [text]` = `"{summary}\n\nFiles changed:\n- file1\n- file2"` (or `"- none"`)
- **partial failure** (`outcome.status === "partial"`): `"⚠ Partial mutation: N file(s) written before failure.\nFiles: ...\nError: ..."`
- **failure**: `{ content: [text: "Mutation failed: {error}"], isError: true }`

## Required environment (both transports)

| Var | Required | Purpose |
|---|---|---|
| `BUNDLE_ROOT` | yes | Path to the OKF markdown bundle; process exits if unset. |
| `LLM_API_BASE_URL` + `LLM_API_KEY` (or legacy provider vars) | yes | Resolved via `resolveModelConfig()` / `resolveFallbackConfig()` from `@understory/core`; server fails fast at startup on bad config. Supports a secondary fallback model. |
| `GIT_AUTOCOMMIT` | no | `"true"` enables auto-commit on the KB. |
| `AUTH_TOKEN` | no (HTTP only) | Enables bearer auth on `/mcp` and `/api`. |
| `PORT` | no | HTTP listen port, default `3800`. |
