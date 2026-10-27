# P6-G5 返工记录(R1)

日期:2026-10-28。对应验收:`P6-G5-review.md`(结论 REWORK,唯一返工项 R1,高优先级)。返工基线:HEAD `5878c38` 起。

## R1:哈希配对正文经 shell IPC redact 被静默 scrub

- **验收指认**:知识正文(body)含 `Bearer <值>`/`token:`/`password:` 形态时,IPC `redact()` 的自由文本掩盖(FREE_TEXT_FIELD 含 `body` 键)将其改写为 `[masked]`,而 GUI 标注"正文即该哈希对应字节"——违反契约 §3.1 第 4 层与 §2.3"原始字节"定档;比较判定也可能误报。
- **修复**(两桥一致,G0-R01 同律):
  - `packages/desktop/src/shell/shared/redact.ts` 与 `packages/desktop/src/probe/shared/bridge.ts`:新增 `BYTE_FAITHFUL_FIELD = new Set(["body"])`——`body` 键的字符串值跳过显示掩盖、逐字节透传。理由写入两处注释:body 是内容寻址载荷字节(配对 content_hash/proposed_body_hash/handoff 摘要哈希),掩盖即破坏哈希对应;需要掩盖的自由文本显示字段用其他键名(message/detail/note/reason/question/…)。
  - 契约 v8 §4 补记"哈希配对正文逐字节保真"(验收观察 O-B)。
- **回归测试**:
  - `shell-contract.test.ts` / `probe-contract.test.ts`:含 `Bearer …`/`token:` 形态的 body 断言逐字节相等且无 `[masked]`;message 字段仍被掩盖(第 3 层不回退)。
  - `g5.e2e.spec.ts`:MCP 发布含 `Bearer …`/`token:` 形态的文档 → 经真实 shell IPC `knowledge:readDocument` 断言 `sha256(body) === content_hash` 且 Bearer 原文可达(渲染层收到的就是发布字节)。
- **复验运行**(全部退出码 0):
  - `npm run check`:**545/545 PASS(57 文件)**(较返工前 +2,即两个新 redact 用例)。
  - shell E2E 全量:**14/14 PASS**。第一轮出现一例 `g2.e2e.spec.ts:281`(launcher 配置损坏显式失败)失败,与本次改动面无关;单独重跑 5/5 PASS、随后全量复跑 14/14 PASS——判定为一次性抖动,记录于此备查。
  - probe 回归与双桥一致性:同套测试覆盖。

## 遗留跟进(验收观察项,不阻塞)

- **O-A**:G4 遗留真机证据(gui-03…07 + FINDINGS.md)仍未采——按 G4 验收裁定随 G7 产品证据收口最迟补齐;G5 知识页真机截图同批。
- **O-C**:候选/修订分页无翻页控件(条目规模有限,单页渲染)。
- **O-D**:比较为并排显示+哈希对照,非逐字 diff(计划 §13 允许轻量)。

## 结论

R1 已修复并按验收指定的复验方法(含 Bearer 形态正文经 readDocument 的 sha256 断言、check 与 shell E2E 全绿)复验通过。进入下一子阶段(G6,先计划留档)。
