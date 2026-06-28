# Phase 2 Agent Kernel 清晰阅读版架构图

这份是 `architecture.md` 的清晰拆分版。原图偏完整，适合总览；这份图把信息拆开，适合真正阅读和讨论。

## 1. 一张图先理解主线

```mermaid
flowchart LR
  User[用户] --> Surface[产品入口<br/>Web UI / CLI / SDK]
  Surface --> Kernel[Agent Kernel<br/>控制整个任务]

  Kernel --> Context[Context<br/>给模型看什么]
  Kernel --> Model[LLM<br/>判断下一步]
  Kernel --> Permission[Permission<br/>能不能做]
  Kernel --> Tools[Tools<br/>执行动作]
  Kernel --> Workflow[Workflow<br/>做到哪一步]
  Kernel --> Session[Session<br/>记住发生了什么]

  Tools --> World[外部世界<br/>浏览器 / 页面 / 文件 / API]
  World --> Observation[Observation<br/>当前事实]
  Observation --> Context
  Observation --> Workflow

  Session --> Resume[Resume<br/>中断后继续]
  Workflow --> Evidence[Evidence<br/>完成证据]
  Permission --> Human[HumanGate<br/>用户确认]
```

核心理解：

> Kernel 是中枢；LLM 只负责判断下一步；Session、Permission、Workflow、Tool lifecycle 负责让这个判断可控、可恢复、可验证。

## 2. Agent Kernel 内部

```mermaid
flowchart TB
  AgentKernel[AgentKernel<br/>统一入口] --> QueryLoop[QueryLoop<br/>模型轮次和工具轮次]
  AgentKernel --> RunController[RunController<br/>pause / resume / abort / stop]
  AgentKernel --> EventStream[KernelEvent Stream<br/>给 UI / trace / metrics]

  QueryLoop --> TurnState[TurnState<br/>当前轮状态]
  QueryLoop --> TokenBudget[TokenBudget<br/>上下文和工具结果预算]
  QueryLoop --> ModelTurn[Model Turn<br/>调用 LLM]
  QueryLoop --> ToolTurn[Tool Turn<br/>执行工具]
  QueryLoop --> StopCheck[Stop Check<br/>完成 / 阻塞 / 继续]

  TurnState --> SessionSnapshot[Session Snapshot]
  TurnState --> WorkflowSnapshot[Workflow Snapshot]
  TurnState --> PendingTools[Pending Tool Calls]
```

当前项目差距：

- 现在主要靠 `runAgentLoop` 串起来。
- Phase 2 要把它拆成 Kernel、QueryLoop、TurnState、RunController。
- 这样 UI、恢复、中断、权限确认才能稳定接入。

## 3. 状态事实源

```mermaid
flowchart TB
  Runtime[Runtime Decision<br/>运行时决策] --> Trace[Trace<br/>审计输出]

  SessionStore[SessionStore<br/>恢复事实源] --> Runtime
  WorkflowStore[WorkflowStore<br/>任务状态事实源] --> Runtime
  PermissionStore[PermissionStore<br/>权限事实源] --> Runtime
  ObservationManager[ObservationManager<br/>当前页面事实源] --> Runtime
  MemoryStore[MemoryStore<br/>长期偏好和经验] --> Runtime

  Trace -.不能驱动运行时.-> Runtime

  SessionStore --> Transcript[transcript.jsonl]
  WorkflowStore --> Evidence[workflow evidence]
  PermissionStore --> ApprovalHistory[approval history]
```

最重要的边界：

- Trace 是旁路审计，不是数据库。
- SessionStore / WorkflowStore 才是恢复和继续运行的事实源。
- 这条边界守不住，后面一定会越做越乱。

## 4. Permission / Workflow / Tool 的关系

```mermaid
flowchart LR
  ToolCall[模型提出 Tool Call] --> Policy[PolicyEngine<br/>判断风险]
  Policy --> Permission[PermissionEngine<br/>allow / ask / deny]

  Permission -->|allow| Execute[ToolExecutionService<br/>执行工具]
  Permission -->|ask| Approval[ApprovalQueue<br/>等待用户确认]
  Permission -->|deny| Blocked[Workflow Blocked]

  Approval --> Human[HumanGate / UI]
  Human -->|approve| Execute
  Human -->|reject| Blocked

  Execute --> Result[Tool Result]
  Result --> Evidence[Evidence Candidate]
  Evidence --> Workflow[WorkflowEngine<br/>更新任务阶段]
  Workflow --> Session[SessionStore<br/>写入事实]
```

这里的分工：

- PolicyEngine：风险判断。
- PermissionEngine：执行许可。
- HumanGate：把确认权交给人。
- ToolExecutionService：只负责工具生命周期。
- WorkflowEngine：判断任务阶段和完成证据。

## 5. Web Buddy 作为第一个垂直执行域

```mermaid
flowchart TB
  Kernel[Agent Kernel] --> ToolExecution[ToolExecutionService]
  ToolExecution --> WebTools[Web Browser Tools]

  WebTools --> Open[open]
  WebTools --> Click[click]
  WebTools --> Fill[fill]
  WebTools --> Upload[upload]
  WebTools --> Snapshot[snapshot]
  WebTools --> Screenshot[screenshot]

  WebTools --> BrowserSupervisor[BrowserSupervisor<br/>弹窗 / 新标签 / stale ref / 超时]
  WebTools --> Observation[ObservationManager]

  Observation --> PageState[PageState]
  Observation --> FormState[FormState]
  Observation --> PageType[PageType]

  PageState --> Context[ContextManager]
  FormState --> Context
  PageType --> SkillRecommend[Skill Recommender]

  SkillRecommend --> JobSkill[job-application skill]
  SkillRecommend --> AlibabaSkill[alibaba-careers skill]
  SkillRecommend --> ResearchSkill[web-research skill]
```

关键点：

- Web Buddy 不再是整个系统本身。
- Web Buddy 是 Agent Kernel 下面的第一个垂直工具域。
- 后面接文件、API、数据库、消息系统时，不应该重写 Agent 底座。

## 6. SkillSystem 怎么接入

```mermaid
flowchart LR
  Goal[用户目标] --> Recommender[SkillRecommender]
  Domain[当前域名] --> Recommender
  PageType[页面类型] --> Recommender
  WorkflowPhase[Workflow Phase] --> Recommender

  Recommender --> SkillList[skills_list<br/>只列元信息]
  SkillList --> SkillView[skill_view<br/>按需读取详情]

  SkillView --> PromptContext[注入 Prompt Context]
  SkillView --> WorkflowDef[贡献 WorkflowDefinition]
  SkillView --> Recovery[贡献失败恢复策略]
  SkillView --> EvidenceRule[贡献证据规则]

  PromptContext --> Kernel[AgentKernel]
  WorkflowDef --> WorkflowEngine[WorkflowEngine]
  Recovery --> WorkflowEngine
  EvidenceRule --> WorkflowEngine
```

第一批技能：

- `job-application`: 通用招聘投递流程。
- `alibaba-careers`: 阿里招聘站点特例。
- `web-research`: 网页研究和证据收集。

## 7. Task Cockpit 应该展示什么

```mermaid
flowchart TB
  EventStream[KernelEvent Stream] --> Cockpit[Task Cockpit UI]
  SessionStore[SessionStore] --> Cockpit
  WorkflowStore[WorkflowStore] --> Cockpit
  PermissionQueue[ApprovalQueue] --> Cockpit

  Cockpit --> CurrentGoal[当前目标]
  Cockpit --> CurrentPhase[当前阶段]
  Cockpit --> RunningTool[正在执行的工具]
  Cockpit --> PendingApproval[待确认事项]
  Cockpit --> Evidence[完成证据]
  Cockpit --> Blockers[阻塞原因]
  Cockpit --> RecentSessions[最近会话]
  Cockpit --> Actions[resume / stop / approve / reject]
```

体验目标：

- 用户知道 Agent 正在做什么。
- 用户知道为什么停了。
- 用户知道是否真的完成。
- 用户能刷新页面后继续。

## 8. Phase 2 落地顺序

```mermaid
flowchart TD
  A[2A SessionStore + KernelEvent<br/>先让系统记得住] --> B[2B AgentKernel Skeleton<br/>再让系统控得住]
  B --> C[2C ToolExecutionService<br/>工具生命周期统一]
  C --> D[2D PermissionEngine<br/>高风险动作可确认]
  D --> E[2E Context Compaction<br/>长任务不失忆]
  E --> F[2F WorkflowEngine + Evidence<br/>完成必须有证据]
  F --> G[2G SkillSystem v1<br/>经验可复用]
  G --> H[2H Task Cockpit<br/>状态对用户可见]
  H --> I[2I Doctor + Eval<br/>环境和回归可诊断]
```

一句话：

> 先做 Session 和 Kernel，再做 Tool 和 Permission，然后做 Workflow 和 Skill，最后把状态通过 Cockpit 展示给用户。
