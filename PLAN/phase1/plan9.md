# Next Stage Plan: MVP Packaging / Phase 5B

日期：2026-06-26

## 1. 阶段定位

阶段名称：

```text
MVP Packaging / Phase 5B
```

上一阶段已经完成：

```text
Phase 5: PolicyEngine v1 / Policy Audit Skeleton
  - PolicyEngine.evaluate()
  - decideToolPolicy() compatibility facade
  - PolicyAuditEvent
  - policy_decision trace event
  - policy metrics aggregation
  - safety report v1 helper
  - test:mvp
```

当前阶段目标：

> 把已经完成的 runtime 内核能力包装成一个新用户能理解、能运行、能验证、能信任的开源 MVP。

一句话：

```text
先让项目像一个清晰的通用本地 Web Agent 平台，
再进入更深的 WorkflowEngine / SkillSystem 架构改造。
```

本阶段不是继续扩 Policy DSL，也不是重写 workflow。

本阶段要解决的是：

```text
项目现在能力已经像平台，
但文档、demo、命名和开源入口仍像 job-only 工具。
```

---

## 2. 第一性原则

MVP Packaging 的第一性原理：

> 开源用户首先需要在 10 分钟内看懂项目定位、跑通一个安全 demo、看到 trace/metrics/safety report，而不是先理解内部架构路线图。

拆开看：

```text
README:
  说明这是通用本地 Web Agent runtime。

Quickstart:
  给出最短可运行路径。

Demo:
  证明项目不是只会求职投递。

Safety Model:
  说明 runtime 为什么不会自动登录、处理验证码或最终提交。

test:mvp:
  给维护者一个稳定回归入口。

Trace / metrics / safety report:
  给用户一个可复盘、可审计的信任入口。
```

---

## 3. 严格边界

必须遵守：

1. 不重写 `runAgentLoop`。
2. 不启动 Phase 6 的完整 `WorkflowEngine` / `WorkflowDefinition` / state store。
3. 不引入 SkillSystem。
4. 不改 `packages/claude-code`。
5. 不改 ToolRegistry 对外接口。
6. 不改变 local adapter / MCP adapter 的核心契约。
7. 不做真实自动登录。
8. 不处理验证码，只继续表达 human handoff。
9. 不自动最终提交。
10. 不承诺“任意网站任意任务全自动”。
11. 不让 runtime / context / policy / workflow 读取 trace artifacts。

允许：

1. 新增 non-job demo。
2. 新增或调整 CLI demo command / npm script alias。
3. 新增 docs / examples。
4. 让 existing run finish 后额外生成 safety report，但必须保持旁路性质。
5. 更新 README / Quickstart / package docs。
6. 更新 `test:mvp`，但必须保持现有测试继续通过。

---

## 4. Phase 5B 范围

### 4.1 Demo Research v1

建议新增一个非求职 demo：

```text
demo-research
```

目标：

```text
展示只读网页观察、结构化页面理解、trace/metrics 输出，
证明平台不是 job-only。
```

推荐第一版实现方式：

- 使用本地 HTML fixture 或 data URL，避免网络不稳定。
- 页面内容可以是一个小型产品/文档/FAQ/表格页面。
- demo 只使用 observation / safe navigation / summary，不触发高风险动作。
- 输出 trace + metrics。
- 如果成本可控，运行后生成 safety report。

候选文件范围：

```text
packages/web-buddy/src/cli/demo.ts
packages/web-buddy/src/sdk/orchestrator.ts
packages/web-buddy/scripts/benchmark-research.mjs
packages/web-buddy/package.json
```

建议命令：

```json
{
  "demo:research": "npm run build && node ./dist/cli/demo.js demo-research --headless",
  "benchmark:research": "npm run build && node ./scripts/benchmark-research.mjs"
}
```

验收：

- 不需要真实招聘网站。
- 不需要登录。
- 不触发 L3/L4。
- 生成 metrics。
- 能在 README 里作为通用 Web Agent 示例展示。

### 4.2 Safety Report Entry

当前已有 `safety-report.ts` helper 和测试，但用户入口还不明显。

建议新增：

```text
packages/web-buddy/scripts/safety-report.mjs
```

建议能力：

```bash
node ./scripts/safety-report.mjs --run-id <runId>
node ./scripts/safety-report.mjs --trace-dir output/traces/<sessionId>
```

可选增强：

- 在 `TraceRecorder.finish()` 后 best-effort 生成 safety report。
- 或先只提供显式 npm script，避免改变运行产物默认行为。

推荐第一版：

```json
{
  "report:safety": "npm run build && node ./scripts/safety-report.mjs"
}
```

验收：

- 能从已有 trace 生成 `safety-report.json`。
- README / Safety Model 说明如何查看。
- 不影响 runtime 行为。

### 4.3 README / Quickstart Rewrite

修改范围：

```text
README.md
packages/web-buddy/README.md
```

第一屏目标：

```text
Multi-Functional Agent
= local, auditable Web Agent runtime
```

必须表达：

- 项目是通用本地 Web Agent 平台。
- 求职投递是 flagship workflow，不是唯一能力。
- 核心能力是 browser tools / observation / context / policy / trace / metrics。
- 默认安全：不自动登录、不处理验证码、不最终提交。

Quickstart 推荐结构：

```text
1. install/build
2. run demo:form
3. run demo:research
4. inspect output trace/metrics/safety report
5. optional: run job application workflow
6. optional: run Web UI
```

验收：

- 新用户不需要真实招聘网站就能跑通。
- 命令和 package scripts 对齐。
- README 不再把阿里/求职放成第一定位。

### 4.4 Safety Model 文档

建议新增：

```text
docs/safety-model.md
```

内容结构：

```text
1. Safety goals
2. Risk levels L0-L4
3. PolicyEngine decisions: allow / gate / block / auto_confirm
4. HumanGate responsibilities
5. Workflow phases and sensitive gates
6. Final submit contract
7. Login / captcha handoff contract
8. Trace / metrics / safety report
9. What runtime never does
10. Known limitations
```

必须说清：

- PolicyEngine 只判断，不执行工具。
- HumanGate 只确认/接管，不推理策略。
- Trace/metrics/safety report 是旁路复盘，不是 runtime state source。
- Raw mode 的 auto-confirm 是兼容行为，应在文档中标注适用边界。

验收：

- README 链接到该文档。
- 文档能解释 Phase 5 的安全边界。

### 4.5 Examples / Demo Positioning

第一版不一定要搬目录，但文档上要明确三类示例：

```text
demo-form:
  local form fill, shows FormState and policy gate before submit.

demo-research:
  read-only web information gathering, shows observation/context/metrics.

job-application:
  flagship complex workflow, shows high-risk gates and human handoff.
```

可选目录：

```text
examples/form-fill/README.md
examples/web-research/README.md
examples/job-application/README.md
```

建议先做 README 索引，不急着迁移代码。

### 4.6 MVP Verification

当前已有：

```bash
npm run test:mvp
```

本阶段需要：

- README 说明 `test:mvp` 是维护者验证入口。
- 如新增 `demo-research` / `benchmark:research`，将其纳入 `test:mvp` 或新增 `test:mvp:packaging`。
- 记录当前 `npx tsc --noEmit` 的既有失败，不把它混入 Phase 5B 验收，除非决定专门修。

---

## 5. 推荐执行波次

### Wave 0: Phase 5 Closeout Sync

已完成 / 应完成：

- 更新 `PLAN/plan-all.md`：Phase 5 改为已完成第一版。
- 更新 `docs/agent-iteration-log.md`：记录 Phase 5 实施、验证、遗留项。
- 新增本计划 `PLAN/plan9.md`。

### Wave 1: Demo Research Skeleton

目标：

- 新增 `demo-research` 命令。
- 使用本地 fixture 跑通只读观察链路。
- 生成 trace / metrics。

建议测试：

```bash
cd packages/web-buddy
npm run build
npm run demo:research
npm run benchmark:research
```

### Wave 2: Safety Report CLI

目标：

- 新增 `scripts/safety-report.mjs`。
- 从 runId / traceDir 生成 `safety-report.json`。
- README 记录查看方式。

建议测试：

```bash
cd packages/web-buddy
npm run test:safety-report
npm run report:safety -- --run-id <latest-run-id>
```

### Wave 3: README / Quickstart

目标：

- 重写 root README 第一屏。
- 更新 `packages/web-buddy/README.md`。
- 增加 demo-form / demo-research / job-application 的定位表。
- 将 Safety Model / test:mvp / report:safety 接入文档。

### Wave 4: Safety Model Doc

目标：

- 新增 `docs/safety-model.md`。
- 链接 README。
- 覆盖 PolicyEngine / HumanGate / trace boundary。

### Wave 5: Verification / Audit

必须运行：

```bash
cd packages/web-buddy
npm run test:mvp
```

如新增 research benchmark：

```bash
npm run benchmark:research
```

边界检查：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  packages/web-buddy/src/tools \
  packages/web-buddy/src/policy \
  packages/web-buddy/src/workflow \
  --glob '*.ts'
```

期望：

- runtime / context / workflow / tools / PolicyEngine 不读取 trace artifacts。
- safety report / metrics / benchmark 可以读取 trace artifacts。

---

## 6. 验收标准

Phase 5B 完成时必须满足：

1. README 第一屏定位为通用本地 Web Agent runtime。
2. 求职投递被描述为 flagship workflow / example，而不是项目唯一目标。
3. 有一个 non-job demo：`demo-research` 或等价入口。
4. non-job demo 不依赖真实账号、验证码、招聘网站。
5. demo 输出 trace / metrics。
6. Safety Model 文档存在并被 README 链接。
7. README 说明如何运行 `npm run test:mvp`。
8. README 说明如何查看 metrics / safety report。
9. `npm run test:mvp` 通过。
10. `packages/claude-code` 未改。
11. Runtime / context / workflow / PolicyEngine 不读取 trace artifacts。
12. 不引入完整 WorkflowEngine / SkillSystem。

---

## 7. 建议 Agent 拆分

### Agent A: Demo Research

文件范围：

```text
packages/web-buddy/src/cli/demo.ts
packages/web-buddy/src/sdk/orchestrator.ts
packages/web-buddy/scripts/benchmark-research.mjs
packages/web-buddy/package.json
```

职责：

- 新增 read-only non-job demo。
- 输出 trace / metrics。
- 添加回归脚本。

### Agent B: Safety Report CLI

文件范围：

```text
packages/web-buddy/scripts/safety-report.mjs
packages/web-buddy/package.json
```

职责：

- 提供用户可调用的 safety report 入口。
- 不改变 runtime state。

### Agent C: README / Quickstart

文件范围：

```text
README.md
packages/web-buddy/README.md
```

职责：

- 改通用 Web Agent 定位。
- 写最短 quickstart。
- 链接 demo / metrics / safety report / safety model。

### Agent D: Safety Model Docs

文件范围：

```text
docs/safety-model.md
docs/full-experience-guide.md
```

职责：

- 写安全模型。
- 如需要，更新完整体验教程引用。

### Agent E: Verification / Release Notes

文件范围：

```text
docs/agent-iteration-log.md
PLAN/plan-all.md
```

职责：

- 验证 Phase 5B 是否满足验收。
- 更新迭代记录。

---

## 8. 不做事项

本阶段明确不做：

- 完整 WorkflowEngine。
- WorkflowDefinition / WorkflowStateStore 大迁移。
- SkillSystem。
- 站点级 skill overlay。
- Web UI 大重写。
- 多用户 / worker / queue。
- 真实自动登录。
- 验证码自动处理。
- 最终提交自动化。
- Policy DSL。

---

## 9. 风险与控制

| 风险 | 影响 | 控制方式 |
| --- | --- | --- |
| demo-research 依赖外网 | 新用户跑不通 | 第一版优先本地 fixture |
| README 继续 job-first | 开源定位变窄 | 第一屏改成 Web Agent runtime |
| 过早做 WorkflowEngine | 回归面扩大 | Phase 5B 只做包装与 demo |
| safety report 反向进入 runtime | 破坏 trace 旁路边界 | 只放 scripts / docs / report helper |
| test:mvp 过慢 | 维护体验差 | 保持 benchmark 可控，research demo 本地化 |
| raw mode 被误解为安全默认 | 用户误用 | Safety Model 标注 raw auto-confirm 边界 |

---

## 10. 建议提交拆分

推荐 commit 顺序：

```text
docs: mark policy engine phase complete
feat(web-buddy): add read-only research demo
feat(web-buddy): add safety report CLI
docs: rewrite MVP quickstart
docs: add safety model
test(web-buddy): include MVP packaging checks
```

如果希望更小：

```text
docs: add Phase 5B plan
docs: clarify generic Web Agent positioning
```
