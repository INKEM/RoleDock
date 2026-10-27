/** Probe renderer: only calls the closed-vocabulary window.roledock.probe API. */

interface CheckResult { name: string; pass: boolean; detail: string }
interface ProbeStatus {
  mode: string;
  runtimeNode: string;
  runtimeVersion: string | null;
  service: { state: string; pid: number | null; workspaceId: string | null; socketPath: string | null; error: string | null };
  events: Array<{ at: string; event: string; detail?: string }>;
}

declare global {
  interface Window {
    roledock: { probe: Record<string, (payload?: never) => Promise<unknown>> };
  }
}

async function call<T>(method: string): Promise<T | { ok: false; error: { message: string } }> {
  const entry = window.roledock.probe[method];
  if (typeof entry !== "function") throw new Error(`未知探针方法：${method}`);
  return (await entry()) as T | { ok: false; error: { message: string } };
}

function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function isFailure(reply: unknown): reply is { ok: false; error: { message: string } } {
  return typeof reply === "object" && reply !== null && "ok" in reply && (reply as { ok: unknown }).ok === false;
}

function renderStatus(status: ProbeStatus): void {
  const lines = [
    `mode=${status.mode}`,
    `runtime=${status.runtimeNode}`,
    `runtimeVersion=${status.runtimeVersion ?? "?"}`,
    `service.state=${status.service.state} pid=${status.service.pid ?? "-"}`,
    `workspaceId=${status.service.workspaceId ?? "-"}`,
    `socket=${status.service.socketPath ?? "-"}`,
    ...(status.service.error ? [`error=${status.service.error}`] : []),
  ];
  text("status", lines.join("\n"));
  const events = document.getElementById("events");
  if (events) {
    events.replaceChildren(...status.events.slice(-12).reverse().map(item => {
      const li = document.createElement("li");
      li.textContent = `${item.at} ${item.event}${item.detail ? ` — ${item.detail}` : ""}`;
      return li;
    }));
  }
}

async function refresh(): Promise<void> {
  const reply = await call<ProbeStatus>("getStatus");
  if (!isFailure(reply)) renderStatus(reply);
}

async function guarded(buttonId: string, action: () => Promise<void>): Promise<void> {
  const button = document.getElementById(buttonId) as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    text("status", `IPC 错误：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

function bind(id: string, action: () => Promise<void>): void {
  document.getElementById(id)?.addEventListener("click", () => void guarded(id, action));
}

bind("start", async () => {
  const reply = await call("startService");
  if (isFailure(reply)) text("status", `启动失败：${reply.error.message}`);
});
bind("stop", async () => {
  const reply = await call("stopService");
  if (isFailure(reply)) text("status", `停止失败：${reply.error.message}`);
});
bind("run-checks", async () => {
  const reply = await call<{ checks: CheckResult[] }>("runChecks");
  const list = document.getElementById("checks");
  if (!list) return;
  if (isFailure(reply)) { list.replaceChildren(); text("status", `检查失败：${reply.error.message}`); return; }
  list.replaceChildren(...reply.checks.map(check => {
    const li = document.createElement("li");
    li.textContent = `${check.pass ? "✅" : "❌"} ${check.name} — ${check.detail}`;
    return li;
  }));
});
bind("pick", async () => {
  const reply = await call<{ canceled: boolean; path: string | null }>("pickDirectory");
  if (!isFailure(reply)) text("picked", reply.canceled ? "（取消）" : reply.path ?? "");
});

void refresh();
