import type { Bundle } from "./bundle.js";
import { scanGraph } from "./graph.js";

export interface LintFinding {
  path: string;
  type?: string;
  title?: string;
}

/** Non-fatal advisory finding — surfaced but never flips `healthy` to false. */
export interface LintWarning {
  path: string;
  type?: string;
  title?: string;
  /** Human-readable description of the advisory. */
  message: string;
}

export interface BrokenLink {
  /** Concept containing the dangling link. */
  path: string;
  /** The missing bundle-relative target. */
  target: string;
}

export interface LintReport {
  conceptCount: number;
  /** Distinct inter-concept link edges (source → target, deduped per source). */
  linkCount: number;
  /** Concepts no other concept links to (index/log catalogs don't count). */
  orphans: LintFinding[];
  /** Outbound links pointing at nonexistent concepts. */
  brokenLinks: BrokenLink[];
  /** Advisory findings (e.g. Event concepts missing `date`). Do NOT affect `healthy`. */
  warnings: LintWarning[];
  healthy: boolean;
}

/**
 * Graph health check (deterministic, no LLM) — orphans + broken links,
 * Karpathy's anti-drift lint. Derived from the shared graph scan.
 */
export async function lintBundle(bundle: Bundle): Promise<LintReport> {
  const { nodes, edges, brokenLinks, inbound, frontmatter } = await scanGraph(bundle);

  const orphans: LintFinding[] = nodes
    .filter((n) => (inbound.get(n.path) ?? 0) === 0)
    .map((n) => ({ path: n.path, type: n.type, title: n.title }));

  // Advisory: Event-typed concepts should carry a `date` so the history of the
  // change they record is anchored in time. Warning-only — never fails health.
  const warnings: LintWarning[] = [];
  for (const n of nodes) {
    if ((n.type ?? "").toLowerCase() !== "event") continue;
    const fm = frontmatter.get(n.path);
    if (fm && fm.date == null) {
      warnings.push({
        path: n.path,
        type: n.type,
        title: n.title,
        message: "Event concept is missing a `date` frontmatter field.",
      });
    }
  }

  return {
    conceptCount: nodes.length,
    linkCount: edges.length,
    orphans,
    brokenLinks,
    warnings,
    healthy: orphans.length === 0 && brokenLinks.length === 0,
  };
}
