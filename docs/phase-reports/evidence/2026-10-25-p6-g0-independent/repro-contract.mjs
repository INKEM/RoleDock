import { readFileSync } from 'node:fs';
import { redact } from '../../../../packages/desktop/dist/probe/shared/bridge.js';
const root = new URL('../../../../', import.meta.url);
const source = {
  authorization_id: 'auth-public-id',
  active_authorization: { authorization_id: 'auth-public-id', state: 'active' },
  body: 'Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL',
  message: 'token=SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL',
};
const filtered = redact(source);
const schema = JSON.parse(readFileSync(new URL('packages/protocol/schemas/collaboration-request.schema.json', root), 'utf8'));
console.log(JSON.stringify({ label:'redaction_contract_counterexample', input:source, output:filtered,
  public_identifier_lost:!('authorization_id' in filtered),
  authorization_view_lost:!('active_authorization' in filtered),
  synthetic_marker_in_text_preserved:JSON.stringify(filtered).includes('SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL') }));
console.log(JSON.stringify({ label:'cancel_state_contract', actual_states:schema.properties.state.enum,
  awaiting_is_valid:schema.properties.state.enum.includes('awaiting'),
  awaiting_input_is_valid:schema.properties.state.enum.includes('awaiting_input') }));
