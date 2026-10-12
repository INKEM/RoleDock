# adapters/

Harness 适配器目录（契约见 `docs/spec/adapter-contract.md`）。

| 目录 | 状态 | 用途 |
| --- | --- | --- |
| `mock/` | **P3 已交付**（`@roledock/adapter-mock`） | 内存宿主 + 故障注入，验证核心状态机制；不是真实宿主证据 |
| `process-bridge/` | 规划中（P5） | 真实子进程桥接，验证操作系统执行与消息边界 |
| `harness-reference/` | 规划中（P5） | 参考真实宿主适配，验证角色载入与上下文隔离 |

适配器必须实现 `docs/spec/adapter-contract.md` 的必选方法，声明协商能力与能力等级；不具备隔离能力的宿主返回受限等级，不得标为完整接入。核心通过 `Coordinator.open({ adapter })` 注入适配器，从不自行构造宿主。
