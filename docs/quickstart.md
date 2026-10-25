# 快速开始（Quickstart）

协议版本：0.1 · CLI 命令与本页一致即稳定接口；`roledock --help` 永远是权威清单。

## 安装与构建

```bash
nvm use            # Node 22.23.2（.nvmrc，engine-strict）
npm ci
npm run build      # 或 npm run check（typecheck + build + 全部测试）
alias roledock="node $(pwd)/packages/cli/dist/bin.js"
```

## 1. 初始化工作空间并安装角色包

工作空间在首次命令时自动初始化（状态存于 `<root>/.roledock/`）：

```bash
roledock --root ~/demo-ws roles install examples/demo-team
roledock --root ~/demo-ws roles list
roledock --root ~/demo-ws roles resolve builder
```

## 2. 打开主会话并发布知识

安装不授予权限。先由本地所有者明确授予本次演示需要的动作；其他角色按同样方式配置，只授予需要的能力。

```bash
roledock --root ~/demo-ws admin grant builder documents.read
roledock --root ~/demo-ws admin grant builder documents.publish
roledock --root ~/demo-ws admin grant builder requests.execute
roledock --root ~/demo-ws admin grant builder artifacts.read
roledock --root ~/demo-ws admin grant explainer documents.read
roledock --root ~/demo-ws admin grant explainer requests.create
roledock --root ~/demo-ws admin grant explainer requests.read
roledock --root ~/demo-ws admin grant explainer artifacts.read
```

```bash
roledock --root ~/demo-ws sessions open builder
# → { session_id, instance_id, generation: 1 }
roledock --root ~/demo-ws --session <session_id> documents publish state state.md 0 1
```

会话 ID 是受信身份；后续会话绑定操作都凭它调用。再次 `sessions open builder latest` 会走完整交接（prepare→provision→activate）成为下一代唯一继承者，旧实例即刻失去发布权。

## 3. 读取、候选与协作请求

```bash
# 另一角色读取（记录读取回执，作为请求前置）
roledock --root ~/demo-ws --session <explainer_session> documents read builder state

# 发起协作请求（同键同内容幂等；预算可选 deadline）
roledock --root ~/demo-ws --session <explainer_session> \
  requests create builder question.md my-key-1

# 请求由协调器适配器在隔离分支执行（outbox 驱动，见 examples/demo.mjs 的 drainRequest）
# 结果进入目标角色收件箱；所有者经显式采纳落为正式修订：
roledock --root ~/demo-ws admin inbox builder
roledock --root ~/demo-ws --session <builder_session> \
  documents publish state body.md <expected_rev> <expected_gen> --adopt-artifact <artifact_id>
```

## 4. 知识迁移与诊断

```bash
roledock --root ~/demo-ws knowledge export share          # 只含 project/public，不含私有材料
roledock --root ~/demo-ws2 knowledge import <bundle-dir>  # 一律落为候选，哈希校验
roledock --root ~/demo-ws admin events                    # 待投递事件（outbox）诊断
roledock --root ~/demo-ws admin policy                    # requested vs granted 能力视图
```

## 5. 选择宿主适配器

```bash
roledock --adapter mock   ...    # 默认：内存宿主，验证状态机制
roledock --adapter bridge ...    # 真实 fixture-host 子进程（进程桥接层）
```

两种适配器通过同一契约测试；都不是真实模型宿主——真实宿主接入见 `docs/adapter-guide.md` §7。

## 6. 一键演示

```bash
node examples/demo.mjs                    # 桥接适配器，蓝图 7 步全流程
node examples/demo.mjs --adapter mock     # 内存适配器对照
```

演示每次使用全新临时工作空间，可重复运行；机器可读日志（JSONL）写入 `demo-log.jsonl`。

## 机器可读输出

所有命令接受 `--json`：stdout 返回 `{"ok":true,"data":...}` 或 stderr 返回 `{"ok":false,"error":{"code","message",...}}`（信封经协议 Schema 校验）。退出码：0 成功 / 1 运行错误 / 2 用法错误。人工说明不会混入 JSON 输出。
