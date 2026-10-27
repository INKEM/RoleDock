import { call, escapeHtml, guarded } from "../main.js";
import type { OwnerRequestInboxPage, OwnerRequestDetail, OwnerArtifactRead, OwnerCleanupPage, OwnerCancelResult } from "../../shared/contract.js";

/**
 * Request inbox page (G6, desktop-gui-contract §2.2/§14): the owner's bounded
 * view from acceptance to the real answer. The GUI never injects into a main
 * conversation, never writes chat: clarifications go back through the
 * original initiator (requests.reply), adoption happens in the target role's
 * original session via documents.publish(adopt_artifact_id) — the page only
 * SUGGESTS that action. Request state, inbox read-state and candidate
 * adoption are different dimensions and stay separate.
 */

const SHORT = (value: string): string => (value.length > 14 ? `${value.slice(0, 14)}…` : value);
const STATES = ["accepted", "queued", "running", "awaiting_input", "completed", "failed", "cancelled", "expired"] as const;

const usageText = (usage: { output_bytes: number | null; turns_reserved: number | null }): string =>
  `输出字节 ${usage.output_bytes === null ? "未知" : usage.output_bytes} · 预留轮次 ${usage.turns_reserved === null ? "未知" : usage.turns_reserved}`;

export async function renderInboxPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>请求收件箱（受信所有者入口）</h1>
    <p class="note">这里是从接收、执行到真实答案的有界观察。<b>澄清回复由原发起会话 requests.reply 完成；正式采纳由目标角色在原会话执行 documents.publish(adopt_artifact_id)</b>——GUI 只建议动作，不代写正文。请求状态、收件已读、候选采纳是三个不同维度，分列显示。已知缺失的用量显示"未知"，不以 0 冒充。管理取消是独立 owner 操作并留审计；running 且适配器未声明取消能力时不可取消。</p>
    <section>
      <button id="reload">重新加载</button>
      <select id="state-filter"><option value="">全部状态</option>${STATES.map(state => `<option value="${state}">${state}</option>`).join("")}</select>
      <h2>请求列表</h2>
      <div id="requests" class="chains">正在加载…</div>
      <h2>请求详情</h2>
      <div id="detail" class="chains">在列表中选择请求。</div>
      <h2>回收视图</h2>
      <p class="hint">终态不可逆；清理失败可区分且不改变终态，由服务持续重试。</p>
      <div id="cleanup" class="chains">正在加载…</div>
      <div id="log" class="log"></div>
    </section>
  `;
  const log = container.querySelector("#log") as HTMLElement;
  const logLine = (message: string) => { log.textContent += message + "\n"; };
  const stateFilter = container.querySelector("#state-filter") as HTMLSelectElement;
  const listEl = container.querySelector("#requests") as HTMLElement;
  const detailEl = container.querySelector("#detail") as HTMLElement;
  const cleanupEl = container.querySelector("#cleanup") as HTMLElement;
  let selectedId: string | null = null;

  const renderList = async () => {
    if (!container.isConnected) return;
    try {
      const page = await call<OwnerRequestInboxPage>("inbox", "listRequests", { limit: 200, ...(stateFilter.value ? { state: stateFilter.value } : {}) });
      if (!container.isConnected) return;
      listEl.innerHTML = page.items.length === 0
        ? "尚无请求（外部 Agent 用 requests.create 发起）。"
        : `<table><thead><tr><th>请求</th><th>发起 → 目标</th><th>状态</th><th>固定绑定</th><th>用量</th><th>标记</th><th>创建</th></tr></thead><tbody>${
          page.items.map(item => `
            <tr data-request="${escapeHtml(item.request_id)}" class="${item.request_id === selectedId ? "selected" : ""}">
              <td>${escapeHtml(SHORT(item.request_id))}</td>
              <td>${escapeHtml(item.initiating.role_id)} → ${escapeHtml(item.target_role_id)}</td>
              <td>${escapeHtml(item.state)}${item.state === "awaiting_input" ? "（等待澄清）" : ""}</td>
              <td>代次 ${item.binding.target_generation} · 知识 r${item.binding.knowledge_revision}</td>
              <td>${escapeHtml(usageText(item.usage))}</td>
              <td>${item.execution_uncertain ? '<span class="warn">execution_uncertain </span>' : ""}${item.cleanup_pending ? '<span class="warn">cleanup_pending</span>' : ""}${item.result ? "有结果" : ""}</td>
              <td>${escapeHtml(item.created_at)}</td>
            </tr>`).join("")
        }</tbody></table><div class="hint">观察时间：${escapeHtml(page.observed_at)}（有界轮询，页面隐藏时暂停）</div>`;
      for (const row of listEl.querySelectorAll<HTMLTableRowElement>("tr[data-request]")) {
        row.addEventListener("click", guarded(async () => {
          selectedId = row.dataset.request!;
          await renderDetail();
        }));
      }
    } catch { /* 前台工作空间未打开等：保留上次内容。 */ }
  };

  const renderDetail = async () => {
    if (!selectedId) return;
    const detail = await call<OwnerRequestDetail>("inbox", "getRequest", { request_id: selectedId });
    const cancellable = ["accepted", "queued", "awaiting_input"].includes(detail.state) || detail.state === "running";
    detailEl.innerHTML = `
      <div class="chain" data-detail="${escapeHtml(detail.request_id)}">
        <b>${escapeHtml(detail.request_id)}</b> · ${escapeHtml(detail.state)} · 发起 ${escapeHtml(detail.initiating.role_id)}（session ${escapeHtml(SHORT(detail.initiating.session_id))}）→ 目标 ${escapeHtml(detail.target_role_id)}
        <div>固定绑定：目标代次 ${detail.binding.target_generation} · 知识 r${detail.binding.knowledge_revision}（接收时固定，不自动迁移）</div>
        <div>预算：${detail.budget.max_turns ? `≤${detail.budget.max_turns} 轮` : "轮次未限"}${detail.budget.deadline ? ` · 期限 ${escapeHtml(detail.budget.deadline)}` : ""}　用量：${escapeHtml(usageText(detail.usage))}</div>
        ${detail.execution_uncertain ? '<div class="warn">execution_uncertain：执行结果不确定——正确动作是先对账，不以取消代替对账，也不据其创建替代请求。</div>' : ""}
        <div>问题全文：<pre>${escapeHtml(detail.question)}</pre></div>
        ${detail.result ? `<div>结果：artifact ${escapeHtml(SHORT(detail.result.artifact_id))} · <code>${escapeHtml(SHORT(detail.result.content_hash))}</code>
          <button data-artifact="${escapeHtml(detail.result.artifact_id)}">查看产物正文</button>
          <div class="hint">建议采纳：回原会话由当前主角色执行 <code>documents.publish(adopt_artifact_id=${escapeHtml(detail.result.artifact_id)})</code>；采纳后此处经候选/修订视图显示确切新修订（adopted 是候选维度，与请求终态、收件已读分列）。</div>
          <pre id="artifact-body" class="body"></pre></div>` : ""}
        ${detail.error ? `<div class="warn">错误：${escapeHtml(detail.error.code)} — ${escapeHtml(detail.error.message)}</div>` : ""}
        ${cancellable && detail.state !== "completed" ? `
        <div class="paste-row">
          <input id="cancel-reason" placeholder="取消原因（必填，进入审计）" />
          <button id="cancel">管理取消</button>
          ${detail.state === "running" ? '<span class="hint">running：仅当适配器声明取消能力才可取消，否则 REQUEST_NOT_TERMINABLE 且请求继续运行。</span>' : ""}
        </div>` : `<div class="hint">终态 ${escapeHtml(detail.state)}：不可再取消/重试执行；如需继续，请发起新的请求（新意图）。</div>`}
      </div>`;
    const artifactButton = detailEl.querySelector<HTMLButtonElement>("button[data-artifact]");
    if (artifactButton) {
      artifactButton.addEventListener("click", guarded(async () => {
        const artifact = await call<OwnerArtifactRead>("inbox", "readArtifact", { artifact_id: artifactButton.dataset.artifact! });
        const bodyEl = detailEl.querySelector("#artifact-body") as HTMLElement;
        bodyEl.innerHTML = `<div class="hint">产物正文（内容哈希 <code>${escapeHtml(artifact.content_hash)}</code>，由 ${escapeHtml(artifact.producing_role_id)} 产出）：</div>\n${escapeHtml(artifact.body)}`;
      }));
    }
    const cancelButton = detailEl.querySelector<HTMLButtonElement>("#cancel");
    if (cancelButton) {
      cancelButton.addEventListener("click", guarded(async () => {
        const reason = (detailEl.querySelector("#cancel-reason") as HTMLInputElement).value.trim();
        if (!reason) throw new Error("取消原因必填（写入审计）。");
        const result = await call<OwnerCancelResult>("inbox", "cancelRequest", { request_id: detail.request_id, reason, idempotency_key: `gui-${crypto.randomUUID()}` });
        logLine(result.idempotent_replay
          ? `取消键重放：${result.request_id} 首次结果 state=${result.state}（未产生第二次状态变更）`
          : `已管理取消 ${result.request_id}（owner 独立审计；清理见回收视图）`);
        await Promise.all([renderList(), renderCleanup()]);
        await renderDetail();
      }));
    }
  };

  const renderCleanup = async () => {
    if (!container.isConnected) return;
    try {
      const page = await call<OwnerCleanupPage>("inbox", "listCleanup", { limit: 100 });
      if (!container.isConnected) return;
      cleanupEl.innerHTML = page.items.length === 0
        ? "无终态请求的待回收项。"
        : page.items.map(item => `
          <div class="chain">
            ${escapeHtml(SHORT(item.request_id))} · 终态 ${escapeHtml(item.state)} · ${item.terminal_at ? escapeHtml(item.terminal_at) : "—"}
            · ${item.cleanup_pending ? (item.cleanup_error ? `<span class="warn">清理失败（将重试，终态不变）：${escapeHtml(item.cleanup_error.code)} — ${escapeHtml(item.cleanup_error.message)}</span>` : '<span class="warn">cleanup_pending（回收进行中）</span>') : "回收完成"}
          </div>`).join("");
    } catch { /* 保留上次内容。 */ }
  };

  stateFilter.addEventListener("change", () => void renderList());
  container.querySelector("#reload")!.addEventListener("click", () => void guarded(async () => { await renderList(); await renderCleanup(); await renderDetail(); })());
  await renderList();
  await renderCleanup();
  // 有界轮询（desktop-gui-contract §2.1、ADR-0013 决策 7）。
  let timer: ReturnType<typeof setInterval> | null = null;
  const startPoll = () => { if (timer === null && !document.hidden) timer = setInterval(() => void guarded(async () => { await renderList(); await renderCleanup(); })(), 2000); };
  const stopPoll = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => { if (document.hidden) stopPoll(); else { void guarded(async () => { await renderList(); await renderCleanup(); })(); startPoll(); } };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("hashchange", () => { stopPoll(); document.removeEventListener("visibilitychange", onVisibility); }, { once: true });
  startPoll();
}
