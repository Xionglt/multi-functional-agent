# Phase 2 Plan 1: SessionStore + KernelEvent

> 目标：先让 Agent “记得住发生了什么”，再谈更深的 Kernel、Workflow、Permission 和 SkillSystem。
> 这是 Phase 2 的第一份实施计划，对应总纲里的 `2A SessionStore + KernelEvent`。

## 1. 为什么第一步做这个

当前项目已经能跑 Web Agent demo，也有 trace、metrics、safety report。但它还缺一个真正的运行时事实源。

现在的问题是：

- trace 是旁路审计，不应该被 runtime 当状态数据库。
- Web server 里的 run state 主要是内存 map，刷新、重启、断线后无法可靠恢复。
- `runAgentLoop` 内部知道发生了什么，但这些关键事件没有统一持久化到 session。
- 后续做 `AgentKernel`、`PermissionEngine`、`WorkflowEngine`、`SkillSystem` 都需要一个稳定的 session 基础。

所以第一步不是重写主循环，而是在现有行为不变的前提下，补一个最小但正确的：

- `SessionStore`
- append-only `transcript.jsonl`
- `KernelEvent`
- `SessionRecorder`

第一性原理：

> Agent 的可恢复性来自 append-only transcript + 当前 snapshot。Trace 负责审计，Session 负责恢复。

## 2. 对比参照

## 2.1 Claude Code 参照

Claude Code 的关键能力不是工具多，而是 session 体系稳：

- `utils/sessionStorage.ts`: session 文件、transcript、append entry。
- `utils/sessionRestore.ts`: 从 transcript 恢复状态。
- `query.ts`: 每个 turn 和 tool result 都进入主循环状态。
- `Tool.ts`: 工具执行时携带上下文和权限信息。

Phase 2 Plan 1 只借鉴其中最底层的部分：

- append-only transcript。
- session metadata。
- resume 所需 snapshot。
- 事件和 transcript 分离。

不照搬：

- 复杂 UI/TUI 状态。
- subagent transcript。
- worktree/file attribution。
- 大型 command system。

## 2.2 Hermes 参照

Hermes 更强调长期运行和可检索状态：

- SessionDB。
- 历史消息。
- memory/skills/cron/delegation。
- session source tagging。

Plan 1 不直接上 SQLite/FTS，因为当前项目还处在 Web Agent runtime 到 Agent Kernel 的过渡期。第一版用文件型 JSONL 更合适：

- 更容易检查。
- 更容易接入当前 output 目录。
- 更容易做测试。
- 后续可以再升级为 SQLite，而不改变 transcript entry schema。

## 3. 当前项目状态

当前相关文件：

- `packages/web-buddy/src/runtime/local/agent-loop.ts`
  - 当前主循环。
  - 已经知道 goal、messages、tool call、policy decision、tool result、workflow state。
- `packages/web-buddy/src/agent/agent-runtime.ts`
  - 当前只是 facade。
- `packages/web-buddy/src/sdk/orchestrator.ts`
  - 负责 demo/sdk 流程编排。
  - 已经创建 `TraceRecorder`。
- `packages/web-buddy/src/sdk/trace.ts`
  - trace recorder。
  - trace 是审计，不是状态源。
- `packages/web-buddy/src/agent-trace/*`
  - agent trace session。
- `packages/web-buddy/src/web/server.ts`
  - 目前有 `RunState` 和 `RuntimeRunState` 内存 map。
- `packages/web-buddy/src/workflow/workflow-state.ts`
  - 当前轻量 workflow state。
- `packages/web-buddy/src/policy/policy-engine.ts`
  - 当前 policy decision。

Plan 1 要做的是给这些已有流程加 session 记录，不要立刻重构成完整 `AgentKernel`。

## 4. 本阶段目标

完成后应该具备：

1. 每次 Agent run 都有一个 `sessionId`。
2. 每个 session 有目录：

```text
output/sessions/<sessionId>/
  session.json
  transcript.jsonl
  events.jsonl
  workflow.json
```

3. runtime 可以 append：

- 用户目标。
- assistant 消息。
- tool call。
- tool result。
- policy decision。
- workflow snapshot。
- final result。
- error/blocker。

4. `KernelEvent` 成为后续 UI、trace、metrics、session 的统一事件语言。
5. 删除 trace artifacts 不影响 session 文件完整性。
6. 不改变现有 demo 和 benchmark 的外部行为。

## 5. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不引入完整 `AgentKernel`。
- 不做 resume 执行，只保存 resume 所需状态。
- 不做完整 `WorkflowEngine`。
- 不做 `PermissionEngine`。
- 不做 `SkillSystem`。
- 不做 SQLite。
- 不让 runtime 读取 trace artifacts。
- 不把 safety report 改成 session 驱动。

## 6. 目标文件结构

新增文件：

```text
packages/web-buddy/src/kernel/
  kernel-events.ts

packages/web-buddy/src/session/
  session-types.ts
  session-store.ts
  transcript.ts
  session-recorder.ts
  index.ts

packages/web-buddy/scripts/
  session-store-test.mjs
  session-runtime-smoke-test.mjs
```

可选新增：

```text
docs/session-model.md
```

修改文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/agent/types.ts
packages/web-buddy/src/sdk/orchestrator.ts
packages/web-buddy/src/cli/demo.ts
packages/web-buddy/src/web/server.ts
packages/web-buddy/package.json
README.md
packages/web-buddy/README.md
docs/agent-iteration-log.md
```

如果为了降低风险，第一轮可以先不改 `web/server.ts`，只让 SDK/demo/runtime 写 session。Web UI 接入可以放到 Plan 2 或 Plan 8。

## 7. 数据模型

## 7.1 AgentSession

```ts
export type AgentSessionSource = 'cli' | 'web' | 'sdk' | 'benchmark' | 'test'

export type AgentSessionStatus =
  | 'created'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface AgentSession {
  version: 1
  sessionId: string
  runId: string
  source: AgentSessionSource
  status: AgentSessionStatus
  goal: string
  mode?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  blockedReason?: string
  error?: string
  outputDir: string
  transcriptPath: string
  eventsPath: string
  workflowPath: string
  traceRunId?: string
}
```

设计原则：

- `sessionId` 是 session 主键。
- `runId` 可以沿用 trace run id 或 runtime run id，但不要求相同。
- `status` 是恢复入口最重要的字段。
- `traceRunId` 只是关联审计，不是恢复依赖。

## 7.2 TranscriptEntry

```ts
export type TranscriptEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | PolicyDecisionEntry
  | WorkflowSnapshotEntry
  | FinalResultEntry
  | ErrorEntry

export interface TranscriptEntryBase {
  version: 1
  sessionId: string
  runId: string
  entryId: string
  ts: string
  turnId?: string
}
```

建议 entry：

```ts
export interface UserMessageEntry extends TranscriptEntryBase {
  type: 'user_message'
  content: string
}

export interface AssistantMessageEntry extends TranscriptEntryBase {
  type: 'assistant_message'
  content: unknown
}

export interface ToolCallEntry extends TranscriptEntryBase {
  type: 'tool_call'
  toolCallId: string
  name: string
  args: unknown
}

export interface ToolResultEntry extends TranscriptEntryBase {
  type: 'tool_result'
  toolCallId: string
  name: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface PolicyDecisionEntry extends TranscriptEntryBase {
  type: 'policy_decision'
  toolCallId?: string
  toolName?: string
  decision: unknown
}

export interface WorkflowSnapshotEntry extends TranscriptEntryBase {
  type: 'workflow_snapshot'
  workflowState: unknown
}

export interface FinalResultEntry extends TranscriptEntryBase {
  type: 'final_result'
  status: 'completed' | 'blocked' | 'failed' | 'aborted'
  result?: unknown
  reason?: string
}

export interface ErrorEntry extends TranscriptEntryBase {
  type: 'error'
  message: string
  stack?: string
}
```

原则：

- transcript 是 append-only。
- 不在 transcript 里写全量截图、全量 DOM、大文件。
- 大对象后续用 content-address 文件引用。
- 本阶段可以先直接写轻量 JSON。

## 7.3 KernelEvent

```ts
export type KernelEventType =
  | 'session_created'
  | 'session_started'
  | 'turn_started'
  | 'turn_completed'
  | 'model_message'
  | 'tool_call_created'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'policy_evaluated'
  | 'workflow_updated'
  | 'human_gate_requested'
  | 'human_gate_resolved'
  | 'session_blocked'
  | 'session_completed'
  | 'session_failed'
  | 'session_aborted'

export interface KernelEvent {
  version: 1
  type: KernelEventType
  sessionId: string
  runId: string
  ts: string
  turnId?: string
  toolCallId?: string
  message?: string
  data?: Record<string, unknown>
}
```

原则：

- `KernelEvent` 是实时事件。
- `TranscriptEntry` 是恢复事实。
- 二者可以有重叠，但职责不同。
- event 可以用于 UI/trace/metrics。
- transcript 必须足够恢复关键状态。

## 8. SessionStore API

建议第一版 API：

```ts
export interface CreateSessionInput {
  runId?: string
  source: AgentSessionSource
  goal: string
  mode?: string
  traceRunId?: string
  now?: string
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>
  get(sessionId: string): Promise<AgentSession | undefined>
  update(sessionId: string, patch: Partial<AgentSession>): Promise<AgentSession>
  appendTranscript(entry: TranscriptEntry): Promise<void>
  appendEvent(event: KernelEvent): Promise<void>
  writeWorkflowSnapshot(sessionId: string, workflowState: unknown): Promise<void>
  list(options?: { limit?: number; status?: AgentSessionStatus }): Promise<AgentSession[]>
}
```

第一版实现：

```ts
export class FileSessionStore implements SessionStore {
  constructor(options: { rootDir: string })
}
```

默认目录：

```text
output/sessions/
```

写文件原则：

- 创建 session 时 `mkdir -p output/sessions/<sessionId>`。
- `session.json` 用 pretty JSON。
- `transcript.jsonl` append 一行一个 JSON。
- `events.jsonl` append 一行一个 JSON。
- `workflow.json` 保存最新 workflow snapshot。
- 写入失败不应该悄悄吞掉；但在 runtime 集成第一版，可以 best-effort 记录并 emit warning，避免影响现有 demo。

## 9. SessionRecorder

为了不让 `runAgentLoop` 直接依赖文件系统，新增薄接口：

```ts
export interface SessionRecorder {
  readonly session: AgentSession
  event(event: Omit<KernelEvent, 'version' | 'sessionId' | 'runId' | 'ts'>): Promise<void>
  transcript(entry: Omit<TranscriptEntry, 'version' | 'sessionId' | 'runId' | 'entryId' | 'ts'>): Promise<void>
  workflow(workflowState: unknown): Promise<void>
  updateStatus(status: AgentSessionStatus, patch?: Partial<AgentSession>): Promise<void>
}
```

提供：

- `FileSessionRecorder`
- `NoopSessionRecorder`

这样现有 runtime 可以选择性接入：

- 有 session recorder 就写。
- 没有就不影响旧流程。

## 10. 集成点

## 10.1 sdk/orchestrator.ts

当前 `orchestrator` 已经创建 `TraceRecorder`，这里适合创建 session。

建议：

1. 根据 runId/source/goal 创建 `FileSessionStore`。
2. 创建 `SessionRecorder`。
3. 传给 `AgentRuntime` 或 `runAgentLoop`。
4. 运行结束时更新 session status。

注意：

- `traceRunId` 只是关联字段。
- 不允许 session recorder 读取 trace output。

## 10.2 runtime/local/agent-loop.ts

`AgentLoopInput` 增加可选字段：

```ts
session?: SessionRecorder
```

记录点：

- loop start:
  - `session_started`
  - `user_message`
- each model turn:
  - `turn_started`
  - `assistant_message`
  - `model_message`
- tool call:
  - `tool_call`
  - `tool_call_created`
- policy decision:
  - `policy_decision`
  - `policy_evaluated`
- tool result:
  - `tool_result`
  - `tool_completed` or `tool_failed`
- workflow update:
  - `workflow_snapshot`
  - `workflow_updated`
  - `workflow.json`
- final:
  - `final_result`
  - `session_completed` / `session_blocked` / `session_failed`

不要在本阶段改变：

- LLM prompt。
- tool schema。
- policy decision。
- workflow transition。
- stop condition。

## 10.3 cli/demo.ts

让 demo 输出 session 路径，例如：

```text
Session: output/sessions/<sessionId>/session.json
Transcript: output/sessions/<sessionId>/transcript.jsonl
```

这对调试很重要。

## 10.4 web/server.ts

第一版可选。

低风险做法：

- API 返回 `sessionId`。
- runtime event 附带 `sessionId`。
- 仍保留现有内存 map。

不要第一步就把 Web UI 状态全部迁移到 SessionStore，避免把 Phase 2A 变成 UI 重构。

## 11. 测试计划

新增脚本：

```text
packages/web-buddy/scripts/session-store-test.mjs
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
```

## 11.1 session-store-test

覆盖：

- create session。
- append transcript。
- append event。
- update status。
- write workflow snapshot。
- list sessions。
- JSONL 每行可 parse。

断言：

- `session.json` 存在。
- `transcript.jsonl` 存在。
- `events.jsonl` 存在。
- `workflow.json` 存在。
- session status 更新正确。

## 11.2 session-runtime-smoke-test

用 mock LLM / mock registry 跑最小 agent loop。

覆盖：

- user_message 被写入。
- assistant_message 被写入。
- tool_call 被写入。
- tool_result 被写入。
- workflow_snapshot 被写入。
- final_result 被写入。
- session 最终 completed 或 blocked。

## 11.3 trace boundary test

增加一个边界测试或扫描：

- runtime/session/context/workflow 不读取 `output/traces`。
- session resume 所需信息来自 `output/sessions`。

可以先用 `rg` 扫描作为轻量检查。

## 12. package scripts

`packages/web-buddy/package.json` 增加：

```json
{
  "scripts": {
    "test:session": "node scripts/session-store-test.mjs && node scripts/session-runtime-smoke-test.mjs"
  }
}
```

并把 `test:mvp` 扩展包含 `test:session`。

## 13. 文档更新

需要更新：

- `packages/web-buddy/README.md`
  - 增加 session artifacts 说明。
- `README.md`
  - Documentation 或 verification 增加 session。
- `docs/agent-iteration-log.md`
  - 记录 Phase 2A 完成内容。
- 可选新增 `docs/session-model.md`
  - 说明 SessionStore 和 Trace 的边界。

## 14. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:session` 通过。
3. 原有 `npm run test:mvp` 通过。
4. demo 跑完后生成：

```text
output/sessions/<sessionId>/session.json
output/sessions/<sessionId>/transcript.jsonl
output/sessions/<sessionId>/events.jsonl
output/sessions/<sessionId>/workflow.json
```

5. `transcript.jsonl` 至少包含：

- `user_message`
- `assistant_message` 或等价 model message。
- `tool_call`。
- `tool_result`。
- `workflow_snapshot`。
- `final_result`。

6. session status 最终是：

- `completed`
- `blocked`
- `failed`
- `aborted`

不能停留在 `running`，除非进程被强杀。

7. 删除 `output/traces/<runId>` 后，`output/sessions/<sessionId>` 仍然完整可读。
8. runtime 没有新增读取 trace artifact 的行为。

## 15. 风险和规避

| 风险 | 规避 |
|---|---|
| 过早重构主循环 | 本阶段只加 recorder，不改变行为 |
| session 和 trace 职责混淆 | 文档和测试明确 runtime 不读 trace |
| transcript 写入大对象 | 大对象后续 content-address，本阶段只写轻量数据 |
| 文件写入失败影响 demo | 第一版 runtime 集成可 best-effort，但测试里必须 fail fast |
| Web UI 迁移范围扩大 | Phase 2A 只返回 sessionId，不重做 cockpit |
| schema 频繁变 | 所有 entry 加 `version: 1` |

## 16. 实施步骤

## 16.1 Step A: 类型和事件

新增：

- `kernel/kernel-events.ts`
- `session/session-types.ts`

完成：

- `KernelEvent` 类型。
- `AgentSession` 类型。
- `TranscriptEntry` 类型。
- status/source 枚举类型。

验证：

- TypeScript build 通过。

## 16.2 Step B: FileSessionStore

新增：

- `session/transcript.ts`
- `session/session-store.ts`
- `session/index.ts`

完成：

- 创建 session 目录。
- 写 `session.json`。
- append `transcript.jsonl`。
- append `events.jsonl`。
- 写 `workflow.json`。
- list sessions。

验证：

- `session-store-test.mjs` 通过。

## 16.3 Step C: SessionRecorder

新增：

- `session/session-recorder.ts`

完成：

- `FileSessionRecorder`。
- `NoopSessionRecorder`。
- helper 自动补齐 `version/sessionId/runId/entryId/ts`。

验证：

- 单测或脚本覆盖 recorder。

## 16.4 Step D: Runtime 低风险接入

修改：

- `agent/types.ts`
- `runtime/local/agent-loop.ts`

完成：

- `AgentLoopInput` 支持 `session?: SessionRecorder`。
- 在关键点 append transcript/event。
- workflow state 更新时写 workflow snapshot。
- finally 中更新 status。

验证：

- `session-runtime-smoke-test.mjs` 通过。
- 原有 runtime test 不变。

## 16.5 Step E: Orchestrator/Demo 接入

修改：

- `sdk/orchestrator.ts`
- `cli/demo.ts`

完成：

- 创建 FileSessionStore。
- 创建 session。
- 传入 runtime。
- 输出 session path。

验证：

- `npm run demo:research` 或最小 demo 生成 session artifacts。

## 16.6 Step F: 文档和 test:mvp

修改：

- `package.json`
- README/docs。

完成：

- 增加 `test:session`。
- `test:mvp` 包含 session 测试。
- 文档说明 session/trace 边界。

## 17. 给实现 Agent 的提示词

下面这段可以直接给后续实现 Agent：

```text
你正在实现 Phase 2A: SessionStore + KernelEvent。

请先阅读：
- PLAN/phase2/README.md
- PLAN/phase2/architecture-clear.md
- PLAN/phase2/plan1.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/sdk/orchestrator.ts
- packages/web-buddy/src/sdk/trace.ts
- packages/web-buddy/src/workflow/workflow-state.ts

目标：
在不改变现有 runtime 行为的前提下，新增文件型 SessionStore、append-only transcript、KernelEvent、SessionRecorder，并把现有 agent loop 的关键事件写入 output/sessions/<sessionId>/。

硬约束：
1. 不重写 runAgentLoop。
2. 不引入完整 AgentKernel。
3. 不做 WorkflowEngine/PermissionEngine/SkillSystem。
4. Runtime/session/context/workflow 不允许读取 output/traces。
5. Trace 只作为审计关联，不能作为 session 恢复来源。
6. 原有 demo/test 行为必须保持兼容。

验收：
- npm run build
- npm run test:session
- npm run test:mvp
- demo 运行后能看到 output/sessions/<sessionId>/session.json、transcript.jsonl、events.jsonl、workflow.json。
```

## 18. 完成后进入下一计划的条件

只有当 Phase 2A 满足以下条件，才进入 Plan 2:

- 每个 run 都能生成 session。
- transcript 结构稳定。
- workflow snapshot 已经可持久化。
- session status 能正确结束。
- runtime 不依赖 trace artifact。
- Web/CLI/SDK 至少有一个入口能返回或显示 sessionId。

Plan 2 才开始做：

- `AgentKernel Skeleton`
- `QueryLoop`
- `TurnState`
- `RunController`

也就是说，Plan 1 是地基里的地基。它不追求显眼功能，但决定后续 Agent 能不能真正做成。
