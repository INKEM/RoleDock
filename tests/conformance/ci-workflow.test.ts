import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

describe("CI workflow", () => {
  // Shape assertion: if the workflow loses its check job, the parse-level
  // assertions below fail explicitly rather than on undefined access.
  const workflow = parse(readFileSync(workflowPath, "utf8")) as {
    jobs: {
      check: { "runs-on": string; steps: Array<Record<string, unknown>> };
    };
  };
  const check = workflow.jobs.check;

  it("parses as valid YAML with a check job", () => {
    expect(check["runs-on"]).toContain("ubuntu");
  });

  it("runs npm ci and the full check gate", () => {
    const scripts = check.steps
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string");
    expect(scripts).toContain("npm ci");
    expect(scripts).toContain("npm run check");
  });

  it("pins the Node version via .nvmrc", () => {
    const withs = check.steps
      .map((step) => step.with)
      .filter((w): w is Record<string, unknown> => w !== undefined);
    expect(withs.some((w) => w["node-version-file"] === ".nvmrc")).toBe(true);
  });
});
