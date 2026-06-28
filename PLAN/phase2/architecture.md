# Phase 2 Agent Kernel 架构图

这份图用于快速理解 Phase 2 的目标结构：先把 Agent 底座做稳，再让 Web Buddy 作为第一个垂直能力接入。

如果这份完整图在 Markdown 预览里太小，优先看 `PLAN/phase2/architecture-clear.md`，里面把大图拆成了多张清晰图。

## 1. 总体架构

```mermaid
flowchart TB
  User[用户]

  subgraph Surface[产品入口层]
    WebUI[Task Cockpit Web UI]
    CLI[CLI / Demo]
    SDK[SDK API]
  end

  User --> WebUI
  User --> CLI
  User --> SDK

  subgraph Kernel[Agent Kernel 核心层]
    AgentKernel[AgentKernel]
    QueryLoop[QueryLoop / Turn Loop]
    RunController[RunController<br/>pause / resume / abort / stop]
    TokenBudget[TokenBudget<br/>context / tool result budget]
    KernelEvents[KernelEvent Stream]
  end

  WebUI --> AgentKernel
  CLI --> AgentKernel
  SDK --> AgentKernel
  AgentKernel --> QueryLoop
  AgentKernel --> RunController
  QueryLoop --> TokenBudget
  QueryLoop --> KernelEvents

  subgraph PromptLayer[上下文与提示层]
    ContextManager[ContextManager<br/>working set]
    PromptAssembler[PromptAssembler]
    Compaction[Context Compaction<br/>long task summary]
    SkillsContext[Skill Context Injection]
    MemoryContext[Memory Context Injection]
  end

  subgraph ModelLayer[模型层]
    LlmGateway[LlmGateway]
    Provider[Model Provider<br/>OpenAI / compatible APIs]
  end

  subgraph ToolLayer[工具执行层]
    ToolRegistry[ToolRegistry]
    ToolExecution[ToolExecutionService]
    ToolContext[ToolUseContext]
    ToolErrors[Tool Error Normalizer]
  end

  subgraph PermissionLayer[权限层]
    PolicyEngine[PolicyEngine<br/>risk evaluation]
    PermissionEngine[PermissionEngine<br/>allow / ask / deny]
    ApprovalQueue[ApprovalQueue]
    HumanGate[HumanGate]
  end

  subgraph WorkflowLayer[工作流层]
    WorkflowEngine[WorkflowEngine]
    WorkflowDefinition[WorkflowDefinition]
    WorkflowInstance[WorkflowInstance Snapshot]
    Evidence[Workflow Evidence]
    Guards[Workflow Guards]
  end

  subgraph StateLayer[状态事实源]
    SessionStore[SessionStore]
    Transcript[transcript.jsonl]
    WorkflowStore[WorkflowStore]
    PermissionStore[PermissionStore]
    MemoryStore[MemoryStore]
  end

  subgraph SkillLayer[技能层]
    SkillRegistry[SkillRegistry]
    SkillLoader[SkillLoader]
    SkillRecommender[SkillRecommender]
    JobSkill[job-application skill]
    AlibabaSkill[alibaba-careers skill]
    ResearchSkill[web-research skill]
  end

  subgraph WebDomain[Web 垂直执行域]
    BrowserTools[Browser Tools<br/>open / click / fill / upload / snapshot]
    Observation[ObservationManager<br/>PageState / FormState]
    Snapshot[Snapshot / Ref Resolver]
    BrowserSupervisor[BrowserSupervisor<br/>dialog / popup / stale ref]
  end

  subgraph Observability[观测与报告层]
    Trace[AgentTrace / TraceRecorder]
    Metrics[Metrics]
    SafetyReport[Safety Report]
    Benchmarks[Benchmarks / Eval]
    Doctor[Doctor]
  end

  QueryLoop --> PromptAssembler
  QueryLoop --> LlmGateway
  QueryLoop --> ToolExecution
  QueryLoop --> WorkflowEngine
  QueryLoop --> PermissionEngine
  QueryLoop --> SessionStore

  ContextManager --> PromptAssembler
  Compaction --> PromptAssembler
  SkillsContext --> PromptAssembler
  MemoryContext --> PromptAssembler
  SkillRegistry --> SkillsContext
  SkillRegistry --> WorkflowDefinition
  MemoryStore --> MemoryContext

  LlmGateway --> Provider

  ToolExecution --> ToolRegistry
  ToolExecution --> ToolContext
  ToolExecution --> ToolErrors
  ToolExecution --> BrowserTools
  BrowserTools --> BrowserSupervisor
  BrowserTools --> Observation
  BrowserTools --> Snapshot
  Observation --> ContextManager
  Observation --> Evidence
  Snapshot --> Observation

  PolicyEngine --> PermissionEngine
  PermissionEngine --> ApprovalQueue
  ApprovalQueue --> HumanGate
  HumanGate --> WebUI

  WorkflowEngine --> WorkflowInstance
  WorkflowEngine --> WorkflowDefinition
  WorkflowEngine --> Evidence
  WorkflowEngine --> Guards
  WorkflowEngine --> WorkflowStore

  SessionStore --> Transcript
  SessionStore --> WorkflowStore
  SessionStore --> PermissionStore
  SessionStore --> MemoryStore

  KernelEvents --> WebUI
  KernelEvents --> CLI
  KernelEvents --> Trace
  KernelEvents --> Metrics
  Trace --> SafetyReport
  Metrics --> SafetyReport
  Doctor --> WebUI
  Benchmarks --> Trace
  Benchmarks --> Metrics
```

## 2. 一次任务的运行流

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant UI as Task Cockpit / CLI / SDK
  participant K as AgentKernel
  participant S as SessionStore
  participant SK as SkillSystem
  participant C as ContextManager
  participant L as LlmGateway
  participant P as PermissionEngine
  participant T as ToolExecutionService
  participant W as WorkflowEngine
  participant O as ObservationManager
  participant R as Trace / Metrics

  U->>UI: 发起任务 goal
  UI->>K: start(goal, mode, options)
  K->>S: create session
  K->>SK: recommend skills(goal, domain, workflow)
  SK-->>K: skill context
  K->>C: build working context
  C-->>K: prompt sections
  K->>L: model turn(messages + context)
  L-->>K: assistant message / tool calls
  K->>S: append assistant/tool_call
  K->>P: evaluate permission(tool call, workflow, policy)

  alt allow
    P-->>K: allow
  else ask
    P-->>UI: approval request
    U->>UI: approve / reject
    UI-->>P: decision
    P-->>K: allow or deny
  else deny
    P-->>K: deny
  end

  alt permission allow
    K->>T: execute tool(call, ToolUseContext)
    T->>O: browser action / snapshot / page state
    O-->>T: PageState / FormState / evidence candidate
    T-->>K: tool result
    K->>W: transition + add evidence
    W-->>K: workflow snapshot
    K->>S: append tool_result + workflow_snapshot
    K->>R: emit trace/metrics
  else permission deny
    K->>W: mark blocked / denied
    K->>S: append permission_decision + blocked snapshot
  end

  K->>K: check stop / continue / compact

  alt completed with evidence
    K->>S: mark completed
    K-->>UI: completed + evidence
  else blocked
    K->>S: mark blocked
    K-->>UI: blocked + resume point
  else continue
    K->>C: rebuild context
  end
```

## 3. 模块边界

```mermaid
flowchart LR
  Goal[用户目标] --> Kernel[AgentKernel]

  Kernel --> Decision[LLM 决策]
  Kernel --> Session
  Kernel --> Workflow
  Kernel --> Permission
  Kernel --> ToolLife
  Kernel --> Context

  Decision --> NextAction[下一步动作建议]

  subgraph OrderLayer[Kernel 秩序]
    Session[Session<br/>发生了什么]
    Workflow[Workflow<br/>任务到了哪一步]
    Permission[Permission<br/>动作能不能做]
    ToolLife[Tool Lifecycle<br/>怎么执行/失败/重试]
    Context[Context Budget<br/>该给模型看什么]
  end

  NextAction --> Permission
  Permission --> ToolLife
  ToolLife --> Observation[观察外部世界]
  Observation --> Workflow
  Workflow --> Session
  Session --> Context
  Context --> Decision
```

## 4. Phase 2 落地顺序

```mermaid
flowchart TD
  A[2A SessionStore + KernelEvent] --> B[2B AgentKernel Skeleton]
  B --> C[2C ToolExecutionService + ToolUseContext]
  C --> D[2D PermissionEngine + ApprovalQueue]
  D --> E[2E Context Compaction + TokenBudget]
  E --> F[2F WorkflowEngine + Evidence]
  F --> G[2G SkillSystem v1]
  G --> H[2H Task Cockpit UI]
  H --> I[2I Doctor + Eval]

  A -.支撑.-> F
  A -.支撑.-> H
  C -.支撑.-> D
  C -.支撑.-> F
  F -.支撑.-> G
  D -.支撑.-> H
```

## 5. 和当前项目的迁移关系

```mermaid
flowchart TB
  subgraph Current[当前结构]
    OldLoop[runtime/local/agent-loop.ts]
    OldRuntime[agent/agent-runtime.ts]
    OldTools[ToolRegistry + ToolExecutionBoundary]
    OldPolicy[PolicyEngine]
    OldWorkflow[WorkflowState + transitionWorkflowState]
    OldContext[ContextManager + PromptAssembler]
    OldTrace[Trace / Metrics / Safety Report]
    OldWeb[web/server.ts in-memory runs]
    OldOrchestrator[sdk/orchestrator.ts]
  end

  subgraph Target[Phase 2 目标结构]
    NewKernel[kernel/AgentKernel + QueryLoop]
    NewSession[session/SessionStore + transcript]
    NewTools[tools/ToolExecutionService + ToolUseContext]
    NewPermission[permission/PermissionEngine + ApprovalQueue]
    NewWorkflow[workflow/WorkflowEngine + Evidence]
    NewSkills[skills/SkillSystem]
    NewCockpit[web/Task Cockpit]
    NewTrace[Trace remains observability only]
  end

  OldLoop --> NewKernel
  OldRuntime --> NewKernel
  OldTools --> NewTools
  OldPolicy --> NewPermission
  OldWorkflow --> NewWorkflow
  OldContext --> NewKernel
  OldTrace --> NewTrace
  OldWeb --> NewCockpit
  OldOrchestrator --> NewSkills
  OldOrchestrator --> NewWorkflow
```

## 6. 最重要的理解

```mermaid
flowchart LR
  Trace[Trace<br/>审计事实]
  Runtime[Runtime Decision]
  Boundary[不能作为运行状态]

  Session[SessionStore<br/>恢复事实源] --> Runtime
  Workflow[WorkflowStore<br/>任务状态事实源] --> Runtime
  Permission[PermissionStore<br/>权限事实源] --> Runtime
  Observation[ObservationManager<br/>当前页面事实源] --> Runtime

  Trace -.-> Boundary
  Boundary -.-> Runtime
  Runtime --> Trace
```

一句话：

> Phase 2 要先补 Agent 的“中枢神经系统”：Session 让它记得住，Kernel 让它控得住，Permission 让它不乱动，Workflow 让它知道做到哪了，Skill 让它下次别从零开始。
