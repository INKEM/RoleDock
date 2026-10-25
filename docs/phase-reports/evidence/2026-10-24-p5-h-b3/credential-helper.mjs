#!/usr/bin/env node
// B3 evidence-run artifact (NOT part of any package). Bridges the reference
// connector's credential-helper contract to this machine's own ZCode account
// store, the same mechanism the user's existing zcode-delegation connector
// uses (MIT-licensed TechYan/zcode_mcp handshake, see account.mjs). Scope:
// local evidence runs only; hashed in host-components.sha256; paths are not
// hardcoded into RoleDock packages.
import { createHash, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const IDS = ["account:bigmodel-team-coding-plan", "account:bigmodel-individual-coding-plan", "account:zai-team-coding-plan", "account:zai-individual-coding-plan"];
function decode(value) {
  if (!value.startsWith("enc:v1:")) return value;
  const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const parts = value.slice(7).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
}
function accountKey(providerId) {
  if (!IDS.includes(providerId)) return null;
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
  for (const [name, value] of Object.entries(JSON.parse(readFileSync(join(homedir(), ".zcode/v2/credentials.json"), "utf8")))) {
    if (name.startsWith(prefix) && name.endsWith(":api-key") && typeof value === "string" && value) { try { return decode(value); } catch { return null; } }
  }
  return null;
}
createInterface({ input: process.stdin }).on("line", line => {
  let req = {}; try { req = JSON.parse(line); } catch {}
  if (req.bootstrap !== undefined) {
    if (!existsSync(req.bootstrap.builtinPath ?? "")) { process.stdout.write(JSON.stringify({ error: "builtin config missing" }) + "\n"); return; }
    const revision = JSON.parse(readFileSync(req.bootstrap.builtinPath, "utf8")).revision;
    const result = bootstrap({ builtinRevision: revision, builtinPathHash: createHash("sha256").update(req.bootstrap.builtinPath).digest("hex") });
    process.stdout.write(JSON.stringify(result ?? { error: "helper has no preferred account" }) + "\n");
    return;
  }
  const key = req.providerId ? accountKey(req.providerId) : null;
  process.stdout.write(JSON.stringify(key ? { headersApplied: true, requestAuth: { apiKey: key } } : { headersApplied: false, errorMessage: "helper has no key for provider" }) + "\n");
});
// v2: also answers {bootstrap:{builtinRevision,builtinPathHash}} with the
// provider/updateAccountConfig params (registry registration, no secrets).
function preferredAccount() {
  if (process.env.ZCODE_PROVIDER && accountKey(process.env.ZCODE_PROVIDER)) return process.env.ZCODE_PROVIDER;
  return IDS.find(id => accountKey(id)) || null;
}
function bootstrap({ builtinRevision, builtinPathHash }) {
  const preferred = preferredAccount();
  if (!preferred || !builtinRevision) return null;
  const providers = {}, states = {};
  for (const id of IDS) {
    const entitled = Boolean(accountKey(id));
    providers[id] = { access: { type: "zhipu-account", entitled } };
    states[id] = { availability: entitled ? "available" : "unavailable", entitled, current: id === preferred };
  }
  return { preferred, params: { revision: `account:roledock-b3-evidence:${Date.now()}`, basedOnZCodeBuiltinRevision: `zcode-builtin:${builtinRevision}:${builtinPathHash}`, providers, states } };
}
