import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KnowledgeBase } from "@understory/core";
import { buildMcpServer } from "../src/mcp/server.js";

let root: string;
let kb: KnowledgeBase;
let client: Client;

/** Parse the memory_history tool's JSON text payload. */
async function history(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const res = (await client.callTool({ name: "memory_history", arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0].text);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "history-server-test-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept("/apis/billing.md", { type: "API" }, "body", "Added [billing](/apis/billing.md).");
  await kb.writeConcept("/apis/payments.md", { type: "API" }, "body", "Added [payments](/apis/payments.md).");
  await kb.patchConcept("/apis/billing.md", { replaceBody: "new" }, "Updated [billing](/apis/billing.md).");

  const server = await buildMcpServer(kb);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("memory_history MCP tool", () => {
  it("returns the mutation history as JSON, newest-first, with the reader shape", async () => {
    const events = await history({ limit: 20 });
    expect(events.map((e) => e.action)).toEqual(["Update", "Creation", "Creation"]);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["action", "path", "summary", "ts"]);
    }
  });

  it("passes filters through to kb.readEvents", async () => {
    const byPath = await history({ path_contains: "billing", limit: 20 });
    expect(byPath.map((e) => e.action)).toEqual(["Update", "Creation"]);
    expect(byPath.every((e) => String(e.path).includes("billing"))).toBe(true);

    const byAction = await history({ action: "Update", limit: 20 });
    expect(byAction).toHaveLength(1);
    expect(byAction[0].path).toBe("/apis/billing.md");

    const capped = await history({ limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].action).toBe("Update");
  });
});
