# adapters/

Harness 适配器目录（契约见 `docs/spec/adapter-contract.md`，实现指南见 `docs/adapter-guide.md`）。

| 目录 | 状态 | 用途 |
| --- | --- | --- |
| `mock/` | **P3 已交付**（`@roledock/adapter-mock`） | 内存宿主 + 故障注入，验证核心状态机制；不是真实宿主证据 |
| `process-bridge/` | **P5 已交付**（`@roledock/adapter-process-bridge`） | 真实子进程桥接（fixture 宿主程序），验证操作系统执行、消息边界与断线恢复；仍是协议夹具，不是真实宿主证据 |
| `zcode/` | **P5-H 受限诊断已实现**（`@roledock/adapter-zcode`） | 用户指定ZCode；真实GLM-5.3探针可运行。B1 会话身份验证；B2 真人授权入口内部接口（owner 写入面+适配器读取）；B3 材料载入与对账（G01-Z02：内容寻址材料+结构化读取证据+精确标记回显+journal 对账），**真实锚定激活链已跑通**（注册→真人事件→recordHuman→锚定→真实载入轮→CAS generation 1，见 P5-H-b3 证据）。`current_session_identity`/`human_authorization_events` 已声明（B1/B2 证据），`load_materials`/`reconcile_load` 待独立验收翻转；四项隔离未证实（G01-Z03 属 B4）；不计完整角色闭环 |
| `harness-reference/` | **完整接入未交付** | 用户已指定并授权ZCode，当前缺口为人类来源认证、原会话完整材料确认、请求隔离和资源控制/副作用对账；见[接入说明](../docs/zcode-integration.md)。不创建不可运行的空壳包 |

适配器必须实现 `docs/spec/adapter-contract.md` 的必选方法，声明协商能力与能力等级；不具备隔离能力的宿主返回受限等级，不得标为完整接入。核心通过 `Coordinator.open({ adapter })` 注入适配器，从不自行构造宿主。CLI 经 `--adapter mock|bridge`（默认 mock）选择；Mock 与 process-bridge 通过同一契约测试套件（`tests/conformance/adapter-suite.ts`）。
