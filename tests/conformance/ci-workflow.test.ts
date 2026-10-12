import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

describe("CI workflow", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as {
    on?: unknown;
    jobs: Record<string, { "runs-on": string; steps: Array<Record<string, unknown>> }>;
  };

  it("parses as valid YAML with a check job", () => {
    expect(Object.keys(workflow.jobs)).toContain("check");
    expect(workflow.jobs.check["runs-on"]).toContain("ubuntu");
  });

  it("runs npm ci and the full check gate", () => {
    const scripts = workflow.jobs.check.steps
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string");
    expect(scripts).toContain("npm ci");
    expect(scripts).toContain("npm run check");
  });

  it("pins the Node version via .nvmrc", () => {
    const withs = workflow.jobs.check.steps
      .map((step) => step.with)
      .filter((w): w is Record<string, unknown> => w !== undefined);
    expect(withs.some((w) => w["node-version-file"] === ".nvmrc")).toBe(true);
  });
});
