# G2 最终独立复验命令

均从仓库根目录执行；临时工作空间由脚本创建并回收。产品验证命令均 exit 0。socket、Electron 与本机 CLI 的命令经本地自动审批执行；脚本不使用真实模型会话。

```bash
npm run typecheck
npm run desktop:build:shell
npx vitest run packages/desktop/test/launcher-safety.test.ts packages/desktop/test/preflight.test.ts packages/desktop/test/desktop.test.ts packages/desktop/test/shell-contract.test.ts packages/desktop/test/probe-contract.test.ts packages/protocol/test/g2-read-models.test.ts packages/protocol/test/workspace-service-info.test.ts packages/service/test/g2-read-models.test.ts packages/service/test/service.test.ts packages/service/test/client-timeout.test.ts packages/mcp/test/mcp.test.ts tests/integration/service-restart.process.test.ts tests/conformance/no-business-roles.test.ts packages/core/test/policy.test.ts
npx playwright test --config packages/desktop/playwright.shell.config.ts
node docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/check-identity.mjs
node docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/check-materials.mjs
node docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/check-config-safety.mjs
npm run desktop:package:shell
node docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/check-packaged.mjs packages/desktop/dist-app-shell/linux-unpacked/roledock-desktop /home/inkem/Personal/RoleDock/docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/09-packaged.json
node docs/phase-reports/evidence/2026-10-26-p6-g2-final-independent/check-policy-action.mjs
git diff --check
```

输出分别保存至报告列出的 log、JSON、stderr 和截图文件。身份、材料、配置和策略探针只操作脚本创建的临时数据；打包探针 cwd 为仓库外临时目录，使用产物自带运行时与资源。本机 ZCode CLI 路径只在验收脚本运行时配置，不写入产品默认值或真实用户设置。
