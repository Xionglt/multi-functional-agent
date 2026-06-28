# Phase 2 Plan 2: AgentKernel Skeleton + QueryLoop + RunController

> 目标：Phase 2A 已经让 Agent “记得住发生了什么”。Plan 2 要让 Agent 开始“控得住运行过程”。
> 本阶段不重写主循环，而是在现有 `runAgentLoop` 外面建立最小 Kernel 骨架，为后续 ToolExecutionService、PermissionEngine、WorkflowEngine 和 Task Cockpit 提供接入点。

## 1. 为什么第二步做 Kernel Skeleton

当前 Phase 2A 已完成：

- `SessionStore`
- append-only `transcript.jsonl`
- `events.jsonl`
- `workflow.json`
- `KernelEvent`
- `SessionRecorder`

这解决了“事实源”的问题。

但当前核心运行逻辑仍集中在：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
```

`runAgentLoop` 现在同时负责：

- turn 生命周期。
- LLM 调用。
- assistant message 和 tool call 处理。
- policy decision。
- HumanGate。
- tool execution。
- workflow transition。
- session recording。
- trace writing。
- stop condition。

如果下一步直接做 `ToolExecutionService` 或 `PermissionEngine`，这些逻辑仍然会被继续塞进 `runAgentLoop`，系统复杂度会越来越集中。

所以 Plan 2 先做一个最小但清晰的：

- `AgentKernel`
- `QueryLoop`
- `TurnState`
- `RunController`
- `TokenBudget` 占位能力

第一性原理：

> Agent 的核心不是一个 while loop，而是可控制、可观察、可中断、可恢复的 turn 状态机。

## 2. 当前项目状态

已有能力：

- Web browser tools。
- `ToolRegistry`。
- `ToolExecutionBoundary`。
- `ContextManager` / `PromptAssembler`。
- `PolicyEngine` / `HumanGate`。
- 轻量 `WorkflowState`。
- `TraceRecorder` / metrics / safety report。
- `SessionStore` / `SessionRecorder`。
- `AgentRuntime` facade。

当前差距：

- `AgentRuntime` 仍只是 facade，直接委托 `runAgentLoop`。
- 没有 `AgentKernel` 统一入口。
- 没有明确 `QueryLoop`。
- 没有显式 `TurnState`。
- 没有 `RunController` 管理 abort / pause / stop。
- 没有统一的 kernel-level result。
- KernelEvent 已存在，但还不是 Kernel 自己发出的事件流。

## 3. 本阶段目标

完成后应该具备：

1. 新增 `AgentKernel` 作为 runtime 内核入口。
2. 新增 `QueryLoop`，第一版内部仍调用现有 `runAgentLoop`。
3. 新增 `TurnState` 类型和最小状态 snapshot。
4. 新增 `RunController`，支持 `abort` 和状态查询。
5. `AgentRuntime.run()` 改为委托 `AgentKernel.start()`。
6. `runAgentLoop` 保持直接调用兼容。
7. session transcript 和 events 行为保持兼容。
8. CLI/demo/sdk 外部行为不改变。

## 4. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不拆模型调用和工具调用的内部细节。
- 不做完整 resume 执行。
- 不做完整 `ToolExecutionService`。
- 不做完整 `PermissionEngine`。
- 不迁移 Web UI 到 Task Cockpit。
- 不做 WorkflowEngine / Evidence。
- 不做 SkillSystem。
- 不改变 prompt、tool schema、policy decision 和 workflow transition 语义。

## 5. 目标文件结构

新增文件：

```text
packages/web-buddy/src/kernel/
  agent-kernel.ts
  query-loop.ts
  turn-state.ts
  run-controller.ts
  token-budget.ts
  index.ts

packages/web-buddy/scripts/
  agent-kernel-test.mjs
```

已有文件继续保留：

```text
packages/web-buddy/src/kernel/kernel-events.ts
```

修改文件：

```text
packages/web-buddy/src/agent/agent-runtime.ts
packages/web-buddy/src/agent/types.ts
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/package.json
README.md
packages/web-buddy/README.md
docs/agent-iteration-log.md
```

可选修改：

```text
docs/session-model.md
```

## 6. 设计原则

## 6.1 先包住，不拆开

第一版 `QueryLoop` 不直接重写模型 turn 和 tool turn，而是把现有 `runAgentLoop` 作为内部 delegate。

原因：

- 现有 runtime 行为已经被测试覆盖。
- 本阶段目标是建立 Kernel 边界，不是重写行为。
- 先让 `AgentRuntime` 走 Kernel，再逐步把内部逻辑从 `runAgentLoop` 拆出来。

## 6.2 Kernel 负责秩序

Kernel 不应该负责 Web 页面细节。它应该负责：

- run lifecycle。
- turn lifecycle。
- abort signal。
- event emission。
- session recorder 注入。
- result normalization。

Web 工具、Policy、Workflow 仍由现有模块负责。

## 6.3 兼容优先

以下入口必须继续可用：

- `runAgentLoop(...)`
- `new AgentRuntime().run(...)`
- `runJobApplicationAgent(...)`
- CLI demo。
- benchmark scripts。

## 7. 数据模型

## 7.1 AgentKernelStatus

```ts
export type AgentKernelStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'
```

## 7.2 AgentKernelInput

第一版复用 `AgentRuntimeInput` 的大部分字段：

```ts
export interface AgentKernelInput {
  goal: string
  resume: ResumeProfile
  llm: AgentRuntimeLlm
  registry?: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (event: KernelEvent) => void
  onRuntimeEvent?: (event: AgentRuntimeEvent) => void
  extraContext?: string
  safetyMode?: AgentSafetyMode
  session?: SessionRecorder
  controller?: AgentRunController
}
```

说明：

- `onEvent` 发 `KernelEvent`。
- `onRuntimeEvent` 兼容旧的 `AgentRuntimeEvent`。
- `session` 仍由 SDK/orchestrator 创建，Kernel 第一版不负责创建 `FileSessionStore`。
- `controller` 可由调用方传入，也可由 Kernel 内部创建。

## 7.3 AgentKernelResult

```ts
export interface AgentKernelResult {
  schemaVersion: 'agent-kernel-result/v1'
  runtime: 'agent-kernel'
  status: AgentKernelStatus
  stopReason: AgentStopReason
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  workflowState?: WorkflowState
  turnState?: TurnStateSnapshot
}
```

## 7.4 TurnState

```ts
export type TurnStatus =
  | 'created'
  | 'model_running'
  | 'tools_running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'aborted'

export interface TurnStateSnapshot {
  version: 1
  runId?: string
  sessionId?: string
  turnId: string
  step: number
  status: TurnStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  pendingToolCalls: Array<{
    toolCallId: string
    name: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  }>
  workflowState?: unknown
  error?: string
}
```

第一版 `TurnState` 允许是轻量 snapshot，不要求完整替代 `runAgentLoop` 内部 messages。

## 7.5 AgentRunController

```ts
export interface AgentRunController {
  readonly signal: AbortSignal
  readonly status: AgentKernelStatus
  abort(reason?: string): void
  markRunning(): void
  markBlocked(reason?: string): void
  markCompleted(): void
  markFailed(error: Error | string): void
}
```

第一版只必须支持：

- tool 执行前 abort。
- model turn 前 abort。
- result status 映射到 `aborted`。

暂停和 resume 只保留类型空间，不实现真实继续执行。

## 7.6 TokenBudget

本阶段只做占位和轻量统计：

```ts
export interface TokenBudgetSnapshot {
  version: 1
  maxInputTokens?: number
  estimatedInputTokens?: number
  estimatedToolResultTokens?: number
  compactRecommended: boolean
}
```

不做自动 compact。Plan 2 只为 2E Context Compaction 留接口。

## 8. 集成点

## 8.1 agent-runtime.ts

当前：

```ts
AgentRuntime.run() -> runAgentLoop()
```

改为：

```ts
AgentRuntime.run() -> AgentKernel.start()
```

返回值继续保持：

```ts
schemaVersion: 'agent-runtime-result/v1'
runtime: 'local-agent-loop'
```

也就是说，`AgentRuntime` 的外部契约不变，内部开始走 Kernel。

## 8.2 runtime/local/agent-loop.ts

新增可选字段：

```ts
abortSignal?: AbortSignal
```

最小检查点：

- loop start 之后。
- 每次 LLM 调用前。
- 每个 tool call 执行前。

如果 abort：

- 不执行后续 tool。
- 返回 `done=false`、`blocked=true`、`summary='Run aborted: ...'`。
- session status 更新为 `aborted`。

注意：

- 本阶段不要求中断正在进行中的 Playwright action。
- 只要求“工具执行前可 abort”。

## 8.3 QueryLoop

职责：

- 创建或接收 `AgentRunController`。
- 发出 kernel-level lifecycle events。
- 调用 `runAgentLoop`。
- 将 loop result 映射成 `AgentKernelResult`。
- 维护最后一个 `TurnStateSnapshot`。

第一版可以很薄：

```ts
export class QueryLoop {
  async run(input: QueryLoopInput): Promise<AgentKernelResult>
}
```

## 8.4 AgentKernel

职责：

- 对外暴露 `start(input)`。
- 创建 `QueryLoop`。
- 创建默认 `AgentRunController`。
- 统一发出：
  - `session_started`
  - `session_completed`
  - `session_blocked`
  - `session_failed`
  - `session_aborted`

如果 `SessionRecorder` 已经在 `runAgentLoop` 里记录这些事件，Kernel 第一版要避免重复写 transcript。可以只通过 `onEvent` 发实时事件，session 写入仍由 recorder 内部完成。

## 9. 事件策略

本阶段不扩展 `KernelEventType`，优先复用已有：

- `session_started`
- `turn_started`
- `turn_completed`
- `tool_started`
- `tool_completed`
- `tool_failed`
- `workflow_updated`
- `session_completed`
- `session_blocked`
- `session_failed`
- `session_aborted`

如果需要表达 abort 请求，可先用：

```ts
{
  type: 'session_aborted',
  message: 'Abort requested before tool execution.',
  data: { reason }
}
```

后续 Plan 3 或 Plan 4 再决定是否新增：

- `run_controller_updated`
- `abort_requested`
- `pause_requested`

## 10. 测试计划

新增：

```text
packages/web-buddy/scripts/agent-kernel-test.mjs
```

覆盖：

1. `AgentKernel.start()` 可以跑通 mock LLM。
2. 返回 `schemaVersion='agent-kernel-result/v1'`。
3. `AgentRuntime.run()` 仍返回旧的 `agent-runtime-result/v1`。
4. Kernel event 至少包含 `session_started` 和终态事件。
5. session transcript 仍包含：
   - `user_message`
   - `assistant_message`
   - `tool_call`
   - `tool_result`
   - `workflow_snapshot`
   - `final_result`
6. abort before tool execution 不执行工具，并返回 `aborted`。
7. 直接调用 `runAgentLoop` 的旧测试不需要改。

## 11. package scripts

`packages/web-buddy/package.json` 增加：

```json
{
  "scripts": {
    "test:kernel": "npm run build && node ./scripts/agent-kernel-test.mjs"
  }
}
```

并将 `test:mvp` 扩展包含：

```text
npm run test:kernel
```

## 12. 文档更新

需要更新：

- `README.md`
  - Verification 说明包含 kernel test。
- `packages/web-buddy/README.md`
  - Architecture 中加入 `kernel/agent-kernel.ts`。
- `docs/agent-iteration-log.md`
  - 记录 Phase 2B 完成内容。
- 可选更新 `docs/session-model.md`
  - 说明 Kernel 第一版仍复用 SessionRecorder，不直接创建 session。

## 13. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:kernel` 通过。
3. `npm run test:session` 通过。
4. `npm run test:mvp` 通过。
5. `AgentRuntime` 内部委托 `AgentKernel`。
6. `runAgentLoop` 保持兼容。
7. abort 能在工具执行前停止。
8. session status 能正确进入 `completed`、`blocked`、`failed` 或 `aborted`。
9. runtime/session/context/workflow 不读取 `output/traces`。

## 14. 风险和规避

| 风险 | 规避 |
|---|---|
| Kernel Skeleton 变成重写主循环 | 第一版 QueryLoop 只包 `runAgentLoop` |
| 事件重复写入 session | Kernel 发实时 `onEvent`，session 写入继续由 `SessionRecorder` 负责 |
| abort 语义过度承诺 | 本阶段只保证工具执行前 abort，不保证中断正在执行的 Playwright action |
| AgentRuntime 兼容性破坏 | 保持 `AgentRuntimeResult` 原 schema 不变 |
| 后续 ToolExecutionService 接不进来 | QueryLoop 预留 `controller`、`turnState`、`tokenBudget` |

## 15. 实施步骤

## 15.1 Step A: TurnState 和 RunController

新增：

- `kernel/turn-state.ts`
- `kernel/run-controller.ts`

完成：

- `TurnStateSnapshot` 类型。
- `createTurnStateSnapshot()` helper。
- `AgentRunController`。
- `DefaultAgentRunController`。

验证：

- TypeScript build 通过。

## 15.2 Step B: QueryLoop

新增：

- `kernel/query-loop.ts`

完成：

- `QueryLoop.run()`。
- 调用 `runAgentLoop`。
- 注入 `abortSignal`。
- 维护最后一个 turn snapshot。
- loop result 映射为 `AgentKernelResult`。

验证：

- mock LLM 正常完成。

## 15.3 Step C: AgentKernel

新增：

- `kernel/agent-kernel.ts`
- `kernel/index.ts`

完成：

- `AgentKernel.start()`。
- 创建默认 controller。
- 发 kernel lifecycle events。
- 返回 `AgentKernelResult`。

验证：

- `agent-kernel-test.mjs` 覆盖成功路径。

## 15.4 Step D: runAgentLoop abort 接入

修改：

- `runtime/local/agent-loop.ts`

完成：

- `AgentLoopInput` 支持 `abortSignal?: AbortSignal`。
- LLM 调用前检查 abort。
- tool 执行前检查 abort。
- abort 时 session final result 为 `aborted`。

验证：

- abort test 确认工具未执行。

## 15.5 Step E: AgentRuntime 委托 Kernel

修改：

- `agent/agent-runtime.ts`
- `agent/types.ts`

完成：

- `AgentRuntime.run()` 内部使用 `AgentKernel`。
- 外部返回 schema 保持 `agent-runtime-result/v1`。

验证：

- 现有 `agent-runtime-test.mjs` 不需要大改且通过。

## 15.6 Step F: scripts 和文档

修改：

- `package.json`
- README/docs。

完成：

- 增加 `test:kernel`。
- `test:mvp` 包含 kernel test。
- 文档说明 2B 完成内容。

## 16. 给实现 Agent 的提示词

```text
你正在实现 Phase 2B: AgentKernel Skeleton + QueryLoop + RunController。

请先阅读：
- PLAN/phase2/README.md
- PLAN/phase2/architecture-clear.md
- PLAN/phase2/plan1.md
- PLAN/phase2/plan2.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/agent/agent-runtime.ts
- packages/web-buddy/src/agent/types.ts
- packages/web-buddy/src/session/index.ts

目标：
在不重写 runAgentLoop、不改变现有 CLI/demo/sdk 外部行为的前提下，新增 AgentKernel、QueryLoop、TurnState、RunController，并让 AgentRuntime 委托 AgentKernel。

硬约束：
1. 不重写 runAgentLoop。
2. 不引入完整 ToolExecutionService。
3. 不做 PermissionEngine / WorkflowEngine / SkillSystem。
4. Runtime/session/context/workflow 不允许读取 output/traces。
5. runAgentLoop 必须保持直接调用兼容。
6. AgentRuntimeResult schema 必须保持兼容。

验收：
- npm run build
- npm run test:kernel
- npm run test:session
- npm run test:mvp
- abort before tool execution 能停止运行并标记 aborted。
```

## 17. 完成后进入下一计划的条件

只有当 Phase 2B 满足以下条件，才进入 Plan 3:

- `AgentRuntime` 已经通过 `AgentKernel` 启动。
- `runAgentLoop` 保持兼容入口。
- Kernel lifecycle events 稳定。
- `RunController` 至少支持 abort。
- `TurnStateSnapshot` 已经能表达当前 turn 状态。
- session 和 trace 边界没有倒退。

Plan 3 才开始做：

- `ToolExecutionService`
- `ToolUseContext`
- tool lifecycle state
- timeout / retry / abort 深化
- tool error normalization

也就是说，Plan 2 是“把方向盘装上”，Plan 3 才开始“改发动机和传动系统”。
