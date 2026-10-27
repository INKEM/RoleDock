# P6-G0 独立验收证据

基线 HEAD `d974336` + G0 未提交工作区。验收结论见 [P6-G0-review.md](../../P6-G0-review.md)。

- `baseline-head.txt`、`baseline-status.txt`、`baseline.sha256`：验收对象；29 个源码／契约／配置文件前后哈希一致。没有修改产品实现。
- `typecheck.log`：独立类型门禁 exit 0。
- `focused.log`：desktop、probe-contract、service、MCP 四文件／15 测试通过。
- `build.log`：从当前源码构建探针。
- `e2e.log`：现有真实 Electron E2E 一项通过，8.0 秒。
- `package-dir.log`：独立重建 linux dir 产物，未发布。
- `packaged-selfcheck.log`：打包运行时 Node 22.23.2、workspace RPC、SQLite BUSY 与 14 工具 MCP 检查均 pass。
- `windows.log`、`packaged-window.png`：重建产物在 `/tmp` 为 cwd、没有 dev runtime 环境变量时的真实窗口验证；以及没有 fixture 时的原生目录对话框打开观察。真实点选没有验证，不算成功。
- `verify-windows.mjs`：对应独立脚本，运行需本机显示与构建后的打包产物，仅操作自身创建的探针，关闭后验证自有 service 回收。
- `repro-contract.mjs`、`repro-contract.log`：使用非凭据的合成文本，证明当前脱敏契约与实际函数不符，并列出现有请求状态枚举。脚本退出 0 表示反例记录完毕，不是 G0 通过。

复现前先使用 Node 22.23.2 并构建源码。窗口脚本依赖 `@playwright/test`、本地 Electron、DISPLAY 和 xwininfo，不运行模型任务；读取 X11 窗口树时只记录自己打开的目录对话框标题。完整 460 项门禁和 npm ci 本轮未重跑，开发方原日志不并入本轮独立通过计数。
