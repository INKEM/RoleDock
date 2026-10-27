import { call, escapeHtml, guarded } from "../main.js";

interface RoleSummary { role_id: string; title: string; initialized: boolean; generation: number; requested_capabilities: string[]; granted_capabilities: string[] }
interface RoleDetails {
  role_id: string; title: string; instructions: string; description?: string;
  pack: { name: string; version: string; content_hash: string };
  initialized: boolean; generation: number; knowledge_revision: number; current_instance_id: string | null;
  requested_capabilities: string[]; granted_capabilities: string[];
  documents: Array<{ key: string; title?: string; visibility: string; description?: string; template: string }>;
  output_schemas: Array<{ key: string; schema: string }>;
}

/** Role library (DESKTOP_GUI_PLAN §10): install, details, requested-vs-granted
 * policy editing with read-back. Selecting a role opens NO session — anchoring
 * stays in G3; no anchor UI exists on this page by design. */
export async function renderRolesPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>角色库</h1>
    <section>
      <button id="install">从目录安装角色包…</button>
      <span id="install-note" class="note"></span>
      <table id="list"><thead><tr><th>角色</th><th>状态</th><th>代次</th><th>已授 / 需求能力</th><th></th></tr></thead><tbody></tbody></table>
      <p class="note">initialized 仅表示已有代次，不等于当前可服务主实例；选择角色不会打开会话（锚定由原会话完成）。安装不会自动授予任何能力。</p>
    </section>
    <section id="details" class="hidden">
      <h2 id="details-title"></h2>
      <div id="details-body"></div>
      <h3>策略（需求 vs 已授予）</h3>
      <table id="policy"><thead><tr><th>能力</th><th>需求</th><th>已授予</th><th>操作</th></tr></thead><tbody></tbody></table>
      <div id="policy-note" class="note"></div>
    </section>
  `;
  const tbody = container.querySelector("#list tbody") as HTMLElement;
  const loadList = guarded(async () => {
    const reply = await call<{ roles: RoleSummary[] }>("roles", "list");
    tbody.replaceChildren(...reply.roles.map(role => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${escapeHtml(role.role_id)}（${escapeHtml(role.title)}）</td>` +
        `<td>${role.initialized ? `已初始化 · 代次 ${role.generation}` : "未初始化"}</td>` +
        `<td>${role.generation}</td>` +
        `<td>${role.granted_capabilities.length} / ${role.requested_capabilities.length}</td>` +
        `<td><button data-role="${escapeHtml(role.role_id)}">详情</button></td>`;
      row.querySelector("button")!.addEventListener("click", guarded(async () => { await showDetails(role.role_id); }));
      void 0;
      return row;
    }));
    if (reply.roles.length === 0) tbody.innerHTML = `<tr><td colspan="5">（尚未安装角色包）</td></tr>`;
  });
  const loadDetails = async (roleId: string): Promise<RoleDetails> => {
    const details = await call<RoleDetails>("roles", "get", { role_id: roleId });
    const section = container.querySelector("#details") as HTMLElement;
    section.classList.remove("hidden");
    (container.querySelector("#details-title") as HTMLElement).textContent = `详情：${details.role_id}（${details.title}）`;
    const granted = new Set(details.granted_capabilities);
    const body = container.querySelector("#details-body") as HTMLElement;
    body.innerHTML = [
      `<b>职责</b>（安装快照正文）<pre>${escapeHtml(details.instructions)}</pre>`,
      details.description ? `<div>描述：${escapeHtml(details.description)}</div>` : "",
      `<div>角色包：${escapeHtml(details.pack.name)}@${escapeHtml(details.pack.version)}　内容哈希：<code>${escapeHtml(details.pack.content_hash)}</code></div>`,
      `<div>协调状态：${details.initialized ? `已初始化 · 代次 ${details.generation} · 知识修订 ${details.knowledge_revision}` : "未初始化（尚无主代次，不等于不可安装/配置）"}　主指针：${escapeHtml(details.current_instance_id ?? "（无）")}</div>`,
      ...details.documents.map(document =>
        `<div><b>文档模板</b> ${escapeHtml(document.key)}（${escapeHtml(document.visibility)}${document.title ? ` · ${escapeHtml(document.title)}` : ""}）</div>` +
        `<pre>${escapeHtml(document.template)}</pre>`),
      ...details.output_schemas.map(schema =>
        `<div><b>输出 Schema</b> ${escapeHtml(schema.key)}</div><pre>${escapeHtml(schema.schema)}</pre>`),
    ].filter(Boolean).join("");
    const policyBody = container.querySelector("#policy tbody") as HTMLElement;
    const capabilities = [...new Set([...details.requested_capabilities, ...details.granted_capabilities])];
    policyBody.replaceChildren(...capabilities.map(capability => {
      const requested = details.requested_capabilities.includes(capability);
      const isGranted = granted.has(capability);
      const row = document.createElement("tr");
      row.innerHTML = `<td>${escapeHtml(capability)}</td>` +
        `<td>${requested ? "✓" : "—（超需求授予）"}</td>` +
        `<td>${isGranted ? "✓" : "—"}</td>` +
        `<td><button>${isGranted ? "撤销" : "授予"}</button></td>`;
      row.querySelector("button")!.addEventListener("click", guarded(async () => {
        await (isGranted ? call("roles", "revoke", { role_id: roleId, capability }) : call("roles", "grant", { role_id: roleId, capability }));
        await loadDetails(roleId);
        await loadList();
      }));
      return row;
    }));
    (container.querySelector("#policy-note") as HTMLElement).textContent = "变更即时回读；撤销后该角色的下一次核心动作将按策略拒绝。";
    return details;
  };
  const showDetails = async (roleId: string): Promise<void> => { await loadDetails(roleId); };

  container.querySelector("#install")!.addEventListener("click", guarded(async () => {
    const picked = await call<{ canceled: boolean; path: string | null }>("workspace", "pickDirectory");
    if (picked.canceled || !picked.path) return;
    const result = await call<{ roles: RoleSummary[] }>("roles", "install", { dir: picked.path });
    (container.querySelector("#install-note") as HTMLElement).textContent = `已安装/更新：${result.roles.map(role => role.role_id).join("、")}（不自动授予能力）`;
    await loadList();
  }));
  await loadList();
}
