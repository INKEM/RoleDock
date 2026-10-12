# adapters/

Harness 适配器目录（契约见 `docs/spec/adapter-contract.md`）。

规划中的适配器（在 P5 交付，本目录当前只有约定，不放置空壳包）：

| 目录 | 用途 |
| --- | --- |
| `mock/` | 状态机与故障注入验证（测试证据，不等同真实宿主） |
| `process-bridge/` | 真实子进程桥接，验证操作系统执行与消息边界 |
| `harness-reference/` | 参考真实宿主适配，验证角色载入与上下文隔离 |

适配器必须实现 `docs/spec/adapter-contract.md` 的必选方法，声明协商能力与能力等级；不具备隔离能力的宿主返回受限等级，不得标为完整接入。
