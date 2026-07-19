import type { KnowledgeBase } from "@understory/core";
import type { TreeNode } from "@understory/core";

export const MAX_SEED_CHARS = 3000;
const MAX_DESCRIPTIONS_PER_SEGMENT = 10;
const DEGRADED_DESCRIPTIONS_PER_SEGMENT = 3;

/** A concept's seed-facing fields plus its path (for ranking lookups). */
interface SeedConcept {
  path: string;
  description: string;
  type?: string;
}

/**
 * Seed memory: a compact overview of what the knowledge base contains,
 * loaded into the client LLM at session start (via MCP `instructions` and
 * the memory_query tool description). Without it the model has no signal
 * that memory might hold an answer, so it never thinks to look.
 *
 * Unlike the on-disk index.md (navigation: titles + links), the seed lists
 * concept DESCRIPTIONS per segment — semantic hooks beat filenames for
 * igniting the "memory might know this" instinct. Descriptions are ranked by
 * inbound-link degree (from the graph) and recency (from the event stream) so
 * the most-connected, most-recently-touched concepts survive the budget.
 */
export async function buildSeedMemory(kb: KnowledgeBase): Promise<string> {
  const [tree, types, log, events, graph] = await Promise.all([
    kb.listTree(),
    kb.listTypes(),
    kb.readLog(),
    kb.readEvents({ limit: Number.MAX_SAFE_INTEGER }),
    kb.graph(),
  ]);

  // Ranking signals. events are newest-first, so the first ts seen per path is
  // its most recent mutation; node.links is the concept's total link degree.
  const recency = new Map<string, string>();
  for (const ev of events) {
    if (ev.path && !recency.has(ev.path)) recency.set(ev.path, ev.ts);
  }
  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.path, node.links);

  const rank = (a: SeedConcept, b: SeedConcept): number => {
    const byDegree = (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0);
    if (byDegree !== 0) return byDegree;
    const ra = recency.get(a.path) ?? "";
    const rb = recency.get(b.path) ?? "";
    if (rb !== ra) return rb < ra ? -1 : 1; // newer ts first
    return a.path.localeCompare(b.path); // stable final tie-break
  };

  const segmentBlock = (label: string, concepts: SeedConcept[], perSegment: number): string => {
    const shown = [...concepts].sort(rank).slice(0, perSegment);
    const more = concepts.length - shown.length;
    return (
      `* ${label} — ${concepts.length} concept${concepts.length === 1 ? "" : "s"}:\n` +
      shown.map((c) => `    * ${c.description}`).join("\n") +
      (more > 0 ? `\n    * …and ${more} more` : "")
    );
  };

  const assemble = (perSegment: number): string => {
    const segments: string[] = [];
    const rootConcepts: SeedConcept[] = [];
    for (const child of tree.children ?? []) {
      if (child.kind === "directory") {
        const collected = collectConcepts(child);
        if (collected.count === 0) continue;
        const typeList = [...collected.types].sort().join(", ");
        const shown = [...collected.concepts].sort(rank).slice(0, perSegment);
        const more = collected.count - shown.length;
        segments.push(
          `* ${child.name}/ — ${collected.count} concept${collected.count === 1 ? "" : "s"}` +
            `${typeList ? ` (${typeList})` : ""}:\n` +
            shown.map((c) => `    * ${c.description}`).join("\n") +
            (more > 0 ? `\n    * …and ${more} more` : "")
        );
      } else if (child.kind === "concept") {
        rootConcepts.push(toSeedConcept(child));
      }
    }
    if (rootConcepts.length > 0) {
      segments.push(segmentBlock("(root)", rootConcepts, perSegment));
    }

    const recent = log.slice(0, 3).map((e) => `- ${e.date} ${e.action}: ${e.summary}`);
    const sections = [
      `Concept types in use: ${types.join(", ") || "(none yet)"}`,
      `Memory segments:\n${segments.join("\n") || "(empty — nothing stored yet)"}`,
    ];
    if (recent.length > 0) sections.push(`Recent activity:\n${recent.join("\n")}`);
    return sections.join("\n\n");
  };

  // Full altitude first; if over budget, rebuild at a degraded altitude (fewer
  // ranked descriptions per segment) rather than mid-word slicing. A clean
  // word-boundary truncation remains only as an absolute last resort.
  let seed = assemble(MAX_DESCRIPTIONS_PER_SEGMENT);
  if (seed.length > MAX_SEED_CHARS) seed = assemble(DEGRADED_DESCRIPTIONS_PER_SEGMENT);
  if (seed.length > MAX_SEED_CHARS) seed = truncateClean(seed, MAX_SEED_CHARS);
  return seed;
}

function toSeedConcept(node: TreeNode): SeedConcept {
  return { path: node.path, description: node.description ?? node.title ?? node.name, type: node.type };
}

/** Recursively gather concept descriptions (falling back to title/filename) and types. */
function collectConcepts(node: TreeNode): {
  count: number;
  types: Set<string>;
  concepts: SeedConcept[];
} {
  const out = { count: 0, types: new Set<string>(), concepts: [] as SeedConcept[] };
  for (const child of node.children ?? []) {
    if (child.kind === "directory") {
      const nested = collectConcepts(child);
      out.count += nested.count;
      nested.types.forEach((t) => out.types.add(t));
      out.concepts.push(...nested.concepts);
    } else if (child.kind === "concept") {
      out.count++;
      if (child.type) out.types.add(child.type);
      out.concepts.push(toSeedConcept(child));
    }
  }
  return out;
}

/** Truncate to a word boundary under `max`, appending a notice (never mid-word). */
function truncateClean(s: string, max: number): string {
  const notice = "\n… (truncated — use memory_query to explore further)";
  if (s.length <= max) return s;
  const room = Math.max(0, max - notice.length);
  let cut = s.slice(0, room);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (boundary > 0) cut = cut.slice(0, boundary);
  return cut + notice;
}

/** The initialize `instructions` block — seed plus the instinct-igniting rules. */
export function seedInstructions(seed: string): string {
  return `This server is your persistent memory — an OKF knowledge base of markdown concepts that survives across sessions.

MEMORY OVERVIEW (as of session start):

${seed}

How to use your memory:
- BEFORE answering anything related to the topics above, call memory_query — the answer may already be stored. Prefer stored knowledge over guessing.
- When you learn a lasting fact, decision, preference, or piece of documentation, persist it with memory_add. If it isn't stored, it will be forgotten.
- When existing knowledge turns out to be wrong or outdated, fix it with memory_update.
- memory_status reports size and health of the memory.`;
}
