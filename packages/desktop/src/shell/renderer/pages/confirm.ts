import { call, escapeHtml, guarded, type ConfirmRoleView, type ConfirmSessionView, type WorkspaceStatus } from "../main.js";
import type { AuthorizationConfirmationsPage, ConfirmationChainEntry, SessionBindingsPage, AnchorAttemptsPage, AnchorLoadsPage, RevokePreview } from "../../shared/contract.js";

/**
 * Production confirm page (G3, desktop-gui-contract §9): original-session
 * discovery/registration, the human confirmation form with capability and
 * takeover preview, and the confirmation progress chain. The page only
 * OBSERVES anchoring — the Agent must call sessions.anchor in the original
 * session; "确认"永远只表示事件已存储，不是绑定。
 * G4 (desktop-gui-contract §2.2/§12): session observability — bindings/
 * attempts/loads read views with generation timeline, connection vs role
 * validity shown SEPARATELY, and the revoke surface (preview first, revoke
 * is explicit; release stays with the original session).
 */
export async function renderConfirmPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>授权与会话（受信所有者入口）</h1>
    <p class="note">确认将以 <b>entry=gui-confirm</b> 写入一条真人授权事件（内容寻址、幂等：重复点击/刷新不会产生重复授权）。存储本身不授权：授权由受信桥的 recordHuman 链产生，<b>锚定由 Agent 在原会话显式调用 sessions.anchor 完成</b>。确认不是绑定。拒绝 = 不操作。</p>
    <section>
      <button id="reload">重新加载</button>
      <button id="discover">发现宿主会话</button>
      <h2>登记原会话</h2>
      <p class="hint">在 ZCode 桌面打开你要使用的原会话后点击“发现宿主会话”；选择你本人的会话登记。发现不可用时，可粘贴该会话的会话引用（host_session_id）。登记成功后，把 <code>&lt;工作空间&gt;/.roledock/mcp-session.env</code> 配置为该会话 MCP 服务器的 <code>ROLEDOCK_CREDENTIAL_FILE</code>。</p>
      <div id="discover-area" class="discover"></div>
      <div class="paste-row">
        <input id="paste-ref" placeholder="粘贴 host_session_id（例如 sess_… / session_…）" />
        <button id="paste-register">登记引用</button>
      </div>
      <h2>已登记会话与确认</h2>
      <table id="sessions">
        <thead><tr><th>外部会话</th><th>宿主会话 / 主体</th><th>现存有效授权</th><th>确认角色</th><th>能力（对照实际授权）</th><th>继承</th><th>有效期</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <h2>确认进度链</h2>
      <p class="hint">事件已保存 → 授权已生成 → 等待 Agent 锚定 → 载入中 → active / failed / uncertain，各阶段分开展示。</p>
      <div id="chains" class="chains">正在加载…</div>
      <h2>会话观察（代次 · 载入 · 撤销）</h2>
      <p class="hint"><b>连接状态与角色有效性分列显示</b>：服务断开不代表授权被撤销，expired/revoked 也不会显示为 active。释放（release）只能由原会话执行，这里不提供释放入口。“撤销已生效”与“外部会话进程已结束”是两回事，分开展示。</p>
      <div id="observability" class="chains">正在加载…</div>
      <h2>撤销影响预览</h2>
      <p class="hint">先预览、后撤销：预览展示将失效的绑定与将被撤权的委派请求；撤销是显式写操作，需再次确认。</p>
      <div id="revoke-area" class="discover"></div>
      <div id="log" class="log"></div>
    </section>
  `;
  const log = container.querySelector("#log") as HTMLElement;
  const tbody = container.querySelector("#sessions tbody") as HTMLElement;
  const discoverArea = container.querySelector("#discover-area") as HTMLElement;
  const chains = container.querySelector("#chains") as HTMLElement;
  const logLine = (message: string) => { log.textContent += message + "\n"; };

  const load = guarded(async () => {
    const [sessions, roles] = await Promise.all([
      call<{ external_sessions: ConfirmSessionView[] }>("confirm", "listSessions"),
      call<{ roles: ConfirmRoleView[] }>("confirm", "listRoles"),
    ]);
    tbody.textContent = "";
    for (const item of sessions.external_sessions) {
      const row = document.createElement("tr");
      const options = roles.roles.map(role => `<option value="${escapeHtml(role.role_id)}" data-caps="${escapeHtml((role.requested_capabilities ?? []).join(","))}">${escapeHtml(role.role_id)}（${role.initialized ? `takeover · 当前代次 ${role.generation}` : "initialize"}）</option>`).join("");
      row.innerHTML = `
        <td>${escapeHtml(item.session.external_session_id)}</td>
        <td>${escapeHtml(item.session.host_session_id)}<br>${escapeHtml(item.session.connection_subject)}</td>
        <td>${item.active_authorization ? `<span class="auth">${escapeHtml(item.active_authorization.role_id)} @ ${escapeHtml(item.active_authorization.expires_at)}</span>` : "—"}</td>
        <td><select class="role">${options}</select></td>
        <td><input class="caps" /></td>
        <td><select class="inherit"><option value="initialize">initialize</option><option value="takeover">takeover（接任当前主实例）</option></select></td>
        <td><select class="hours"><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option><option value="168">7 天</option></select></td>
        <td><button>确认</button></td>`;
      const capsInput = row.querySelector(".caps") as HTMLInputElement;
      const roleSelect = row.querySelector(".role") as HTMLSelectElement;
      const grantSet = new Set(roles.roles.find(role => role.role_id === roleSelect.value)?.granted_capabilities ?? []);
      const renderDiff = () => {
        const chosen = capsInput.value.split(",").map(entry => entry.trim()).filter(Boolean);
        const diff = chosen.map(cap => `${cap}${grantSet.has(cap) ? "（已授予）" : "（未授予——锚定后不生效）"}`).join("，");
        let preview = row.querySelector(".diff") as HTMLElement | null;
        if (!preview) { preview = document.createElement("div"); preview.className = "diff"; capsInput.after(preview); }
        preview.textContent = diff;
      };
      const syncCaps = () => {
        const selected = roles.roles.find(role => role.role_id === roleSelect.value);
        capsInput.value = (selected?.requested_capabilities ?? []).join(",");
        renderDiff();
      };
      roleSelect.addEventListener("change", syncCaps);
      capsInput.addEventListener("input", renderDiff);
      syncCaps();
      row.querySelector("button")!.addEventListener("click", guarded(async () => {
        const button = row.querySelector("button") as HTMLButtonElement;
        // Stable action ID + disabled button: double clicks and refreshes
        // replay the same confirmation intent instead of writing a new event.
        button.disabled = true;
        button.textContent = "提交中…";
        try {
          const payload = {
            external_session_id: item.session.external_session_id,
            role_id: roleSelect.value,
            capabilities: capsInput.value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0),
            inherit: (row.querySelector(".inherit") as HTMLSelectElement).value,
            expires_hours: Number((row.querySelector(".hours") as HTMLSelectElement).value),
          };
          const result = await call<{ event_ref: string; entry: string }>("confirm", "submit", payload);
          logLine(`已确认 event_ref=${result.event_ref} entry=${result.entry}（事件已存储；等待受信推进与 Agent 锚定）`);
        } finally {
          button.disabled = false;
          button.textContent = "确认";
        }
        await load();
      }));
      tbody.appendChild(row);
    }
    if (sessions.external_sessions.length === 0) logLine("当前没有已登记的外部会话：可先在上方登记原会话（发现或粘贴引用）。");
  });

  const renderDiscovery = guarded(async () => {
    discoverArea.innerHTML = "正在发现宿主会话…";
    const reply = await call<{ adapter: string; items: Array<{ host_session_id: string; title: string | null; status: string | null; kind: string | null; updated_at: string | null; registered_external_session_id: string | null }>; error: string | null }>("confirm", "discoverSessions");
    if (reply.error) {
      discoverArea.innerHTML = `<div class="warn">发现不可用（${escapeHtml(reply.error)}）。请使用下方粘贴引用入口。</div>`;
      return;
    }
    if (reply.items.length === 0) { discoverArea.innerHTML = `<div class="warn">宿主（${escapeHtml(reply.adapter)}）没有可枚举的持久化会话；请使用粘贴引用入口。</div>`; return; }
    const rows = reply.items.map(item => `
      <tr>
        <td>${escapeHtml(item.host_session_id)}</td>
        <td>${escapeHtml(item.title ?? "—")}</td>
        <td>${escapeHtml(item.status ?? "—")} / ${escapeHtml(item.kind ?? "—")}</td>
        <td>${escapeHtml(item.updated_at ?? "—")}</td>
        <td>${item.registered_external_session_id ? `<span class="auth">已登记 ${escapeHtml(item.registered_external_session_id)}</span>` : `<button data-host="${escapeHtml(item.host_session_id)}">登记</button>`}</td>
      </tr>`).join("");
    discoverArea.innerHTML = `
      <table><thead><tr><th>宿主会话</th><th>标题</th><th>状态/类型</th><th>更新时间</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint">只显示会话元数据，不读取聊天内容。请选择你本人在 ZCode 桌面打开的会话。</p>`;
    for (const button of discoverArea.querySelectorAll<HTMLButtonElement>("button[data-host]")) {
      button.addEventListener("click", guarded(async () => {
        button.disabled = true;
        button.textContent = "登记中…";
        try {
          const result = await call<{ external_session_id: string; envFile: string }>("confirm", "registerSession", { host_session_id: button.dataset.host });
          logLine(`已登记 ${result.external_session_id}；会话凭据已写入 ${result.envFile}（0600）。请把它配置为该会话 MCP 的 ROLEDOCK_CREDENTIAL_FILE。`);
        } finally { button.disabled = false; button.textContent = "登记"; }
        await Promise.all([renderDiscovery(), load()]);
      }));
    }
  });

  (container.querySelector("#paste-register") as HTMLButtonElement).addEventListener("click", guarded(async () => {
    const input = container.querySelector("#paste-ref") as HTMLInputElement;
    const hostSessionId = input.value.trim();
    if (!hostSessionId) throw new Error("请先粘贴 host_session_id。");
    const result = await call<{ external_session_id: string; envFile: string }>("confirm", "registerSession", { host_session_id: hostSessionId });
    logLine(`已登记 ${result.external_session_id}；会话凭据已写入 ${result.envFile}（0600）。`);
    input.value = "";
    await Promise.all([renderDiscovery(), load()]);
  }));

  const stageOf = (entry: ConfirmationChainEntry): string => {
    const attempt = entry.anchor_attempt;
    if (entry.binding && entry.binding.state === "active") return `active · 角色 ${escapeHtml(entry.binding.role_id)} @ 代次 ${entry.binding.generation}${entry.binding.state !== "active" ? `（${escapeHtml(entry.binding.state)}）` : ""}`;
    if (attempt?.state === "active") return "active";
    if (attempt?.state === "loading" || attempt?.state === "prepared") return "载入中（材料载入由 Agent 的锚定触发）";
    if (attempt?.state === "uncertain") return `载入不确定（错误 ${escapeHtml(attempt.error?.code ?? "—")}；Agent 可在原会话 sessions.reconcile）`;
    if (attempt?.state === "failed") return `锚定失败：${escapeHtml(attempt.error?.code ?? "")} ${escapeHtml(attempt.error?.message ?? "")}`;
    if (entry.events.some(event => event.authorization && !event.authorization.revoked_at)) return "等待 Agent 在原会话显式调用 sessions.anchor";
    return "等待受信推进（事件已存储，授权尚未生成）";
  };

  const renderChains = (page: AuthorizationConfirmationsPage) => {
    chains.innerHTML = page.items.length === 0 ? "尚无已登记会话。" : page.items.map(entry => {
      const events = entry.events.map(event => `
          <li>事件 ${escapeHtml(event.event_ref)}（${escapeHtml(event.role_id)} · ${escapeHtml(event.inherit)} · 至 ${escapeHtml(event.expires_at)} · entry=${escapeHtml(event.entry)}）
            → ${event.authorization
              ? `授权已生成 ${escapeHtml(event.authorization.authorization_id)}（预期代次 ${event.authorization.expected_generation}${event.authorization.revoked_at ? `，已撤销 ${escapeHtml(event.authorization.revoked_at)}` : ""}）`
              : "授权尚未生成"}</li>`).join("");
      const binding = entry.binding ? `<div>绑定：${escapeHtml(entry.binding.role_id)} @ 代次 ${entry.binding.generation}（${escapeHtml(entry.binding.state)}，session ${escapeHtml(entry.binding.session_id)}）</div>` : "";
      return `<div class="chain"><b>${escapeHtml(entry.external_session_id)}</b>（host ${escapeHtml(entry.host_session_id)}）：<span class="stage">${stageOf(entry)}</span>
          <ul>${events}</ul>${binding}<div class="hint">观察时间：${escapeHtml(page.observed_at)}</div></div>`;
    }).join("");
  };

  // -- G4 会话观察（desktop-gui-contract §2.2/§12）--------------------------

  const obs = container.querySelector("#observability") as HTMLElement;
  const revokeArea = container.querySelector("#revoke-area") as HTMLElement;
  const VALIDITY_TEXT: Record<string, string> = {
    active: "有权工作（active）",
    superseded: "已被接任（superseded）——当前主实例已易主",
    released: "已释放（released）——释放由原会话执行",
    revoked: "已撤销（revoked）——授权已失效",
    expired: "已过期（expired）",
  };
  const NEXT_STEP: Record<string, string> = {
    uncertain: "下一步：回到原会话执行 sessions.reconcile 对账。",
    failed: "下一步：查看失败原因；如需继续，重新确认授权并锚定。",
    released: "下一步：回原会话重新确认授权后锚定新会话。",
    revoked: "下一步：如需继续，重新确认授权并锚定。撤销已在 RoleDock 生效；外部会话进程是否结束以宿主为准。",
    expired: "下一步：授权已过期；重新确认授权并锚定。",
  };
  // 陈旧/跨工作空间守卫（ADR-0013 决策 7）：按视图记录最后应用的
  // observed_at；workspace_id 不匹配或时间倒退的响应一律丢弃。
  const appliedAt: Record<string, string> = {};
  const fresh = (key: string, workspaceId: string, observedAt: string): boolean => {
    const current = appliedAt["workspace"];
    if (current !== undefined && current !== workspaceId) return false;
    appliedAt["workspace"] = workspaceId;
    const last = appliedAt[key];
    if (last !== undefined && observedAt < last) return false;
    appliedAt[key] = observedAt;
    return true;
  };
  const short = (value: string): string => (value.length > 14 ? `${value.slice(0, 14)}…` : value);

  const renderObservability = async (confirmations: AuthorizationConfirmationsPage | null): Promise<void> => {
    if (!container.isConnected) return;
    let status: WorkspaceStatus;
    try { status = await call<WorkspaceStatus>("workspace", "status"); } catch { return; }
    if (!container.isConnected) return;
    if (status.state !== "running" || !status.workspaceId) {
      obs.innerHTML = `<div class="warn">服务${status.state === "closed" ? "未打开" : `不可用（${escapeHtml(status.state)}）`}——这是连接状态，不是授权撤销；角色有效性以服务端数据为准。</div>`;
      return;
    }
    let bindings: SessionBindingsPage, attempts: AnchorAttemptsPage, loads: AnchorLoadsPage;
    try {
      [bindings, attempts, loads] = await Promise.all([
        call<SessionBindingsPage>("sessions", "listBindings", { limit: 200 }),
        call<AnchorAttemptsPage>("sessions", "listAttempts", { limit: 200 }),
        call<AnchorLoadsPage>("sessions", "listLoads", { limit: 200 }),
      ]);
    } catch { return; }
    if (!container.isConnected) return;
    if (!fresh("bindings", bindings.workspace_id, bindings.observed_at) ||
        !fresh("attempts", attempts.workspace_id, attempts.observed_at) ||
        !fresh("loads", loads.workspace_id, loads.observed_at)) return;

    const sessionIds = new Set<string>([...bindings.items.map(row => row.external_session_id), ...attempts.items.map(row => row.external_session_id)]);
    // 有效授权（可撤销）来自确认链：已生成且未撤销未过期。
    const liveAuths = new Map<string, { authorization_id: string; role_id: string; expires_at: string; external_session_id: string }>();
    for (const entry of confirmations?.items ?? []) {
      for (const event of entry.events) {
        if (event.authorization && !event.authorization.revoked_at && Date.parse(event.expires_at) > Date.now()) {
          liveAuths.set(event.authorization.authorization_id, { authorization_id: event.authorization.authorization_id, role_id: event.role_id, expires_at: event.expires_at, external_session_id: entry.external_session_id });
        }
      }
    }
    const blocks: string[] = [];
    for (const sessionId of [...sessionIds].sort()) {
      const rows = bindings.items.filter(row => row.external_session_id === sessionId);
      const sessionAttempts = attempts.items.filter(row => row.external_session_id === sessionId).slice().reverse();
      const sessionLoads = loads.items.filter(row => row.external_session_id === sessionId).slice().reverse();
      const host = rows[0]?.host_session_id ?? sessionAttempts[0]?.host_session_id ?? "—";
      const current = rows.find(row => row.effective_state === "active") ?? rows.sort((a, b) => b.generation - a.generation)[0];
      const validity = current ? VALIDITY_TEXT[current.effective_state] ?? current.effective_state : "无绑定（未锚定或尚未激活）";
      const timeline = rows.slice().sort((a, b) => a.generation - b.generation).map(row => `
        <li>代次 ${row.generation} · ${escapeHtml(VALIDITY_TEXT[row.effective_state] ?? row.effective_state)} · 实例 ${escapeHtml(short(row.instance_id))}${row.predecessor_instance_id ? ` · 前任 ${escapeHtml(short(row.predecessor_instance_id))}` : ""} · 知识版本 r${row.authorization?.source_knowledge_revision ?? "—"} · 能力 [${escapeHtml(row.capabilities.join(", "))}]${row.checkpoint_id ? ` · checkpoint ${escapeHtml(short(row.checkpoint_id))}` : ""} · 来源 ${escapeHtml(row.authorization ? `${row.authorization.source.kind}/${row.authorization.source.actor_id}` : "—")} · 创建 ${escapeHtml(row.created_at)}${row.state_changed_at ? ` · 状态变更 ${escapeHtml(row.state_changed_at)}` : ""}</li>`).join("");
      const attemptLines = sessionAttempts.map(row => `
        <li>${escapeHtml(short(row.attempt_id))} · ${escapeHtml(row.state)} · bundle ${escapeHtml(short(row.bundle_hash))} · ${row.error ? `<span class="warn">失败 ${escapeHtml(row.error.code)}：${escapeHtml(row.error.message)}</span>` : row.confirmation ? `已确认 v${row.confirmation.load_version}` : "等待载入"} · ${escapeHtml(row.created_at)}</li>`).join("");
      const loadLines = sessionLoads.map(row => `
        <li>${escapeHtml(short(row.load_key))} · 材料版本 ${row.load_version ?? "—"} · ${row.confirmed_at ? `确认于 ${escapeHtml(row.confirmed_at)}` : row.load_version ? "已确认（确认时间未记录）" : "未确认"} · 准备于 ${escapeHtml(row.prepared_at)}</li>`).join("");
      const authButtons = [...liveAuths.values()].filter(auth => auth.external_session_id === sessionId).map(auth =>
        `<button data-preview-auth="${escapeHtml(auth.authorization_id)}">撤销预览：${escapeHtml(short(auth.authorization_id))}（${escapeHtml(auth.role_id)}，至 ${escapeHtml(auth.expires_at)}）</button>`).join(" ");
      const nextStep = current ? NEXT_STEP[current.effective_state] ?? "" : "下一步：确认授权后由 Agent 在原会话调用 sessions.anchor。";
      blocks.push(`
        <div class="chain" data-ext="${escapeHtml(sessionId)}">
          <b>${escapeHtml(sessionId)}</b>（host ${escapeHtml(host)}）
          · <span data-role="connection">连接：服务 running（登记有效）</span>
          · 角色有效性：<span class="validity" data-role="validity" data-effective-state="${escapeHtml(current?.effective_state ?? "none")}">${escapeHtml(validity)}</span>
          <div class="hint">${escapeHtml(nextStep)}</div>
          ${rows.length ? `<div>代次时间线（旧 → 新）：<ul>${timeline}</ul></div>` : ""}
          ${sessionAttempts.length ? `<div>锚定尝试：<ul>${attemptLines}</ul></div>` : ""}
          ${sessionLoads.length ? `<div>载入记录：<ul>${loadLines}</ul></div>` : ""}
          ${authButtons ? `<div class="revoke-row">${authButtons}</div>` : ""}
          <div class="hint">观察时间：${escapeHtml(bindings.observed_at)}（有界轮询，页面隐藏时暂停）</div>
        </div>`);
    }
    obs.innerHTML = blocks.length === 0 ? "尚无已登记会话的绑定或锚定尝试。" : blocks.join("");
    for (const button of obs.querySelectorAll<HTMLButtonElement>("button[data-preview-auth]")) {
      button.addEventListener("click", guarded(async () => {
        const authorizationId = button.dataset.previewAuth!;
        const preview = await call<RevokePreview>("authorizations", "revokePreview", { authorization_id: authorizationId });
        renderRevokePreview(preview);
      }));
    }
  };

  const renderRevokePreview = (preview: RevokePreview): void => {
    const bindings = preview.bindings.length === 0
      ? "无（该授权当前没有 active/superseded 绑定）"
      : preview.bindings.map(row => `代次 ${row.generation}（${escapeHtml(row.state)}，session ${escapeHtml(short(row.session_id))}）`).join("；");
    const requests = preview.requests.length === 0
      ? "无"
      : `<ul>${preview.requests.map(row => `<li>${escapeHtml(short(row.request_id))} · ${escapeHtml(row.state)}${row.execution_uncertain ? " · execution_uncertain" : ""}${row.cleanup_pending ? " · cleanup_pending" : ""} · 目标 ${escapeHtml(row.target_role_id)} · ${escapeHtml(row.question.slice(0, 80))}${row.question.length > 80 ? "…" : ""}</li>`).join("")}</ul>`;
    revokeArea.innerHTML = `
      <div class="chain" data-revoke="${escapeHtml(preview.authorization.authorization_id)}">
        <b>撤销影响预览：${escapeHtml(preview.authorization.authorization_id)}</b>（${escapeHtml(preview.authorization.role_id)} @ ${escapeHtml(preview.authorization.external_session_id)}，至 ${escapeHtml(preview.authorization.expires_at)}）
        <div>将失效的绑定：${bindings}</div>
        <div>将撤权的委派请求：${requests}</div>
        <div class="hint">撤销只回收 RoleDock 内的授权与派生任务；“外部会话进程已结束”是另一件事，以宿主为准。</div>
        <button data-confirm-revoke="${escapeHtml(preview.authorization.authorization_id)}">确认撤销</button>
        <button data-cancel-revoke="1">取消</button>
      </div>`;
    revokeArea.querySelector<HTMLButtonElement>("button[data-confirm-revoke]")!.addEventListener("click", guarded(async () => {
      const authorizationId = preview.authorization.authorization_id;
      await call("authorizations", "revoke", { authorization_id: authorizationId });
      logLine(`已撤销 ${authorizationId}（授权撤销已在 RoleDock 生效；绑定失效、派生任务按规则撤权。外部进程回收以宿主为准）`);
      revokeArea.textContent = "";
      await tick();
    }));
    revokeArea.querySelector<HTMLButtonElement>("button[data-cancel-revoke]")!.addEventListener("click", () => { revokeArea.textContent = ""; });
  };

  const tick = async (): Promise<void> => {
    if (!container.isConnected) return;
    let page: AuthorizationConfirmationsPage | null = null;
    try { page = await call<AuthorizationConfirmationsPage>("confirm", "confirmations", { limit: 200 }); } catch { /* 前台工作空间未打开等：保留上次内容。 */ }
    if (page) renderChains(page);
    await renderObservability(page);
  };

  container.querySelector("#reload")!.addEventListener("click", () => void load());
  container.querySelector("#discover")!.addEventListener("click", () => void renderDiscovery());
  await load();
  await tick();
  // 有界轮询（desktop-gui-contract §2.1、ADR-0013 决策 7）：活动页 2s；
  // 页面隐藏即暂停、恢复可见立即刷新；离开页面停止并清理监听。
  let timer: ReturnType<typeof setInterval> | null = null;
  const startPoll = () => { if (timer === null && !document.hidden) timer = setInterval(() => void tick(), 2000); };
  const stopPoll = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => {
    if (document.hidden) stopPoll();
    else { void tick(); startPoll(); }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("hashchange", () => { stopPoll(); document.removeEventListener("visibilitychange", onVisibility); }, { once: true });
  startPoll();
}
