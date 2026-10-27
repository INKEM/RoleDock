import { call, escapeHtml, guarded, type ConfirmRoleView } from "../main.js";
import type { OwnerDocumentListPage, OwnerDocumentRead, OwnerDocumentRevisionsPage, OwnerCandidatesPage, OwnerCheckpointListPage, OwnerCheckpointDetail } from "../../shared/contract.js";

/**
 * Role knowledge page (G5, desktop-gui-contract §2.2/§2.3): directory, on-
 * demand revision reads per the §3.2 visibility matrix, immutable history
 * comparison, checkpoint summaries/details, candidates with stale-baseline
 * display, and export/import (import only CREATES candidates — adoption and
 * publishing stay with the authorized role in its original session).
 * Drafts live in this renderer's localStorage only; they are labeled local
 * and never presented as knowledge. `proposals.submit` is not implemented
 * (contract G5/G6): no empty action buttons exist for it.
 */

const SHORT = (value: string): string => (value.length > 14 ? `${value.slice(0, 14)}…` : value);

interface Draft { role_id: string; document_key: string; body: string; saved_at: string }
const draftKey = (roleId: string, documentKey: string): string => `roledock-draft:${roleId}:${documentKey}`;
const loadDraft = (roleId: string, documentKey: string): Draft | null => {
  const raw = window.localStorage.getItem(draftKey(roleId, documentKey));
  if (!raw) return null;
  try { return JSON.parse(raw) as Draft; } catch { return null; }
};
const saveDraft = (roleId: string, documentKey: string, body: string): Draft => {
  const draft: Draft = { role_id: roleId, document_key: documentKey, body, saved_at: new Date().toISOString() };
  window.localStorage.setItem(draftKey(roleId, documentKey), JSON.stringify(draft));
  return draft;
};
const dropDraft = (roleId: string, documentKey: string): void => { window.localStorage.removeItem(draftKey(roleId, documentKey)); };

const VISIBILITY_TEXT: Record<string, string> = {
  private: "私密（仅实例）",
  role: "角色私有",
  project: "工作空间共享",
  public: "公开",
};

export async function renderKnowledgePage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>角色知识（受信所有者入口）</h1>
    <p class="note">目录/历史/候选为只读观察；<b>正式发布与采纳由当前主角色在原会话显式完成</b>，发布后新修订会出现在这里。私密（private/role）文档只显示元数据与内容哈希，正文不经此入口。导入只创建候选；草稿仅保存在本机浏览器存储，明确标注"本地草稿"，不是知识。</p>
    <section>
      <button id="reload">重新加载</button>
      <select id="role-filter"><option value="">全部角色</option></select>
      <button id="export">导出知识包…</button>
      <button id="import">导入知识包…</button>
      <select id="export-scope"><option value="share">share（可分享材料，默认）</option><option value="workspace">workspace（含 checkpoint，仅本机）</option></select>
      <div id="transfer-result" class="discover"></div>
      <h2>文档目录</h2>
      <div id="directory" class="chains">正在加载…</div>
      <h2>阅读器</h2>
      <p class="hint">选择目录中的文档后按需读取；比较时选两个修订并排显示。</p>
      <div id="reader" class="chains">尚未选择文档。</div>
      <h2>Checkpoint（交接摘要与待办）</h2>
      <p class="hint">交接摘要/待办是角色显式写入的交接产物；绑定健康与代次状态在"授权确认"页的会话观察区，两者分列。</p>
      <div id="checkpoints" class="chains">正在加载…</div>
      <h2>候选</h2>
      <p class="hint">候选是明确提交待审的新内容（会话提议/导入/请求结果），正文全文可见；基线过期仅标记显示，不自动合并。</p>
      <div id="candidates" class="chains">正在加载…</div>
      <div id="log" class="log"></div>
    </section>
  `;
  const log = container.querySelector("#log") as HTMLElement;
  const logLine = (message: string) => { log.textContent += message + "\n"; };
  const roleFilter = container.querySelector("#role-filter") as HTMLSelectElement;
  const directory = container.querySelector("#directory") as HTMLElement;
  const reader = container.querySelector("#reader") as HTMLElement;
  const checkpointsEl = container.querySelector("#checkpoints") as HTMLElement;
  const candidatesEl = container.querySelector("#candidates") as HTMLElement;
  const transferResult = container.querySelector("#transfer-result") as HTMLElement;

  let documents: OwnerDocumentListPage["items"] = [];
  let selected: { role_id: string; document_key: string } | null = null;
  let revisions: OwnerDocumentRevisionsPage["items"] = [];

  const load = guarded(async () => {
    const roles = await call<{ roles: ConfirmRoleView[] }>("roles", "list");
    const current = roleFilter.value;
    roleFilter.innerHTML = `<option value="">全部角色</option>` + roles.roles.map(role => `<option value="${escapeHtml(role.role_id)}">${escapeHtml(role.role_id)}</option>`).join("");
    if (current) roleFilter.value = current;
    await renderDirectory();
  });

  const renderDirectory = async () => {
    if (!container.isConnected) return;
    try {
      const page = await call<OwnerDocumentListPage>("knowledge", "listDocuments", { limit: 200, ...(roleFilter.value ? { role_id: roleFilter.value } : {}) });
      if (!container.isConnected) return;
      documents = page.items;
      directory.innerHTML = documents.length === 0
        ? "尚无已声明的文档（安装角色包后出现；发布由角色在原会话完成）。"
        : `<table><thead><tr><th>角色</th><th>文档</th><th>可见性</th><th>最新修订</th><th>更新时间</th><th>内容哈希</th><th></th></tr></thead><tbody>${
          documents.map(entry => `
            <tr data-role="${escapeHtml(entry.role_id)}" data-doc="${escapeHtml(entry.document_key)}">
              <td>${escapeHtml(entry.role_id)}</td>
              <td>${escapeHtml(entry.document_key)}</td>
              <td>${entry.visibility ? escapeHtml(VISIBILITY_TEXT[entry.visibility] ?? entry.visibility) : "—"}</td>
              <td>${entry.latest_revision > 0 ? `r${entry.latest_revision}` : "未发布"}</td>
              <td>${escapeHtml(entry.updated_at ?? "—")}</td>
              <td>${entry.content_hash ? `<code>${escapeHtml(SHORT(entry.content_hash))}</code>` : "—"}</td>
              <td><button data-open="1">阅读</button></td>
            </tr>`).join("")
        }</tbody></table><div class="hint">观察时间：${escapeHtml(page.observed_at)}（有界轮询，页面隐藏时暂停）</div>`;
      for (const button of directory.querySelectorAll<HTMLButtonElement>("button[data-open]")) {
        button.addEventListener("click", guarded(async () => {
          const row = button.closest("tr")!;
          selected = { role_id: row.dataset.role!, document_key: row.dataset.doc! };
          await renderReader();
        }));
      }
    } catch { /* 前台工作空间未打开等：保留上次内容。 */ }
  };

  const renderReader = async () => {
    if (!selected) return;
    const { role_id: roleId, document_key: documentKey } = selected;
    const revisionsPage = await call<OwnerDocumentRevisionsPage>("knowledge", "listRevisions", { role_id: roleId, document_key: documentKey, limit: 200 });
    revisions = revisionsPage.items;
    const latest = revisions.at(-1);
    if (!latest) { reader.innerHTML = `<div class="warn">该文档没有已发布修订。</div>`; return; }
    const draft = loadDraft(roleId, documentKey);
    reader.innerHTML = `
      <div><b>${escapeHtml(roleId)}</b> / <b>${escapeHtml(documentKey)}</b>　修订总数 ${revisions.length}　最新 r${latest.revision}（<code>${escapeHtml(SHORT(latest.content_hash))}</code>，${escapeHtml(latest.visibility)}）</div>
      <div class="reader-row">
        <select id="rev-a">${revisions.map(entry => `<option value="${entry.revision}" ${entry.revision === latest.revision ? "selected" : ""}>r${entry.revision}${entry.visibility === "private" || entry.visibility === "role" ? "（私密）" : ""}</option>`).join("")}</select>
        <select id="rev-b"></select>
        <button id="compare">比较所选两版</button>
      </div>
      <pre id="body" class="body">正在读取…</pre>
      <div id="compare-out" class="body"></div>
      <div class="draft-area">
        <p class="hint"><b>本地草稿</b>：保存只写入本机浏览器存储，不经服务、不是知识、不会产生候选；要提交候选请使用上方"导入知识包"流程。${draft ? `已有草稿（保存于 ${escapeHtml(draft.saved_at)}）。` : ""}</p>
        <textarea id="draft" rows="6" placeholder="在此编辑本地草稿…">${draft ? escapeHtml(draft.body) : ""}</textarea>
        <button id="save-draft">保存草稿（本地）</button>
        <button id="drop-draft">放弃草稿</button>
      </div>`;
    const readRevision = async (revision: number): Promise<OwnerDocumentRead> => {
      const read = await call<OwnerDocumentRead>("knowledge", "readDocument", { role_id: roleId, document_key: documentKey, ...(revision ? { revision } : {}) });
      const bodyEl = reader.querySelector("#body") as HTMLElement;
      if (read.body_included) {
        bodyEl.innerHTML = `<div class="hint">r${read.revision} · ${escapeHtml(VISIBILITY_TEXT[read.visibility] ?? read.visibility)} · 内容哈希 <code>${escapeHtml(read.content_hash)}</code>（正文即该哈希对应字节）· 由实例 ${escapeHtml(read.created_by_instance_id ?? "—")} 发布于 ${escapeHtml(read.created_at)}</div>\n${escapeHtml(read.body ?? "")}`;
      } else {
        bodyEl.innerHTML = `<div class="warn">r${read.revision} 为${escapeHtml(VISIBILITY_TEXT[read.visibility] ?? read.visibility)}文档：按可见性矩阵，owner 只读元数据与内容哈希（<code>${escapeHtml(read.content_hash)}</code>），正文不经此入口。</div>`;
      }
      return read;
    };
    await readRevision(latest.revision);
    // 比较选择：B 默认空 = 选择第一版。
    (reader.querySelector("#rev-b") as HTMLSelectElement).innerHTML = `<option value="">（选择比较版本）</option>` + revisions.map(entry => `<option value="${entry.revision}">r${entry.revision}${entry.visibility === "private" || entry.visibility === "role" ? "（私密）" : ""}</option>`).join("");
    (reader.querySelector("#compare") as HTMLButtonElement).addEventListener("click", guarded(async () => {
      const a = Number((reader.querySelector("#rev-a") as HTMLSelectElement).value);
      const bValue = (reader.querySelector("#rev-b") as HTMLSelectElement).value;
      if (!bValue) throw new Error("请先选择要比较的第二个修订。");
      const b = Number(bValue);
      const reads = await Promise.all([a, b].map(revision => call<OwnerDocumentRead>("knowledge", "readDocument", { role_id: roleId, document_key: documentKey, revision })));
      const out = reader.querySelector("#compare-out") as HTMLElement;
      out.innerHTML = reads.map(read => read.body_included
        ? `<div><b>r${read.revision}</b>（<code>${escapeHtml(SHORT(read.content_hash))}</code>）<pre>${escapeHtml(read.body ?? "")}</pre></div>`
        : `<div><b>r${read.revision}</b>（<code>${escapeHtml(SHORT(read.content_hash))}</code>）为${escapeHtml(VISIBILITY_TEXT[read.visibility] ?? read.visibility)}：正文不可经此入口比较，仅哈希对照。</div>`).join("<hr>");
      if (reads.every(read => read.body_included)) {
        logLine(`比较 r${a} 与 r${b}：${reads[0]!.body === reads[1]!.body ? "正文相同" : "正文不同"}；哈希 ${reads[0]!.content_hash === reads[1]!.content_hash ? "相同" : "不同"}。`);
      }
    }));
    (reader.querySelector("#rev-a") as HTMLSelectElement).addEventListener("change", guarded(async () => {
      await readRevision(Number((reader.querySelector("#rev-a") as HTMLSelectElement).value));
    }));
    (reader.querySelector("#save-draft") as HTMLButtonElement).addEventListener("click", () => {
      const body = (reader.querySelector("#draft") as HTMLTextAreaElement).value;
      const draft = saveDraft(roleId, documentKey, body);
      logLine(`本地草稿已保存（${roleId}/${documentKey}，${draft.saved_at}）——仅本机，未提交。`);
    });
    (reader.querySelector("#drop-draft") as HTMLButtonElement).addEventListener("click", () => {
      dropDraft(roleId, documentKey);
      (reader.querySelector("#draft") as HTMLTextAreaElement).value = "";
      logLine(`本地草稿已放弃（${roleId}/${documentKey}）。`);
    });
  };

  const renderCheckpoints = async () => {
    if (!container.isConnected) return;
    try {
      const page = await call<OwnerCheckpointListPage>("knowledge", "listCheckpoints", { limit: 50, ...(roleFilter.value ? { role_id: roleFilter.value } : {}) });
      if (!container.isConnected) return;
      checkpointsEl.innerHTML = page.items.length === 0
        ? "尚无 checkpoint（交接准备后出现）。"
        : page.items.map(item => `
          <div class="chain" data-checkpoint="${escapeHtml(item.checkpoint_id)}">
            <b>${escapeHtml(SHORT(item.checkpoint_id))}</b> · ${escapeHtml(item.role_id)} @ 代次 ${item.generation} · 知识 r${item.knowledge_revision}
            · 待办 ${item.todos_done}/${item.todos_total} 完成 · 快照 ${item.document_snapshots.length} 项
            · 摘要哈希 <code>${escapeHtml(SHORT(item.handoff_summary.content_hash))}</code> · ${escapeHtml(item.created_at)}
            <ul>${item.todos_open.map(todo => `<li>${escapeHtml(todo.description)}</li>`).join("")}</ul>
            <button data-detail="1">查看完整交接摘要</button>
          </div>`).join("");
      for (const button of checkpointsEl.querySelectorAll<HTMLButtonElement>("button[data-detail]")) {
        button.addEventListener("click", guarded(async () => {
          const checkpointId = button.closest(".chain")!.getAttribute("data-checkpoint")!;
          const detail = await call<OwnerCheckpointDetail>("knowledge", "getCheckpoint", { checkpoint_id: checkpointId });
          button.insertAdjacentHTML("afterend", `
            <div class="chain detail">
              <div class="hint">交接摘要（markdown，内容哈希 <code>${escapeHtml(detail.handoff_summary.content_hash)}</code>——正文即该哈希对应字节）：</div>
              <pre>${escapeHtml(detail.handoff_summary.body)}</pre>
              <div>全部待办：${detail.todos.map(todo => `${todo.done ? "☑" : "☐"} ${escapeHtml(todo.description)}`).join("；") || "无"}</div>
              <div>来源：${detail.sources.map(source => `${escapeHtml(source.kind)}${source.document_key ? `/${escapeHtml(source.document_key)}@r${source.revision ?? "?"}` : ""}`).join("、") || "无"}</div>
              ${detail.user_decision_refs.length ? `<div>决策引用：${detail.user_decision_refs.map(ref => escapeHtml(ref.summary)).join("；")}</div>` : ""}
            </div>`);
        }));
      }
    } catch { /* 保留上次内容。 */ }
  };

  const renderCandidates = async () => {
    if (!container.isConnected) return;
    try {
      const page = await call<OwnerCandidatesPage>("knowledge", "listCandidates", { limit: 100, ...(roleFilter.value ? { role_id: roleFilter.value } : {}) });
      if (!container.isConnected) return;
      candidatesEl.innerHTML = page.items.length === 0
        ? "尚无候选（会话提议、导入与请求结果会产生候选）。"
        : page.items.map(item => `
          <div class="chain">
            <b>${escapeHtml(SHORT(item.candidate_id))}</b> · ${escapeHtml(item.state)} · 来源 ${escapeHtml(item.source)} · ${escapeHtml(item.proposed_by_role_id)}
            · 目标 ${escapeHtml(item.target_role_id)}/${escapeHtml(item.document_key)}
            · 基线 r${item.baseline_revision} → 当前最新 r${item.latest_revision}${item.baseline_conflicted ? ` <span class="warn">（基线已过期：提交时基于 r${item.baseline_revision}，现为 r${item.latest_revision}；采纳与否、如何合并由有权角色决定，不自动合并）</span>` : ""}
            ${item.resolved_at ? ` · 处理于 ${escapeHtml(item.resolved_at)}` : ""}
            <pre>${escapeHtml(item.body ?? "")}</pre>
            ${item.note ? `<div class="hint">备注：${escapeHtml(item.note)}</div>` : ""}
          </div>`).join("");
    } catch { /* 保留上次内容。 */ }
  };

  roleFilter.addEventListener("change", () => void guarded(async () => { await renderDirectory(); await renderCheckpoints(); await renderCandidates(); })());
  container.querySelector("#reload")!.addEventListener("click", () => void guarded(async () => { await load(); await renderCheckpoints(); await renderCandidates(); })());
  container.querySelector("#export")!.addEventListener("click", guarded(async () => {
    const scope = (container.querySelector("#export-scope") as HTMLSelectElement).value as "share" | "workspace";
    transferResult.innerHTML = "正在导出…";
    const result = await call<{ export_id: string; entry_count: number; checkpoint_count: number; saved_to: string | null; error: string | null }>("knowledge", "export", { scope });
    transferResult.innerHTML = result.error
      ? `<div class="warn">导出未保存：${escapeHtml(result.error)}</div>`
      : `<div>已导出 <b>${escapeHtml(result.export_id)}</b>：${result.entry_count} 个文档条目、${result.checkpoint_count} 个 checkpoint（scope=${scope}），已复制到所选目录。</div>`;
    logLine(`导出 ${result.export_id} 完成（scope=${scope}，条目 ${result.entry_count}）。`);
  }));
  container.querySelector("#import")!.addEventListener("click", guarded(async () => {
    transferResult.innerHTML = "正在导入…";
    const result = await call<{ ok: boolean; created: Array<{ candidate_id: string; target_role_id: string; document_key: string; baseline_revision: number }>; skipped: Array<{ document_key: string; reason: string }>; error: string | null }>("knowledge", "import");
    if (!result.ok) {
      transferResult.innerHTML = `<div class="warn">导入未完成：${escapeHtml(result.error ?? "已取消")}</div>`;
      return;
    }
    transferResult.innerHTML = `
      <div>导入完成：已创建 <b>${result.created.length}</b> 个候选（导入只创建候选，正式采纳/发布由当前有权角色在原会话完成）。</div>
      ${result.created.map(entry => `<div>候选 ${escapeHtml(SHORT(entry.candidate_id))} → ${escapeHtml(entry.target_role_id)}/${escapeHtml(entry.document_key)}（基线 r${entry.baseline_revision}）</div>`).join("")}
      ${result.skipped.length ? `<div class="hint">跳过 ${result.skipped.length} 项：${result.skipped.map(entry => `${escapeHtml(entry.document_key)}（${escapeHtml(entry.reason)}）`).join("；")}</div>` : ""}`;
    logLine(`导入完成：候选 ${result.created.length} 个，跳过 ${result.skipped.length} 项。`);
    await renderCandidates();
  }));

  await load();
  await renderCheckpoints();
  await renderCandidates();
  // 有界轮询（desktop-gui-contract §2.1、ADR-0013 决策 7）：活动页 2s；
  // 页面隐藏即暂停、恢复可见立即刷新；离开页面停止并清理监听。
  let timer: ReturnType<typeof setInterval> | null = null;
  const startPoll = () => { if (timer === null && !document.hidden) timer = setInterval(() => void guarded(async () => { await renderDirectory(); await renderCandidates(); })(), 2000); };
  const stopPoll = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => { if (document.hidden) stopPoll(); else { void guarded(async () => { await renderDirectory(); await renderCandidates(); })(); startPoll(); } };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("hashchange", () => { stopPoll(); document.removeEventListener("visibilitychange", onVisibility); }, { once: true });
  startPoll();
}
