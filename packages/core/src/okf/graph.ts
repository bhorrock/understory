import type { Bundle } from "./bundle.js";
import type { ConceptFrontmatter } from "./types.js";

export interface GraphNode {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  /** Total degree (inbound + outbound, deduped per direction). */
  links: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphScan extends GraphData {
  /** Outbound links whose target concept does not exist. */
  brokenLinks: { path: string; target: string }[];
  /** Inbound-degree per concept path (index/log catalogs don't count). */
  inbound: Map<string, number>;
  /** Frontmatter per concept path — scan-internal, for lint checks (not the public graph). */
  frontmatter: Map<string, ConceptFrontmatter>;
}

// Bundle-relative links to concepts: [text](/dir/concept.md)
const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;

/**
 * One pass over the bundle building the inter-concept link graph.
 * Reserved files (index.md/log.md) are not link sources — their generated
 * catalogs link everything, which would drown the real relationships.
 * Shared by lint (health) and the graph API (visualization).
 */
export async function scanGraph(bundle: Bundle): Promise<GraphScan> {
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);

  const nodes = new Map<string, GraphNode>();
  const frontmatter = new Map<string, ConceptFrontmatter>();
  for (const p of paths) {
    let title: string | undefined;
    let type: string | undefined;
    let description: string | undefined;
    let body = "";
    try {
      const concept = await bundle.readConcept(p);
      body = concept.body;
      const fm = concept.frontmatter;
      frontmatter.set(p, fm);
      if (typeof fm.title === "string") title = fm.title;
      if (typeof fm.type === "string") type = fm.type;
      if (typeof fm.description === "string") description = fm.description;
    } catch {
      // Permissive: unreadable concept still appears as a node.
    }
    nodes.set(p, { path: p, title, type, description, links: 0 });
    nodes.get(p)!.links = 0;
    (nodes.get(p) as GraphNode & { _body?: string })._body = body;
  }

  const edges: GraphEdge[] = [];
  const brokenLinks: { path: string; target: string }[] = [];
  const inbound = new Map<string, number>();
  for (const p of paths) inbound.set(p, 0);

  for (const [source, node] of nodes) {
    const body = (node as GraphNode & { _body?: string })._body ?? "";
    const targeted = new Set<string>();
    for (const match of body.matchAll(LINK_RE)) {
      const target = match[1];
      if (target === source || targeted.has(target)) continue;
      targeted.add(target);
      if (known.has(target)) {
        edges.push({ source, target });
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      } else {
        brokenLinks.push({ path: source, target });
      }
    }
    delete (node as GraphNode & { _body?: string })._body;
  }

  for (const edge of edges) {
    nodes.get(edge.source)!.links++;
    nodes.get(edge.target)!.links++;
  }

  return { nodes: [...nodes.values()], edges, brokenLinks, inbound, frontmatter };
}

/** Public graph shape for the API/UI (no scan internals). */
export async function buildGraph(bundle: Bundle): Promise<GraphData> {
  const { nodes, edges } = await scanGraph(bundle);
  return { nodes, edges };
}
