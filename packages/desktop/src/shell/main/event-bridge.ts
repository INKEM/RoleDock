import { ServiceClient } from "@roledock/service";
import type { PendingHumanEventView } from "@roledock/protocol";

/**
 * G3 trusted event-progress bridge (ADR-0014 §9.3, desktop-gui-contract
 * §9.3): while the foreground workspace is running, poll the trusted face
 * `authorizations.pendingEvents` and advance each stored human event to an
 * authorization via the idempotent `authorizations.recordHuman`. The bridge
 * runs only in the desktop main process; its credentials never cross to the
 * renderer. Anchoring is NEVER done here — the Agent must call
 * `sessions.anchor` in the original session, and the GUI only observes.
 *
 * Least privilege: every recordHuman uses a one-shot trusted credential
 * whose ceiling is exactly the confirmed event's capabilities; registration
 * uses the union of installed roles' requested ∪ granted capabilities.
 */
export const BRIDGE_SUBJECT = "desktop-event-bridge";

interface PendingEventsPage { workspace_id: string; observed_at: string; items: PendingHumanEventView[] }
interface TrustReply { socket_path: string; token: string }

export interface BridgeStatus { running: boolean; lastTickAt: string | null; advanced: number; lastError: string | null }

export class EventProgressBridge {
  readonly #ownerClient: () => ServiceClient;
  readonly #intervalMs: number;
  readonly #writeSessionCredential: (workspaceDir: string, credential: { socket_path: string; token: string }) => string;
  #activeDir: string | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #status: BridgeStatus = { running: false, lastTickAt: null, advanced: 0, lastError: null };

  constructor(options: { ownerClient: () => ServiceClient; intervalMs?: number; writeSessionCredential: (workspaceDir: string, credential: { socket_path: string; token: string }) => string }) {
    this.#ownerClient = options.ownerClient;
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#writeSessionCredential = options.writeSessionCredential;
  }

  get status(): BridgeStatus { return { ...this.#status }; }

  /** Start (or re-target) polling for the foreground workspace. */
  start(workspaceDir: string): void {
    this.stop();
    this.#activeDir = workspaceDir;
    this.#status = { ...this.#status, running: true, lastError: null };
    this.#timer = setInterval(() => { void this.#tick(); }, this.#intervalMs);
    this.#timer.unref?.();
    void this.#tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#activeDir = null;
    this.#status = { ...this.#status, running: false };
  }

  async #tick(): Promise<void> {
    const dir = this.#activeDir;
    if (!dir || this.#ticking) return;
    this.#ticking = true;
    try {
      const owner = this.#ownerClient();
      // Poll with a no-ceiling trusted identity: reading pending events
      // consults no capability ceiling; the subject fixes the session scope.
      const poller = new ServiceClient(await owner.call<TrustReply>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: [] }));
      const page = await poller.call<PendingEventsPage>("authorizations.pendingEvents", {});
      for (const event of page.items) await this.#advance(owner, event);
      this.#status = { ...this.#status, lastTickAt: new Date().toISOString(), lastError: null };
    } catch (error) {
      // Honest failure: visible in diagnostics, never reported as progress.
      this.#status = { ...this.#status, lastTickAt: new Date().toISOString(), lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally {
      this.#ticking = false;
    }
  }

  /** One-shot trusted credential scoped to exactly this event's capabilities. */
  async #advance(owner: ServiceClient, event: PendingHumanEventView): Promise<void> {
    const scoped = new ServiceClient(await owner.call<TrustReply>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: event.capabilities }));
    await scoped.call("authorizations.recordHuman", { external_session_id: event.external_session_id, event_ref: event.event_ref });
    this.#status = { ...this.#status, advanced: this.#status.advanced + 1 };
  }

  /**
   * G3 §9.1: register an original session as this bridge's trusted subject
   * and write the returned session credential to the workspace's MCP env
   * file (the only handoff of a session bearer). Ceiling: the union of
   * installed roles' requested and granted capabilities at registration
   * time; confirmations outside it fail honestly at recordHuman.
   */
  async registerOriginalSession(workspaceDir: string, hostSessionId: string): Promise<{ external_session_id: string; envFile: string }> {
    const owner = this.#ownerClient();
    const roles = await owner.call<{ roles?: Array<{ requested_capabilities?: string[]; granted_capabilities?: string[] }> }>("roles.list", {});
    const ceiling = [...new Set((roles.roles ?? []).flatMap(role => [...(role.requested_capabilities ?? []), ...(role.granted_capabilities ?? [])]))].sort();
    const trusted = new ServiceClient(await owner.call<TrustReply>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: ceiling }));
    const registered = await trusted.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: hostSessionId });
    const envFile = this.#writeSessionCredential(workspaceDir, registered.credential);
    void this.#tick();
    return { external_session_id: registered.external_session.external_session_id, envFile };
  }

  /** G3 §9.1: read-only host session discovery through the trusted face. */
  async discoverHostSessions(): Promise<{ adapter: string; items: Array<{ host_session_id: string; title: string | null; status: string | null; kind: string | null; updated_at: string | null; registered_external_session_id: string | null }> }> {
    const owner = this.#ownerClient();
    const poller = new ServiceClient(await owner.call<TrustReply>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: [] }));
    return poller.call("externalSessions.discover", {});
  }
}
