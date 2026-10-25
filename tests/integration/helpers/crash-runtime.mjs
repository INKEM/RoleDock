// Test-only child: terminate the coordinator process at durable/external boundaries.
import { join } from "node:path";
import { Coordinator } from "../../../packages/core/dist/index.js";
import { coordinatorStore } from "../../../packages/core/dist/internal-store.js";
import { executeRequest } from "../../../packages/core/dist/testing.js";
import { ProcessBridgeAdapter } from "../../../adapters/process-bridge/dist/index.js";

const [root, boundary, id] = process.argv.slice(2);
class ExitingBridge extends ProcessBridgeAdapter {
  async createSession(input) {
    if (boundary === "before-create") process.exit(71);
    const handle = await super.createSession(input);
    if (boundary === "after-create") process.exit(72);
    return handle;
  }
  async runTurn(handle, input) {
    if (boundary === "before-turn") process.exit(73);
    const result = await super.runTurn(handle, input);
    if (boundary === "after-turn") process.exit(74);
    return result;
  }
}
const adapter = new ExitingBridge({ stateDir: join(root, ".roledock", "crash-host") });
const coordinator = Coordinator.open({ root, adapter });
if (id) await executeRequest(coordinatorStore(coordinator), adapter, id);
else await coordinator.openSession({ role_id: "alpha", inherit: "latest", creation_key: "crash-successor" });
throw new Error("Exit boundary was not reached");
