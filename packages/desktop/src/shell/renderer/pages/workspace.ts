import { call, escapeHtml, guarded, type ShellSettings } from "../main.js";
import type { WorkspaceStatus } from "../main.js";

interface PreflightCheck { name: string; state: string; detail: string }
interface RecentWorkspace { path: string; label: string; lastOpenedAt: string }

export async function renderWorkspacePage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>工作空间与连接</h1>
    <section>
      <h2>打开</h2>
      <label>打开方式：
        <select id="mode"><option value="mock">mock（诊断）</option><option value="zcode">zcode（真实配置）</option></select>
      </label>
      <button id="open-dir">选择目录并打开…</button>
      <span id="open-error" class="note"></span>
      <div id="recent"></div>
      <div id="status"></div>
      <button id="refresh">刷新状态</button>
      <button id="stop">停止本应用启动的服务</button>
      <button id="restart">重启服务</button>
      <button id="new-window">新建窗口</button>
      <button id="diagnostics">诊断（运行信息与事件）</button>
    </section>
    <section>
      <h2>接入预检（只读，不创建会话、不消费模型）</h2>
      <button id="preflight">运行预检</button>
      <button id="test-connection">运行连接测试（独立动作）</button>
      <span id="conn-result" class="note"></span>
      <ul id="checks"></ul>
    </section>
    <section id="diag-section" class="hidden">
      <h2>诊断</h2>
      <div id="diag" class="log"></div>
    </section>
    <p class="note">附着的外部服务只连接、不停止；被其他进程持有或权限不符的端点会显示冲突，不会被覆盖。移除最近记录不会删除目录。</p>
  `;
  const statusBox = container.querySelector("#status") as HTMLElement;
  const recentBox = container.querySelector("#recent") as HTMLElement;

  const paint = (status: WorkspaceStatus) => { statusBox.innerHTML = renderStatusCard(status); };
  const showStatus = async () => paint(await call<WorkspaceStatus>("workspace", "status"));
  const showRecent = async () => {
    const settings = await call<ShellSettings>("settings", "get");
    const items = settings.recentWorkspaces;
    recentBox.innerHTML = items.length === 0
      ? `<span class="note">（暂无最近工作空间）</span>`
      : `<label>最近工作空间</label>` + items.map(item =>
          `<div><button class="recent" data-path="${escapeHtml(item.path)}">${escapeHtml(item.label)}</button> ` +
          `<span class="note">${escapeHtml(item.path)}</span> ` +
          `<button class="remove-recent" data-path="${escapeHtml(item.path)}">移除记录</button></div>`).join("");
    recentBox.querySelectorAll<HTMLButtonElement>(".recent").forEach(button => {
      button.addEventListener("click", guarded(async () => {
        paint(await openDir(button.dataset.path!));
      }));
    });
    recentBox.querySelectorAll<HTMLButtonElement>(".remove-recent").forEach(button => {
      button.addEventListener("click", guarded(async () => {
        await call("workspace", "removeRecent", { path: button.dataset.path });
        await showRecent();
      }));
    });
  };
  const openDir = async (dir: string): Promise<WorkspaceStatus> => {
    const mode = (container.querySelector("#mode") as HTMLSelectElement).value as "mock" | "zcode";
    try {
      (container.querySelector("#open-error") as HTMLElement).textContent = "";
      return await call<WorkspaceStatus>("workspace", "open", { dir, launcher: mode });
    } catch (error) {
      (container.querySelector("#open-error") as HTMLElement).textContent = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  await showStatus();
  await showRecent();

  // Bounded status polling (2s): crashes and disconnects surface without user
  // action; stops once the page is navigated away.
  const auto = setInterval(() => {
    if (!document.body.contains(statusBox)) { clearInterval(auto); return; }
    void (async () => { try { paint(await call<WorkspaceStatus>("workspace", "status")); } catch { /* error boundary shows it */ } })();
  }, 2000);

  container.querySelector("#open-dir")!.addEventListener("click", guarded(async () => {
    const picked = await call<{ canceled: boolean; path: string | null }>("workspace", "pickDirectory");
    if (picked.canceled || !picked.path) return;
    paint(await openDir(picked.path));
    await showRecent();
  }));
  container.querySelector("#refresh")!.addEventListener("click", guarded(async () => { paint(await call<WorkspaceStatus>("workspace", "refresh")); }));
  container.querySelector("#stop")!.addEventListener("click", guarded(async () => { paint(await call<WorkspaceStatus>("workspace", "stop")); }));
  container.querySelector("#restart")!.addEventListener("click", guarded(async () => { paint(await call<WorkspaceStatus>("workspace", "restart")); }));
  container.querySelector("#new-window")!.addEventListener("click", guarded(async () => { await call("workspace", "openWindow"); }));
  container.querySelector("#diagnostics")!.addEventListener("click", guarded(async () => {
    const data = await call<{ workspace_id: string; service: { version: string; pid: number; started_at: string; adapter: string; runtime: string }; events: Array<{ id: number; kind: string; state: string; created_at: string }> }>("workspace", "diagnostics");
    const section = container.querySelector("#diag-section") as HTMLElement;
    section.classList.remove("hidden");
    const diag = container.querySelector("#diag") as HTMLElement;
    diag.textContent = [
      `workspace_id=${data.workspace_id}`,
      `service.version=${data.service.version} adapter=${data.service.adapter} runtime=${data.service.runtime}`,
      `service.pid=${data.service.pid} started_at=${data.service.started_at}`,
      ...data.events.map(event => `${event.created_at} #${event.id} ${event.kind} ${event.state}`),
    ].join("\n");
  }));
  container.querySelector("#preflight")!.addEventListener("click", guarded(async () => {
    const checks = await call<PreflightCheck[]>("workspace", "preflight");
    const list = container.querySelector("#checks") as HTMLElement;
    list.replaceChildren(...checks.map(check => {
      const li = document.createElement("li");
      li.textContent = `${check.state === "ok" ? "✅" : check.state === "degraded" ? "🟡" : check.state === "missing" ? "⛔" : "❌"} ${check.name}（${check.state}）— ${check.detail}`;
      return li;
    }));
  }));
  container.querySelector("#test-connection")!.addEventListener("click", guarded(async () => {
    const result = await call<{ server: { name: string; version: string } | null; toolCount: number }>("workspace", "testConnection");
    (container.querySelector("#conn-result") as HTMLElement).textContent =
      `握手成功：server=${result.server ? `${result.server.name}@${result.server.version}` : "（未声明）"}，工具 ${result.toolCount} 个（零会话、零模型轮）`;
  }));
}

function renderStatusCard(status: WorkspaceStatus): string {
  if (!status.foregroundDir) return `<div class="card">尚未打开工作空间。</div>`;
  const lines = [
    `目录：${status.foregroundDir}`,
    `workspace_id：${status.workspaceId ?? "—"}`,
    `状态：${status.state}${status.owned ? "（本应用启动）" : "（附着的外部服务）"}　模式：${status.mode ?? "—"}`,
    `pid：${status.pid ?? "—"}　socket：${status.socketPath ?? "—"}`,
    `最后刷新：${status.lastRefreshAt ?? "—"}`,
    status.error ? `错误：${status.error}` : "",
    status.state === "running" && status.owned ? "提示：关闭窗口不会停止该服务；退出应用才会停止本应用启动的服务。" : "",
  ];
  return `<div class="card">${lines.filter(Boolean).map(line => `${escapeHtml(line)}<br>`).join("")}</div>`;
}
