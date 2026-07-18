import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { Bundle } from "./bundle.js";
import {
  appendEvent,
  backfillEventsFromLog,
  readEvents,
  type EventFilter,
  type KnowledgeEvent,
} from "./events.js";
import { regenerateIndexChain } from "./indexer.js";
import { projectLog, readLog } from "./logger.js";
import { searchBundle, listTypes, type SearchOptions } from "./search.js";
import { validateBundle } from "./validate.js";
import { lintBundle, type LintReport } from "./lint.js";
import { buildGraph, type GraphData } from "./graph.js";
import type {
  Concept,
  ConceptFrontmatter,
  ConformanceReport,
  LogAction,
  LogEntry,
  SearchHit,
  TreeNode,
} from "./types.js";

export interface KnowledgeBaseOptions {
  /** Commit after each mutation. Requires the bundle to be inside a git repo. */
  gitAutocommit?: boolean;
}

/** Provenance for a mutation, threaded from the agent onto the event record. */
export interface MutationMeta {
  traceId?: string;
  modelChain?: string[];
}

/**
 * The one write-path into the bundle. Spec conformance (index.md, log.md,
 * frontmatter validation, timestamps) is enforced HERE, deterministically —
 * never delegated to the LLM. Mutations are serialized through a queue.
 */
export class KnowledgeBase {
  readonly bundle: Bundle;
  private readonly git: SimpleGit | null;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<void> | null = null;

  constructor(bundleRoot: string, private readonly options: KnowledgeBaseOptions = {}) {
    this.bundle = new Bundle(bundleRoot);
    this.git = options.gitAutocommit ? simpleGit(this.bundle.root) : null;
  }

  // ── Reads (no queue) ────────────────────────────────────────────────

  readConcept(conceptPath: string): Promise<Concept> {
    return this.bundle.readConcept(conceptPath);
  }

  listTree(): Promise<TreeNode> {
    return this.bundle.listTree();
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return searchBundle(this.bundle, query, options);
  }

  listTypes(): Promise<string[]> {
    return listTypes(this.bundle);
  }

  readLog(): Promise<LogEntry[]> {
    return readLog(this.bundle);
  }

  /** The mutation event stream, newest-first (system of record for history). */
  async readEvents(filter?: EventFilter): Promise<KnowledgeEvent[]> {
    await this.ensureInitialized();
    return readEvents(this.bundle, filter);
  }

  validate(): Promise<ConformanceReport> {
    return validateBundle(this.bundle);
  }

  /** Graph health: orphaned concepts + broken links (deterministic, no LLM). */
  lint(): Promise<LintReport> {
    return lintBundle(this.bundle);
  }

  /** Inter-concept link graph (nodes + edges) for visualization. */
  graph(): Promise<GraphData> {
    return buildGraph(this.bundle);
  }

  // ── Mutations (serialized; auto event + log + index + optional commit) ──

  writeConcept(
    conceptPath: string,
    frontmatter: ConceptFrontmatter,
    body: string,
    logSummary: string,
    meta?: MutationMeta
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const existed = await this.bundle.exists(conceptPath);
      const concept = await this.bundle.writeConcept(conceptPath, frontmatter, body);
      await this.afterMutation(concept.path, existed ? "Update" : "Creation", logSummary, meta);
      return concept;
    });
  }

  patchConcept(
    conceptPath: string,
    changes: Parameters<Bundle["patchConcept"]>[1],
    logSummary: string,
    meta?: MutationMeta
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const concept = await this.bundle.patchConcept(conceptPath, changes);
      await this.afterMutation(concept.path, "Update", logSummary, meta);
      return concept;
    });
  }

  deleteConcept(conceptPath: string, logSummary: string, meta?: MutationMeta): Promise<void> {
    return this.enqueue(async () => {
      const canonical = this.bundle.toBundlePath(conceptPath);
      await this.bundle.deleteConcept(canonical);
      await this.afterMutation(canonical, "Deletion", logSummary, meta);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * One-time lazy setup: backfill the event stream from any legacy log.md, and
   * (when autocommitting) ensure derived dot-dirs are gitignored. Idempotent.
   */
  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await backfillEventsFromLog(this.bundle);
        if (this.git) await this.ensureGitignore();
      })();
    }
    return this.initPromise;
  }

  /** Idempotently ensure `.index/` and `.traces/` are ignored (never `.events.jsonl`). */
  private async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.bundle.root, ".gitignore");
    let existing = "";
    try {
      existing = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // No .gitignore yet.
    }
    const present = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = [".index/", ".traces/"].filter((line) => !present.has(line));
    if (missing.length === 0) return;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.writeFile(gitignorePath, existing + prefix + missing.join("\n") + "\n", "utf-8");
  }

  private async afterMutation(
    conceptPath: string,
    action: LogAction,
    logSummary: string,
    meta?: MutationMeta
  ): Promise<void> {
    await this.ensureInitialized();
    const linked = `[${conceptPath.split("/").pop()}](${conceptPath})`;
    const summary = logSummary || `${action} of ${linked}.`;
    const event: KnowledgeEvent = {
      ts: new Date().toISOString(),
      action,
      path: conceptPath,
      summary,
    };
    if (meta?.traceId) event.traceId = meta.traceId;
    if (meta?.modelChain && meta.modelChain.length > 0) event.modelChain = meta.modelChain;
    await appendEvent(this.bundle, event);
    await projectLog(this.bundle, await readEvents(this.bundle, { limit: Number.MAX_SAFE_INTEGER }));
    await regenerateIndexChain(this.bundle, path.posix.dirname(conceptPath));
    if (this.git) {
      try {
        await this.git.add(".");
        await this.git.commit(`${action.toLowerCase()}: ${logSummary || conceptPath}`);
      } catch (err) {
        // Autocommit is best-effort; the KB write itself already succeeded.
        console.error(`[understory] git autocommit failed: ${(err as Error).message}`);
      }
    }
  }
}
