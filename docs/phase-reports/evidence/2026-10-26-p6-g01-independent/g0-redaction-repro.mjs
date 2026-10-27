// Independent G0 R01 revalidation. Synthetic metadata only; no credentials.
// Transform the current source in memory so stale dist files cannot affect evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const sourcePath = 'packages/desktop/src/probe/shared/bridge.ts';
const source = readFileSync(sourcePath, 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'node22' });
const { redact } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const publicHash = '0123456789abcdef'.repeat(4);
const input = {
  authorization_id: 'auth-public',
  active_authorization: { authorization_id: 'auth-public' },
  content_hash: publicHash,
  host_session_id: '0123456789abcdef'.repeat(2),
  event_ref: 'event-' + publicHash,
  token: 'SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL',
  message: 'Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected',
};
const output = redact(input);
const result = {
  source: sourcePath,
  input,
  output,
  checks: {
    authorization_id_preserved: output.authorization_id === input.authorization_id,
    active_authorization_preserved: output.active_authorization.authorization_id === input.authorization_id,
    secret_field_removed: !('token' in output),
    content_hash_preserved: output.content_hash === input.content_hash,
    host_session_id_preserved: output.host_session_id === input.host_session_id,
    event_ref_preserved: output.event_ref === input.event_ref,
  },
};
const json = JSON.stringify(result, null, 2) + '\n';
writeFileSync(new URL('g0-redaction-repro.json', import.meta.url), json);
process.stdout.write(json);
