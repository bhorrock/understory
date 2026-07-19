import { tool } from "ai";
import { z } from "zod";
import type { KnowledgeBase } from "../okf/index.js";
import type { LogAction, TreeNode } from "../okf/types.js";
import type { TraceRecorder } from "./trace.js";

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
const conceptPath = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

/** The three mutation kinds recorded in the event stream. */
const logAction: z.ZodType<LogAction> = z.enum(["Creation", "Update", "Deletion"]);

const logSummary = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

export function buildReadTools(kb: KnowledgeBase, trace?: TraceRecorder) {
  return {
    search_knowledge: tool({
      description:
        "Search the knowledge base by keywords, optionally filtered by concept type and/or tags. Returns ranked hits with paths and snippets. NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to search for. May be empty when filtering by type/tags only."),
        type: z.string().optional().describe("Exact concept type filter"),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
      }),
      execute: async ({ query, type, tags }) => {
        const hits = await kb.search(query, { type, tags });
        trace?.record("search_knowledge", query, hits.map((h) => h.path));
        if (hits.length > 0) return hits;
        // Keyword miss ≠ knowledge absent. Put the map in the tool result so
        // the model's next step is to read plausible concepts, not give up.
        // Adaptive so a huge bundle degrades to a directory overview here too.
        const tree = formatTreeAdaptive(await kb.listTree()).text;
        return {
          hits: [],
          notice:
            "No keyword matches — but this search is literal, not semantic. The knowledge may exist under different wording. Before concluding it is absent: (1) retry with 1-2 synonyms or broader terms, (2) review the layout below and read_concept ANY concept whose type, name, or description could plausibly relate to the question.",
          bundle_layout: tree,
        };
      },
    }),
    read_concept: tool({
      description: "Read one concept document in full: frontmatter and markdown body.",
      inputSchema: z.object({ path: conceptPath }),
      execute: async ({ path }) => {
        const c = await kb.readConcept(path);
        trace?.record("read_concept", c.path, [c.path]);
        return { path: c.path, frontmatter: c.frontmatter, body: c.body };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types/titles/descriptions. Use to understand structure and decide where new concepts belong.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("list_directory", "", []);
        return formatTreeAdaptive(await kb.listTree()).text;
      },
    }),
    lint_knowledge: tool({
      description:
        "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("lint_knowledge", "", []);
        return kb.lint();
      },
    }),
    read_history: tool({
      description:
        "Read the knowledge base's mutation history (append-only event log): when concepts were created/updated/deleted and why. Use for 'when did X change', 'what happened recently', supersession questions.",
      inputSchema: z.object({
        path_contains: z
          .string()
          .optional()
          .describe("Only events whose concept path contains this substring"),
        action: logAction.optional().describe("Filter by mutation kind"),
        since: z.string().optional().describe("Inclusive lower bound on timestamp (ISO date)"),
        until: z.string().optional().describe("Inclusive upper bound on timestamp (ISO date)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Max events, newest-first (1..200)"),
      }),
      execute: async ({ path_contains, action, since, until, limit }) => {
        const events = await kb.readEvents({
          pathContains: path_contains,
          action,
          since,
          until,
          limit,
        });
        trace?.record(
          "read_history",
          path_contains ?? "",
          events.map((e) => e.path).filter(Boolean)
        );
        // Return only the reader-relevant shape — traceId/modelChain are provenance noise here.
        return events.map((e) => ({
          ts: e.ts,
          action: e.action,
          path: e.path,
          summary: e.summary,
        }));
      },
    }),
  };
}

/** Provenance threaded onto mutation events (the model chain that produced them). */
export interface WriteToolMeta {
  modelChain?: string[];
}

export function buildWriteTools(
  kb: KnowledgeBase,
  filesChanged: Set<string>,
  trace?: TraceRecorder,
  meta?: WriteToolMeta
) {
  const mutationMeta = { traceId: trace?.id, modelChain: meta?.modelChain };
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, body, log_summary }) => {
        const c = await kb.writeConcept(path, frontmatter, body, log_summary, mutationMeta);
        filesChanged.add(c.path);
        trace?.record("write_concept", c.path, [c.path], true);
        return { written: c.path };
      },
    }),
    patch_concept: tool({
      description:
        "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one top-level '# Section' body section. Prefer this over write_concept for small edits.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Frontmatter keys to merge; set a key to null to remove it"),
        replace_section: z
          .object({
            heading: z
              .string()
              .min(1)
              .describe("Top-level heading name, e.g. 'Schema'. Must be non-empty — to replace the whole body use replace_body instead."),
            content: z.string().describe("New content for that section"),
          })
          .optional(),
        replace_body: z
          .string()
          .optional()
          .describe("Replace the entire markdown body (frontmatter untouched). Use for restructuring; prefer replace_section for targeted edits."),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, replace_section, replace_body, log_summary }) => {
        const c = await kb.patchConcept(
          path,
          {
            frontmatter,
            replaceSection: replace_section
              ? { heading: replace_section.heading, content: replace_section.content }
              : undefined,
            replaceBody: replace_body,
          },
          log_summary,
          mutationMeta
        );
        filesChanged.add(c.path);
        trace?.record("patch_concept", c.path, [c.path], true);
        return { patched: c.path };
      },
    }),
    delete_concept: tool({
      description:
        "Permanently delete a concept file. Prefer deprecation (tag 'deprecated' via patch_concept) unless content is wrong/harmful or deletion was explicitly requested.",
      inputSchema: z.object({
        path: conceptPath,
        log_summary: logSummary,
      }),
      execute: async ({ path, log_summary }) => {
        await kb.deleteConcept(path, log_summary, mutationMeta);
        filesChanged.add(path);
        trace?.record("delete_concept", path, [path], true);
        return { deleted: path };
      },
    }),
  };
}

/** Compact indented listing for prompts and the list_directory tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${child.name}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${indent}${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

/** Result of {@link formatTreeAdaptive}: the listing plus what altitude it landed at. */
export interface AdaptiveTree {
  text: string;
  /** True when the full listing exceeded budget and a directory overview was used. */
  degraded: boolean;
  /** Total concept count in the tree (recursive). */
  conceptCount: number;
}

const DEFAULT_TREE_BUDGET = 4000;

function treeBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UNDERSTORY_TREE_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TREE_BUDGET;
}

/**
 * Budget-bounded tree rendering. Returns the full {@link formatTree} listing when
 * it fits `budgetChars`; otherwise degrades to one line per directory with
 * recursive concept counts and types, capping depth to 1 if still over budget.
 * The first real O(N) cliff was dumping the whole tree into every prompt — this
 * keeps prompt size bounded as the bundle grows.
 */
export function formatTreeAdaptive(tree: TreeNode, budgetChars = treeBudget()): AdaptiveTree {
  const conceptCount = summarizeNode(tree).count;
  const full = formatTree(tree);
  if (full.length <= budgetChars) {
    return { text: full, degraded: false, conceptCount };
  }
  const overview = formatTreeOverview(tree, Number.POSITIVE_INFINITY);
  if (overview.length <= budgetChars) {
    return { text: overview, degraded: true, conceptCount };
  }
  // Still over: flatten to just the top-level directories (last resort).
  return { text: formatTreeOverview(tree, 1), degraded: true, conceptCount };
}

/** Recursive concept count and distinct types under a node. */
function summarizeNode(node: TreeNode): { count: number; types: Set<string> } {
  let count = 0;
  const types = new Set<string>();
  for (const child of node.children ?? []) {
    if (child.kind === "directory") {
      const nested = summarizeNode(child);
      count += nested.count;
      nested.types.forEach((t) => types.add(t));
    } else if (child.kind === "concept") {
      count++;
      if (child.type) types.add(child.type);
    }
  }
  return { count, types };
}

/** Degraded rendering: `dir/ — N concepts (Type A, Type B)` per directory. */
function formatTreeOverview(node: TreeNode, maxDepth: number, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  let rootConcepts = 0;
  const rootTypes = new Set<string>();
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      const { count, types } = summarizeNode(child);
      const typeList = [...types].sort().join(", ");
      lines.push(
        `${indent}${child.name}/ — ${count} concept${count === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}`
      );
      if (depth + 1 < maxDepth) {
        const sub = formatTreeOverview(child, maxDepth, depth + 1);
        if (sub) lines.push(sub);
      }
    } else if (child.kind === "concept") {
      rootConcepts++;
      if (child.type) rootTypes.add(child.type);
    }
  }
  if (depth === 0 && rootConcepts > 0) {
    const typeList = [...rootTypes].sort().join(", ");
    lines.push(
      `  (root) — ${rootConcepts} concept${rootConcepts === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}`
    );
  }
  return lines.filter(Boolean).join("\n");
}
