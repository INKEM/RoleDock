# examples/

示例角色包目录。

规划中的示例（随实现阶段交付）：

| 目录 | 用途 |
| --- | --- |
| `demo-team/` | 三角色演示包（builder / reviewer / explainer——仅为演示数据，非框架内建角色） |
| `custom-role/` | 名字与职责完全不同的自定义角色，证明核心无需修改即可接入 |

角色包格式见 `packages/protocol/schemas/rolepack.schema.json`；能力声明是需求声明而非授权（`docs/spec/identity-and-permissions.md` §2）。
