import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLauncherConfigFile } from "../src/shell/shared/launcher.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "launcher-")); dirs.push(dir); return dir; }

const CONFIG = { kind: "zcode" as const, cliPath: "/cli", connectorPath: "/connector" };

describe("G2-R05 launcher config write safety", () => {
  it("first write and update succeed with 0600", () => {
    const dir = temp();
    const path = writeLauncherConfigFile(dir, CONFIG);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const updated = writeLauncherConfigFile(dir, { ...CONFIG, provider: "glm" });
    expect(JSON.parse(readFileSync(updated, "utf8"))).toMatchObject({ provider: "glm" });
  });

  it("a symlinked config endpoint is refused and its target is fully preserved", () => {
    const dir = temp();
    mkdirSync(join(dir, ".roledock"), { recursive: true });
    const target = join(dir, "existing-notes.txt");
    writeFileSync(target, "SYNTHETIC_SENTINEL_NOTES");
    const before = lstatSync(target);
    symlinkSync(target, join(dir, ".roledock", "launcher-config.json"));
    expect(() => writeLauncherConfigFile(dir, CONFIG)).toThrow(/拒绝覆盖/);
    // Target content, permissions and identity fully preserved; the symlink
    // itself is still in place (replaced by nothing).
    expect(readFileSync(target, "utf8")).toBe("SYNTHETIC_SENTINEL_NOTES");
    expect(lstatSync(target).mode.toString(8)).toBe(before.mode.toString(8));
    expect(lstatSync(join(dir, ".roledock", "launcher-config.json")).isSymbolicLink()).toBe(true);
  });

  it("a symlinked .roledock state directory is refused", () => {
    const dir = temp();
    const elsewhere = temp();
    mkdirSync(join(elsewhere, "state"), { recursive: true });
    symlinkSync(join(elsewhere, "state"), join(dir, ".roledock"));
    expect(() => writeLauncherConfigFile(dir, CONFIG)).toThrow(/不是真实目录/);
    // The symlink target directory must not have received any config file.
    const names = readdirSync(join(elsewhere, "state"));
    expect(names).toEqual([]);
  });
});
