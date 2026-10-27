import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { WorkspaceService, ServiceClient } from "../src/index.js";

const services: { service: WorkspaceService; root: string }[] = [];
afterEach(async () => { for (const item of services.splice(0)) { await item.service.close(); rmSync(item.root, { recursive: true, force: true }); } });

async function setup(): Promise<ServiceClient> {
  const root = mkdtempSync(join(tmpdir(), "rd-g2-"));
  const service = await WorkspaceService.start({ root, adapter: new MockHarnessAdapter(), socketPath: join(root, "service.sock"), pollMs: 25 });
  services.push({ service, root });
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call("roles.install", { source_path: resolve("examples/demo-team") });
  return owner;
}

describe("G2 owner read models over the service control plane", () => {
  it("roles.get returns pack data, coordination state and requested/granted capabilities", async () => {
    const owner = await setup();
    const details = await owner.call<{ role_id: string; instructions: string; pack: { content_hash: string }; initialized: boolean; generation: number; current_instance_id: string | null; requested_capabilities: string[]; granted_capabilities: string[]; documents: unknown[]; output_schemas: unknown[] }>("roles.get", { role_id: "builder" });
    expect(details.role_id).toBe("builder");
    expect(details.instructions.length).toBeGreaterThan(0);
    expect(details.pack.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(details.initialized).toBe(false);
    expect(details.generation).toBe(0);
    expect(details.current_instance_id).toBeNull();
    expect(details.requested_capabilities.length).toBeGreaterThan(0);
    expect(details.granted_capabilities).toEqual([]);
    expect(Array.isArray(details.documents)).toBe(true);
    expect(Array.isArray(details.output_schemas)).toBe(true);
    await expect(owner.call("roles.get", { role_id: "no-such-role" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("policy.list pages the requested-vs-granted table with contract pagination", async () => {
    const owner = await setup();
    const page1 = await owner.call<{ workspace_id: string; observed_at: string; items: Array<{ role_id: string }>; next_cursor: string | null }>("policy.list", { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    expect(page1.observed_at).toBeTruthy();
    const page2 = await owner.call<{ items: Array<{ role_id: string }>; next_cursor: string | null }>("policy.list", { limit: 1, cursor: page1.next_cursor });
    expect(page2.items[0]!.role_id).not.toBe(page1.items[0]!.role_id);
    const exhausted = await owner.call<{ items: unknown[]; next_cursor: string | null }>("policy.list", { limit: 50 });
    expect(exhausted.next_cursor).toBeNull();
    expect(exhausted.items.length).toBeGreaterThanOrEqual(page1.items.length + page2.items.length);
    await expect(owner.call("policy.list", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("G2-R06: roles.get resolves installed-copy bodies (instructions/templates/schema), not paths", async () => {
    const owner = await setup();
    const details = await owner.call<{ instructions: string; documents: Array<{ key: string; template: string }>; output_schemas: Array<{ key: string; schema: string }> }>("roles.get", { role_id: "reviewer" });
    expect(details.instructions).not.toMatch(/\.md$/);
    expect(details.instructions).toContain("# Reviewer");
    const reviews = details.documents.find(document => document.key === "reviews");
    expect(reviews?.template).not.toMatch(/\.md$/);
    expect(reviews?.template.length).toBeGreaterThan(10);
    const schema = details.output_schemas.find(item => item.key === "review-result");
    expect(schema?.schema).not.toMatch(/\.json$/);
    expect(() => JSON.parse(schema!.schema)).not.toThrow();
  });

  it("G2-R06(re): role materials resolve by pack contract even without extensions; missing material fails loudly", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const packDir = mkdtempSync(join(tmpdir(), "rd-g2-noext-"));
    mkdirSync(join(packDir, "roles"), { recursive: true });
    mkdirSync(join(packDir, "materials"), { recursive: true });
    writeFileSync(join(packDir, "rolepack.json"), JSON.stringify({
      schema_version: "0.1", name: "extless-probe", version: "0.1.0", requires_protocol: "0.1",
      roles: [{
        id: "extless",
        title: "Extless",
        instructions: "materials/guide",
        documents: [{ key: "notes", template: "materials/layout", visibility: "project" }],
        requested_capabilities: ["documents.read"],
        output_schemas: [{ key: "record", schema: "materials/record" }],
      }],
    }));
    writeFileSync(join(packDir, "materials", "guide"), "# Guide without extension\n\nReal body.");
    writeFileSync(join(packDir, "materials", "layout"), "Layout body without extension");
    writeFileSync(join(packDir, "materials", "record"), JSON.stringify({ type: "object" }));
    const owner = await setup();
    await owner.call("roles.install", { source_path: packDir });
    const details = await owner.call<{ instructions: string; documents: Array<{ key: string; template: string }>; output_schemas: Array<{ key: string; schema: string }> }>("roles.get", { role_id: "extless" });
    expect(details.instructions).toContain("# Guide without extension");
    expect(details.instructions).not.toContain("materials/");
    expect(details.documents[0]!.template).toContain("Layout body without extension");
    expect(() => JSON.parse(details.output_schemas[0]!.schema)).not.toThrow();
    // Deleting installed material (not the source) makes the next read fail loudly — never a path as body.
    const { rmSync, statSync } = await import("node:fs");
    const packHash = JSON.parse((await (await import("node:fs/promises")).readFile(join(packDir, "rolepack.json"), "utf8"))) as { name: string; version: string };
    void packHash;
    const storeDir = services[services.length - 1]!.root;
    const installedGuide = join(storeDir, ".roledock", "packs", "extless-probe", "0.1.0", "materials", "guide");
    expect(statSync(installedGuide).isFile()).toBe(true);
    rmSync(installedGuide);
    await expect(owner.call("roles.get", { role_id: "extless" })).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("workspace.runtimeStatus projects the adapter capabilities (managed declaration)", async () => {
    const owner = await setup();
    const status = await owner.call<{ workspace_id: string; observed_at: string; runtime: { adapter: string; level: string; isolation: Record<string, boolean> } }>("workspace.runtimeStatus");
    expect(status.runtime.adapter).toBe("mock");
    expect(["full", "restricted"]).toContain(status.runtime.level);
    for (const value of Object.values(status.runtime.isolation)) expect(typeof value).toBe("boolean");
  });

  it("owner-only: session connections cannot call the new read models", async () => {
    const root = mkdtempSync(join(tmpdir(), "rd-g2-"));
    const adapter = new MockHarnessAdapter();
    adapter.seedExternalSession("mock-existing-conversation", "mock-fixture-subject");
    const service = await WorkspaceService.start({ root, adapter, socketPath: join(root, "service.sock"), pollMs: 25 });
    services.push({ service, root });
    const owner = new ServiceClient(service.ownerCredential);
    const trusted = await owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: "mock-fixture-subject", capability_ceiling: ["authorizations.get"] });
    const enrolled = await new ServiceClient(trusted).call<{ credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: "mock-existing-conversation" });
    const sessionClient = new ServiceClient(enrolled.credential);
    for (const operation of ["roles.get", "policy.list", "workspace.runtimeStatus"]) {
      await expect(sessionClient.call(operation, {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
});
