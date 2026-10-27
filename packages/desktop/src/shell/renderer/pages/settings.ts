import { call, guarded } from "../main.js";
import type { ShellSettings } from "../main.js";

export async function renderSettingsPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1>设置</h1>
    <section>
      <label>默认工作空间目录</label>
      <input id="default-dir" style="width:60%" placeholder="（未设置）" />
      <button id="pick">选择…</button>
      <label><input type="checkbox" id="exit-stop" /> 退出应用时停止本应用启动的工作空间服务（附着的外部服务不受影响）</label>
      <button id="save">保存</button>
      <span id="saved"></span>
    </section>
    <p class="note">设置保存在本应用的用户数据目录；关闭窗口默认保留服务运行，与此开关无关。</p>
  `;
  const settings = await call<ShellSettings>("settings", "get");
  const dirInput = container.querySelector("#default-dir") as HTMLInputElement;
  const exitStop = container.querySelector("#exit-stop") as HTMLInputElement;
  dirInput.value = settings.defaultWorkspaceDir ?? "";
  exitStop.checked = settings.exitStopsOwnedServices;

  container.querySelector("#pick")!.addEventListener("click", guarded(async () => {
    const picked = await call<{ canceled: boolean; path: string | null }>("workspace", "pickDirectory");
    if (!picked.canceled && picked.path) dirInput.value = picked.path;
  }));
  container.querySelector("#save")!.addEventListener("click", guarded(async () => {
    await call<ShellSettings>("settings", "set", {
      defaultWorkspaceDir: dirInput.value.trim() || null,
      exitStopsOwnedServices: exitStop.checked,
    });
    (container.querySelector("#saved") as HTMLElement).textContent = "已保存";
  }));

  // Launcher configuration (ZCode access; verified fields only — helper
  // output is never displayed anywhere in the renderer).
  const launcher = settings.launcher;
  const launcherSection = document.createElement("section");
  launcherSection.innerHTML = `
    <h2>ZCode 接入配置</h2>
    <label>启动模式
      <select id="launcher-kind"><option value="mock">mock（诊断）</option><option value="zcode">zcode（真实配置）</option></select>
    </label>
    <label>ZCode CLI 路径（绝对路径）</label>
    <input id="launcher-cli" style="width:70%" placeholder="/path/to/zcode.cjs" />
    <label>credential helper 可执行路径（引用；不会显示其输出）</label>
    <input id="launcher-helper" style="width:70%" placeholder="（可选）" />
    <label>provider / model 标识（可选）</label>
    <input id="launcher-provider" style="width:34%" placeholder="provider" />
    <input id="launcher-model" style="width:34%" placeholder="model" />
    <label>受管出口白名单（每行一个 host[:port]）</label>
    <textarea id="launcher-egress" style="width:70%;height:5rem"></textarea>
    <button id="launcher-save">保存接入配置</button>
    <span id="launcher-saved" class="note"></span>`;
  container.appendChild(launcherSection);
  (launcherSection.querySelector("#launcher-kind") as HTMLSelectElement).value = launcher.kind;
  (launcherSection.querySelector("#launcher-cli") as HTMLInputElement).value = launcher.cliPath ?? "";
  (launcherSection.querySelector("#launcher-helper") as HTMLInputElement).value = launcher.credentialHelper ?? "";
  (launcherSection.querySelector("#launcher-provider") as HTMLInputElement).value = launcher.provider ?? "";
  (launcherSection.querySelector("#launcher-model") as HTMLInputElement).value = launcher.model ?? "";
  (launcherSection.querySelector("#launcher-egress") as HTMLTextAreaElement).value = launcher.managedEgress.join("\n");
  launcherSection.querySelector("#launcher-save")!.addEventListener("click", guarded(async () => {
    const egress = (launcherSection.querySelector("#launcher-egress") as HTMLTextAreaElement).value
      .split("\n").map(line => line.trim()).filter(line => line.length > 0);
    await call<ShellSettings>("settings", "set", {
      launcher: {
        kind: (launcherSection.querySelector("#launcher-kind") as HTMLSelectElement).value as "mock" | "zcode",
        cliPath: (launcherSection.querySelector("#launcher-cli") as HTMLInputElement).value.trim() || null,
        credentialHelper: (launcherSection.querySelector("#launcher-helper") as HTMLInputElement).value.trim() || null,
        provider: (launcherSection.querySelector("#launcher-provider") as HTMLInputElement).value.trim() || null,
        model: (launcherSection.querySelector("#launcher-model") as HTMLInputElement).value.trim() || null,
        managedEgress: egress,
      },
    });
    (launcherSection.querySelector("#launcher-saved") as HTMLElement).textContent = "已保存（打开真实工作空间时将写入工作空间配置并先做预检）";
  }));
}
