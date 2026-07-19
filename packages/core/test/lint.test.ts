import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lint-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Event-concept date warning", () => {
  it("warns when an Event concept is missing a `date` frontmatter field", async () => {
    // Two mutually-linked concepts → no orphans, no broken links (healthy stays true),
    // isolating the effect of the warning.
    await kb.writeConcept(
      "/events/moved.md",
      { type: "Event", title: "Moved" },
      "Anirban moved. See [Anirban](/people/anirban.md).",
      "Added event."
    );
    await kb.writeConcept(
      "/people/anirban.md",
      { type: "Person", title: "Anirban" },
      "Now in Bangalore. See [Moved](/events/moved.md).",
      "Added person."
    );

    const report = await kb.lint();
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].path).toBe("/events/moved.md");
    expect(report.warnings[0].message).toMatch(/date/i);
    // Warnings are advisory — they do NOT flip `healthy`.
    expect(report.orphans).toHaveLength(0);
    expect(report.brokenLinks).toHaveLength(0);
    expect(report.healthy).toBe(true);
    // `healthy` is a pure function of orphans + broken links, never warnings.
    expect(report.healthy).toBe(report.orphans.length === 0 && report.brokenLinks.length === 0);
  });

  it("matches the type case-insensitively", async () => {
    await kb.writeConcept("/events/launch.md", { type: "event" }, "A launch.", "Added event.");
    const report = await kb.lint();
    expect(report.warnings.map((w) => w.path)).toContain("/events/launch.md");
  });

  it("does not warn when an Event concept has a `date`", async () => {
    await kb.writeConcept(
      "/events/launched.md",
      { type: "Event", date: "2026-07-18" },
      "Launched.",
      "Added event."
    );
    const report = await kb.lint();
    expect(report.warnings).toHaveLength(0);
  });

  it("does not warn for a non-Event concept missing a `date`", async () => {
    await kb.writeConcept("/people/dana.md", { type: "Person" }, "A person.", "Added person.");
    const report = await kb.lint();
    expect(report.warnings).toHaveLength(0);
  });
});
