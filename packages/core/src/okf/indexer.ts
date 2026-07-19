import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Bundle } from "./bundle.js";

/**
 * Regenerate a directory's index.md per spec §6:
 * bullet list of `[Title](relative-url) - description`, subdirectories included.
 * The root index.md carries the only frontmatter allowed in an index: okf_version.
 */
/** Cached per-directory recursive summary (concept count, distinct types, first titles). */
export interface DirSummary {
  count: number;
  /** Distinct types, pre-sorted so formatting is stable. */
  types: string[];
  /** Up to the first three titles, in walk order. */
  titles: string[];
}

/**
 * Per-directory summary cache, keyed by absolute directory path. Owned by
 * KnowledgeBase, which invalidates the touched chain before regen. Absent cache
 * → every directory is walked (the original behavior), so callers/tests that
 * pass no cache are unaffected.
 */
export type IndexCache = Map<string, DirSummary>;

export async function regenerateIndex(
  bundle: Bundle,
  dir = "/",
  cache?: IndexCache
): Promise<string> {
  const absDir = bundle.resolve(dir);
  const isRoot = absDir === bundle.root;
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const conceptLines: string[] = [];
  const dirLines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const summary = await summarizeDirectory(path.join(absDir, entry.name), cache);
      dirLines.push(`* [${entry.name}](${entry.name}/) - ${summary}`);
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_FILENAMES.has(entry.name)) continue;
    let title = entry.name.replace(/\.md$/, "");
    let description = "";
    try {
      const { frontmatter } = parseDoc(
        await fs.readFile(path.join(absDir, entry.name), "utf-8")
      );
      if (typeof frontmatter.title === "string" && frontmatter.title) title = frontmatter.title;
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Permissive: index unparseable files by filename.
    }
    conceptLines.push(`* [${title}](${entry.name})${description ? ` - ${description}` : ""}`);
  }

  const dirName = isRoot ? "Knowledge Base" : path.basename(absDir);
  const sections: string[] = [];
  if (isRoot) sections.push(`---\nokf_version: "0.1"\n---\n`);
  sections.push(`# ${capitalize(dirName)}\n`);
  if (conceptLines.length > 0) sections.push(conceptLines.join("\n") + "\n");
  if (dirLines.length > 0) {
    const heading = isRoot ? "Memory Segments" : "Subdirectories";
    sections.push(`## ${heading}\n\n${dirLines.join("\n")}\n`);
  }

  const content = sections.join("\n");
  await fs.writeFile(path.join(absDir, "index.md"), content, "utf-8");
  return content;
}

/** Regenerate index.md for a directory and every ancestor up to the root. */
export async function regenerateIndexChain(
  bundle: Bundle,
  dir: string,
  cache?: IndexCache
): Promise<void> {
  let current = bundle.resolve(dir);
  // If given a file path, start from its directory.
  if (current.endsWith(".md")) current = path.dirname(current);
  while (true) {
    await regenerateIndex(bundle, bundle.toBundlePath(current), cache);
    if (current === bundle.root) break;
    current = path.dirname(current);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One-line deterministic summary of a directory's contents for index listings:
 * concept count, distinct types, and the first few titles — always derivable,
 * always current, no LLM. Consults `cache` (keyed by absolute dir) before
 * walking; the formatted output is identical whether cached or freshly walked.
 */
async function summarizeDirectory(absDir: string, cache?: IndexCache): Promise<string> {
  let summary = cache?.get(absDir);
  if (!summary) {
    summary = await computeDirSummary(absDir);
    cache?.set(absDir, summary);
  }
  return formatDirSummary(summary);
}

/** Walk a directory tree once, collecting the recursive {@link DirSummary}. */
async function computeDirSummary(absDir: string): Promise<DirSummary> {
  const titles: string[] = [];
  const types = new Set<string>();
  let count = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.name.endsWith(".md") && !RESERVED_FILENAMES.has(entry.name)) {
        count++;
        try {
          const { frontmatter } = parseDoc(await fs.readFile(child, "utf-8"));
          if (typeof frontmatter.type === "string" && frontmatter.type) types.add(frontmatter.type);
          if (titles.length < 3) {
            titles.push(
              typeof frontmatter.title === "string" && frontmatter.title
                ? frontmatter.title
                : entry.name.replace(/\.md$/, "")
            );
          }
        } catch {
          if (titles.length < 3) titles.push(entry.name.replace(/\.md$/, ""));
        }
      }
    }
  };
  await walk(absDir);

  return { count, types: [...types].sort(), titles };
}

/** Render a {@link DirSummary} to the index bullet text (stable formatting). */
function formatDirSummary(summary: DirSummary): string {
  if (summary.count === 0) return "empty";
  const typeList = summary.types.join(", ");
  const titleList =
    summary.titles.join(", ") + (summary.count > summary.titles.length ? ", …" : "");
  return `${summary.count} concept${summary.count === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}: ${titleList}`;
}
