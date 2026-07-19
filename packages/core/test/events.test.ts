import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import {
  Bundle,
  KnowledgeBase,
  appendEvent,
  appendLog,
  backfillEventsFromLog,
  parseLegacyLog,
  projectLog,
  readEvents,
  readLog,
  type KnowledgeEvent,
} from "../src/okf/index.js";

let root: string;
let bundle: Bundle;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "events-test-"));
  bundle = new Bundle(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function ev(overrides: Partial<KnowledgeEvent> & { ts: string }): KnowledgeEvent {
  return { action: "Creation", path: "/x.md", summary: "s", ...overrides };
}

describe("append/read round-trip", () => {
  it("returns events newest-first, preserving all fields", async () => {
    await appendEvent(bundle, ev({ ts: "2026-01-01T00:00:00.000Z", path: "/a.md", summary: "first" }));
    await appendEvent(
      bundle,
      ev({
        ts: "2026-01-02T00:00:00.000Z",
        action: "Update",
        path: "/b.md",
        summary: "second",
        traceId: "trace-1",
        modelChain: ["anthropic:claude"],
      })
    );

    const events = await readEvents(bundle);
    expect(events.map((e) => e.summary)).toEqual(["second", "first"]);
    expect(events[0].traceId).toBe("trace-1");
    expect(events[0].modelChain).toEqual(["anthropic:claude"]);
    expect(events[0].action).toBe("Update");
  });
});

describe("filters", () => {
  beforeEach(async () => {
    await appendEvent(bundle, ev({ ts: "2026-01-01T00:00:00.000Z", action: "Creation", path: "/apis/billing.md", summary: "c" }));
    await appendEvent(bundle, ev({ ts: "2026-01-05T00:00:00.000Z", action: "Update", path: "/apis/billing.md", summary: "u" }));
    await appendEvent(bundle, ev({ ts: "2026-01-10T00:00:00.000Z", action: "Deletion", path: "/tables/customers.md", summary: "d" }));
  });

  it("filters by pathContains", async () => {
    const hits = await readEvents(bundle, { pathContains: "billing" });
    expect(hits.map((e) => e.summary)).toEqual(["u", "c"]);
  });

  it("filters by action", async () => {
    const hits = await readEvents(bundle, { action: "Update" });
    expect(hits.map((e) => e.summary)).toEqual(["u"]);
  });

  it("filters by since/until (inclusive)", async () => {
    const since = await readEvents(bundle, { since: "2026-01-05T00:00:00.000Z" });
    expect(since.map((e) => e.summary)).toEqual(["d", "u"]);
    const until = await readEvents(bundle, { until: "2026-01-05T00:00:00.000Z" });
    expect(until.map((e) => e.summary)).toEqual(["u", "c"]);
    const window = await readEvents(bundle, {
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-08T00:00:00.000Z",
    });
    expect(window.map((e) => e.summary)).toEqual(["u"]);
  });

  it("caps with limit (default 50), newest-first", async () => {
    const hits = await readEvents(bundle, { limit: 2 });
    expect(hits.map((e) => e.summary)).toEqual(["d", "u"]);
  });
});

describe("corrupt-line tolerance", () => {
  it("skips malformed lines and keeps the stream readable", async () => {
    await appendEvent(bundle, ev({ ts: "2026-01-01T00:00:00.000Z", summary: "ok1" }));
    await fs.appendFile(path.join(root, ".events.jsonl"), "{not valid json\n", "utf-8");
    await fs.appendFile(path.join(root, ".events.jsonl"), "\n", "utf-8"); // blank line
    await appendEvent(bundle, ev({ ts: "2026-01-02T00:00:00.000Z", summary: "ok2" }));

    const events = await readEvents(bundle);
    expect(events.map((e) => e.summary)).toEqual(["ok2", "ok1"]);
  });
});

describe("log.md projection", () => {
  it("is byte-compatible with appendLog for same-day entries", async () => {
    // Build log.md via the legacy incremental appender.
    const legacyBundle = new Bundle(await fs.mkdtemp(path.join(os.tmpdir(), "events-legacy-")));
    await appendLog(legacyBundle, "Creation", "Created one.");
    await appendLog(legacyBundle, "Update", "Updated one.");
    await appendLog(legacyBundle, "Deletion", "Removed one.");
    const expected = await fs.readFile(path.join(legacyBundle.root, "log.md"), "utf-8");

    // Build the same log from the event projection (events are newest-first).
    const ts = new Date().toISOString();
    await projectLog(bundle, [
      ev({ ts, action: "Deletion", summary: "Removed one." }),
      ev({ ts, action: "Update", summary: "Updated one." }),
      ev({ ts, action: "Creation", summary: "Created one." }),
    ]);
    const projected = await fs.readFile(path.join(root, "log.md"), "utf-8");

    expect(projected).toBe(expected);
    await fs.rm(legacyBundle.root, { recursive: true, force: true });
  });

  it("groups multiple days newest-first", async () => {
    await projectLog(bundle, [
      ev({ ts: "2026-02-02T09:00:00.000Z", action: "Update", summary: "day two." }),
      ev({ ts: "2026-02-01T09:00:00.000Z", action: "Creation", summary: "day one." }),
    ]);
    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toBe(
      "# Directory Update Log\n\n## 2026-02-02\n\n* **Update**: day two.\n\n## 2026-02-01\n\n* **Creation**: day one.\n"
    );
  });
});

describe("legacy fallback + backfill", () => {
  it("readLog falls back to legacy log.md when no events exist", async () => {
    await appendLog(bundle, "Creation", "Legacy creation.");
    const entries = await readLog(bundle);
    expect(entries).toEqual([{ date: expect.any(String), action: "Creation", summary: "Legacy creation." }]);
  });

  it("backfill synthesizes events from a legacy log, then is a no-op", async () => {
    await appendLog(bundle, "Creation", "First.");
    await appendLog(bundle, "Update", "Second.");
    const legacy = parseLegacyLog(await fs.readFile(path.join(root, "log.md"), "utf-8"));
    expect(legacy.map((e) => e.summary)).toEqual(["Second.", "First."]);

    await backfillEventsFromLog(bundle);
    const events = await readEvents(bundle);
    expect(events.map((e) => e.summary)).toEqual(["Second.", "First."]);
    expect(events.every((e) => e.ts.endsWith("T00:00:00.000Z"))).toBe(true);

    // Idempotent: a second backfill does not double-count.
    await backfillEventsFromLog(bundle);
    expect((await readEvents(bundle)).length).toBe(2);
  });
});

describe("gitignore hygiene", () => {
  it("ignores .index/ and .traces/ but tracks .events.jsonl on first mutation", async () => {
    const git = simpleGit(root);
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");

    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "body", "Added A.");

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    const lines = gitignore.split("\n").filter(Boolean);
    expect(lines).toContain(".index/");
    expect(lines).toContain(".traces/");
    expect(lines).not.toContain(".events.jsonl");

    // The event stream is committed, not ignored.
    const tracked = await git.raw(["ls-files"]);
    expect(tracked).toContain(".events.jsonl");
    expect(tracked).not.toContain(".index/");

    // Idempotent: a second mutation does not duplicate the ignore lines.
    await kb.writeConcept("/b.md", { type: "T", title: "B" }, "body", "Added B.");
    const after = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    expect(after.split("\n").filter((l) => l === ".index/")).toHaveLength(1);
    expect(after).toBe(gitignore);
  });

  it("appends to an existing .gitignore without clobbering it", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf-8");
    const git = simpleGit(root);
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");

    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "body", "Added A.");

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    expect(gitignore).toBe("node_modules/\n.index/\n.traces/\n");
  });
});
