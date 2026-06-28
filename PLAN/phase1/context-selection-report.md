# 复杂 Agent 信息筛选报告

日期：2026-06-25

范围：

- 问题：真实环境很复杂，信息筛选没有一劳永逸的办法。面对复杂场景时，怎样设计筛选机制，才能保障大多数情况都适用？
- 参考项目：
  - `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial`
  - `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow`
  - `/Users/sunqiankai/LLM-study/Agent/projects/nanobot`
  - `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli`
  - 当前项目 `packages/web-buddy` 的 Observation Model / ContextManager / Prompt Sections

## 1. 总结

复杂环境下，不存在一个“永远正确”的信息筛选器。

实际可行的办法，是建立一套分层的信息筛选管线：

1. 把原始环境状态转换成结构化状态。
2. 按信息生命周期和用途拆分状态。
3. 对每个 prompt section 设置明确预算。
4. 保留最近动作的因果链。
5. 对大体量、低频信息做延迟加载。
6. 保留模型 API / 工具调用协议依赖的不变量。
7. 让筛选行为可观测、可测试、可回放。

第一性原理是：

> Agent 的瓶颈不只是模型智力，而是注意力带宽、状态新鲜度、观察噪声和动作不可逆性。

所以真正的问题不是“怎么把更多东西塞进 prompt”，而是：

> 怎么维护一个正确、紧凑、足够支持下一步决策的 working set。

对当前 `web-buddy` 来说，已经走在正确方向上：

- `PageState` / `FormState` 把浏览器页面状态转换成结构化观察。
- `ContextManager` 读取 `ObservationProvider` 的内存态，不读取 trace artifacts。
- Prompt Sections 把任务、页面、表单、最近动作、安全规则拆开。
- `recentActions` 保留最近因果链。
- trace 继续作为 Web UI / benchmark / debug / replay 的旁路输出，不是主流程状态源。

下一步的质量提升重点，不是“prompt 更长”，而是“上下文筛选可度量”：

- 每个 section 的预算。
- PageState / FormState 的新鲜度和置信度。
- 上下文构造指标。
- 更复杂的本地 benchmark 页面。
- 页面变化和高风险动作前后的 refresh 触发规则。

## 2. 成熟 Agent 项目实际怎么做

### 2.1 Claude 类 runtime：先计量，再报警，再压缩，同时保护协议不变量

参考文件：

- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/utils/analyzeContext.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/utils/contextSuggestions.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/services/compact/sessionMemoryCompact.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/services/SessionMemory/sessionMemory.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/memdir/findRelevantMemories.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/claude-initial/src/utils/toolSearch.ts`

观察到的模式：

Claude 类 runtime 不只是“把旧消息总结一下”。它先分析 token 到底花在哪里：

- system prompt sections
- tool definitions
- tool calls
- tool results
- memory files
- attachments
- user messages
- assistant messages

然后在上下文风险变高时给出建议。

3 个例子：

1. 大型 tool output 会被按 raw context window 的占比检测。不同工具给不同建议：shell 输出用 `head` / `tail` / `grep` 缩小范围；文件读取用 offset / limit；网页抓取要抽取具体信息。
2. memory files 会按 token 体量排序。系统提示用户审查和清理过期 memory，而不是永久无脑注入所有 memory。
3. context 接近容量上限时，runtime 会提醒 compact 即将发生，让用户有机会主动控制保留内容。

它的 compact 逻辑还会保护因果和 API 协议不变量。

3 个例子：

1. 压缩时会向前扩展保留范围，避免切断 `tool_use` 和 `tool_result` 配对。
2. 流式输出里，同一个 assistant message id 可能分成 thinking / tool_use 多条存储记录。压缩时会把相关记录一起保留，避免丢 thinking block 或工具调用块。
3. compact 后不是只保留最后 N 条消息，而是同时满足最低 token 量和最低文本消息数量。

memory recall 也很保守。

3 个例子：

1. 先扫描 memory header，而不是直接读取所有 memory 全文。
2. 让 selector model 从 manifest 里选出“明确有用”的 memory，最多选 5 个。
3. 已经在前几轮 surfaced 的 memory 会被过滤掉，避免重复占用小预算。

工程经验：

> 好的信息筛选从 accounting 开始。如果解释不清 prompt 被什么消耗了，就很难可靠优化筛选。

### 2.2 Deer-flow：middleware 边界、工具延迟暴露、输出外置化

参考文件：

- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/agents/middlewares/tool_output_budget_middleware.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/agents/middlewares/deferred_tool_filter_middleware.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/tools/builtins/tool_search.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/deer-flow/backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`

观察到的模式：

Deer-flow 把上下文筛选放在 middleware 里处理，而不是写成一次性的 prompt 拼接。

3 个例子：

1. 动态上下文通过隐藏的 `system-reminder` 注入，静态 system prompt 保持稳定，以提高 prefix cache 命中率。
2. 动态上下文注入有超时保护。如果 memory/date 注入卡住，系统跳过注入，而不是拖垮请求。
3. summarization middleware 会保留 dynamic-context reminder，避免旧消息被总结掉以后，后续 middleware 把 memory/date 注入到错误位置。

工具输出会在污染历史之前被预算控制。

3 个例子：

1. 超大的 tool output 会写入磁盘，prompt 里只放预览和可读取路径。
2. 如果持久化失败，则回退为 head/tail 截断，保证 prompt 不会被单个 tool result 撑爆。
3. 历史 ToolMessage 在 model call 前也会被扫描，防止旧的大输出重新进入上下文。

工具 schema 也做了延迟暴露。

3 个例子：

1. MCP 工具默认只按名称出现在可用列表里，不把完整 schema 全部绑定进模型上下文。
2. 模型必须先调用 `tool_search` promote 某个工具，才能看到完整 schema 并调用。
3. promote 状态按 catalog hash 绑定，避免旧的 persisted 状态暴露已经重命名或漂移的工具。

工程经验：

> 复杂系统要可控，就要把大信息面放到显式 promote / load 路径后面。

### 2.3 Nanobot：轻量但实用的 ContextBuilder

参考文件：

- `/Users/sunqiankai/LLM-study/Agent/projects/nanobot/nanobot/agent/context.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/nanobot/nanobot/session/manager.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/nanobot/nanobot/agent/autocompact.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/nanobot/nanobot/agent/memory.py`
- `/Users/sunqiankai/LLM-study/Agent/projects/nanobot/nanobot/templates/agent/consolidator_archive.md`

观察到的模式：

Nanobot 的路线更轻量：

- 固定 system prompt 模块。
- bootstrap files。
- long-term memory。
- always-on skills。
- skill summaries。
- recent history。
- archived context summary。
- 当前轮 runtime metadata。

3 个例子：

1. recent history 同时按消息数量和字符数做上限。
2. session history 会从合法 user/tool 边界开始，避免 orphan tool result。
3. runtime context 被标记为 metadata，不是 instructions，降低 channel/time 元数据带来的 prompt injection 风险。

Nanobot 的 session manager 也保护 live history 的形状。

3 个例子：

1. `get_history` 从尾部切片后，会重新对齐到一个可见 user turn。
2. 切片后如果前面出现 orphan tool result，会删除到合法边界。
3. 只给 user turn 加时间戳，避免 assistant 在后续回复里模仿输出内部时间戳元数据。

它的 consolidation 也有明确 token 估算和 fallback。

3 个例子：

1. 优先使用 provider counter 估算 prompt token，失败后用 tiktoken fallback。
2. consolidation boundary 选在 user turn 上，而不是任意消息中间。
3. LLM summarizer 失败时，会 raw-archive 被移除的消息，保留审计 breadcrumb。

工程经验：

> 一个小而明确的 ContextBuilder，通常比过早上复杂 memory 系统更稳。关键是 cap、align、archive。

### 2.4 Gemini CLI：workspace-gated 注入和 summarizer fallback

参考文件：

- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/cli/src/services/prompt-processors/atFileProcessor.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/core/src/utils/pathReader.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/core/src/utils/memoryDiscovery.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/core/src/utils/memoryImportProcessor.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/core/src/utils/filesearch/fileSearch.ts`
- `/Users/sunqiankai/LLM-study/Agent/projects/gemini-cli/packages/core/src/utils/summarizer.ts`

观察到的模式：

Gemini CLI 把文件和上下文注入限制在 workspace 边界和 ignore 规则内。

3 个例子：

1. `@file` 注入只读取 workspace 内部路径。
2. directory injection 展开文件后，还会经过 gitignore / geminiignore 过滤。
3. 注入失败时保留 placeholder，并在 UI 显示错误，不让 prompt pipeline 崩掉。

memory file 和 import 也有边界控制。

3 个例子：

1. memory discovery 按 file identity 去重，而不只是按路径字符串去重。这对大小写不敏感文件系统很重要。
2. import processing 有最大深度和循环 import 防护。
3. 解析 `@path` import 时会跳过 code block，避免示例代码里的路径误触发 import。

tool output summarization 是 best-effort。

3 个例子：

1. 输出足够小时原样返回。
2. 输出过大时，用 utility model 总结，并要求保留 error / warning。
3. summarization 失败时，回退返回原始输出。

工程经验：

> 上下文扩展必须有权限边界、体量边界和可降级路径。增强失败不能阻断主流程。

### 2.5 当前 web-buddy 状态

参考文件：

- `packages/web-buddy/src/observation/page-state.ts`
- `packages/web-buddy/src/observation/form-state.ts`
- `packages/web-buddy/src/observation/observation-manager.ts`
- `packages/web-buddy/src/context/types.ts`
- `packages/web-buddy/src/context/context-manager.ts`
- `packages/web-buddy/src/context/prompt-sections.ts`
- `packages/web-buddy/src/runtime/local/agent-loop.ts`
- `packages/web-buddy/scripts/context-manager-test.mjs`
- `packages/web-buddy/scripts/prompt-sections-test.mjs`

当前架构：

- 浏览器观察被归一化为 `PageState` / `FormState`。
- `ContextManager` 读取 `ObservationProvider.getPageState/getFormState`。
- `ContextManager` 不读取 `output/traces/...` artifacts。
- Prompt Sections 拆成 system role、safety rules、task、resume summary、current page state、current form state、recent actions、next-action rules。
- agent loop 在 page-changing action 后刷新 browser snapshot。
- 最近动作以结构化记录保留。

3 个例子：

1. `ContextManager` 可以在测试里使用 mock `ObservationProvider`，证明它不绑定 trace 文件。
2. `prompt-sections-test` 验证 `FormState.filledFields`、`missingRequired`、`submitCandidates` 会进入 prompt。
3. `agent-loop` 在工具执行后追加 `UPDATED_CONTEXT`，让模型看到刷新后的 sectioned context，而不只是 raw tool output。

工程判断：

这是正确的早期架构。它还不是完整的信息检索系统，但控制点是对的：

- 结构化状态。
- section-level rendering。
- bounded recent actions。
- 可测试的 provider abstraction。
- trace / runtime 解耦。

## 3. Agent 信息筛选的第一性原理

### 原理 1：注意力是稀缺运行时资源

模型在复杂环境里失败，常见原因不是“不会推理”，而是相关信息缺失、过期、被噪声淹没，或者和其他信息冲突。

因此，信息筛选不是单纯压缩，而是注意力分配。

3 个例子：

1. 一个网页可能有 200 个链接，但填表任务主要需要 required fields、visible errors、submit candidates、upload hints。
2. 一个代码任务可能有几千个文件，但下一步通常只需要当前失败测试、被修改文件、附近调用点。
3. 一个 tool catalog 可能有几百个工具，但模型当前只需要和阶段相关的工具，以及发现更多工具的路径。

对 `web-buddy` 的含义：

不要默认喂完整 DOM 或超长 snapshot。默认喂 PageState / FormState summary；需要 refs 或细节时，再让模型调用 `browser_snapshot`、`browser_form_snapshot`、screenshot 或具体动作工具。

### 原理 2：状态有不同半衰期

不同信息过期速度不同。好的 Agent 不会把所有状态都塞进一条 messages 列表。

建议分层：

1. 即时观察：当前 URL、page type、visible fields、errors、refs。
2. 最近因果状态：最近 actions、失败、gate、页面变化。
3. 任务状态：目标、阶段、blockers、完成条件。
4. 用户/任务 profile：resume summary、偏好、安全默认值。
5. 长期 memory：避免重复工作的 durable facts。
6. trace/artifacts：run 后证据，不是 runtime truth。

3 个例子：

1. 页面 ref 是短生命周期信息。点击或导航后就可能 stale。
2. 简历手机号在一次 run 内通常稳定。
3. benchmark artifact 对 run 后验证有用，但不应该驱动下一次模型调用。

对 `web-buddy` 的含义：

PageState / FormState 应该有 freshness metadata，也可以带 source snapshot id。ContextManager 应优先使用内存态，并在状态过期时给出 refresh cue。

### 原理 3：筛选必须分阶段

一次性 relevance selection 很脆。成熟系统通常分阶段：

1. Source boundary：允许考虑哪些信息？
2. Index / manifest：有哪些候选？
3. Relevance filter：哪些可能相关？
4. Budget allocator：哪些放得下？
5. Renderer：以什么形式展示给模型？
6. Refresh / verify：这些信息现在还是真的吗？

3 个例子：

1. memory recall 先扫描文件 header，再用 selector model，再读取被选中的 memory。
2. deferred tool search 先展示工具名，再在需要时 promote 完整 schema。
3. Web form 先构建 FormState，再只把 filled / missing / submit-relevant fields 放进 prompt。

对 `web-buddy` 的含义：

在进入长期 memory 或 workflow engine 前，先加一个轻量的 `ContextBudget` / `ContextSelector` 层。

### 原理 4：压缩 token 之前，先保护因果不变量

有些信息不能单独裁剪，否则执行链会坏。

3 个例子：

1. tool result 没有对应 tool call，对很多模型 API 来说是非法历史。
2. browser click ref 如果没有产生它的 snapshot 背景，可能是 stale 或无意义的。
3. human gate denial 必须继续可见，否则模型可能重复尝试被拒绝的 final submit。

对 `web-buddy` 的含义：

recent actions 需要保留 tool name、arguments summary、risk、status、observation、time。高风险 blocked actions 应该比普通成功观察保留得更久。

### 原理 5：结构化状态优于原始文本

原始文本熵高。结构化状态给模型更小、更稳定的决策面。

3 个例子：

1. `FormState.missingRequired` 比长 DOM 文本更有用。
2. `PageState.pageType=form` 比让模型从 5000 字页面文本里推断页面类型更稳。
3. 带 risk label 的 `submitCandidates` 比散落在 snapshot 里的按钮文字更可靠。

对 `web-buddy` 的含义：

继续增强 PageState / FormState，比过早引入宽泛 memory 更重要。对浏览器 Agent 来说，观察质量通常比对话 memory 更关键。

### 原理 6：trace 是证据，不是 working memory

trace、metrics、artifacts、reports 用于 audit、UI、replay、benchmark、debug。

它们不应该成为主流程 runtime 状态源。

3 个例子：

1. ContextManager 应读取 ObservationProvider memory，不读 `page-state-latest.json`。
2. Benchmark 可以读 artifacts 断言最终状态，因为 benchmark 在 agent control loop 外部。
3. Web UI 可以读 artifacts 做展示，因为 UI 是旁路输出消费者。

对 `web-buddy` 的含义：

保持这个硬边界。继续用 poisoned artifact 测试证明 ContextManager 忽略 trace artifacts。

### 原理 7：筛选失败必须软降级

复杂筛选会涉及 IO、tokenizer、side model、filesystem、browser state，有时还有网络。这些都可能失败。

主流程应该退化成更简单上下文，而不是崩掉。

3 个例子：

1. tool output 外置化失败，就退回 head/tail truncation。
2. session memory extraction 失败，不应该阻断主对话。
3. observation artifact 写失败，不应该影响浏览器动作。

对 `web-buddy` 的含义：

每条增强路径都要有 fallback：

- 没有 PageState，就用 pageView fallback。
- 没有 FormState，就提示需要 `browser_form_snapshot`。
- trace 写失败，忽略。
- budget estimator 失败，退回 char budget。

## 4. 面向复杂场景的实用筛选栈

### Layer 1：硬 source boundary

先决定 Agent 允许考虑什么，再谈 ranking。

对浏览器 Agent 来说，允许考虑：

- 当前 browser session。
- 当前 task goal。
- resume / profile。
- allowed tools。
- safety policy。
- recent actions。
- 用户明确提供的文件。

不应纳入：

- 任意 trace artifacts 作为 runtime state。
- 无关真实网站 adapter。
- hidden benchmark reports。
- 已经过期的 page snapshot。

3 个例子：

1. 填表 Agent 不应该用上一次 benchmark 的 FormState 当作当前页面状态。
2. 求职申请任务不应该从无关 memory 里猜用户隐私信息，除非用户明确允许。
3. 一个不在 catalog 里的工具，不应该因为旧 trace 提到过，就出现在 prompt 里。

### Layer 2：Observation normalization

把原始环境转成任务形状的状态。

对 `web-buddy`：

- `PageState` 用于页面级决策。
- `FormState` 用于表单级决策。
- `RecentActions` 用于因果决策。
- 后续 `TaskState` 用于阶段和完成判断。

3 个例子：

1. 原始 DOM 说页面里有很多 input；FormState 说哪些 required、哪些 missing。
2. 原始页面文字说有 Submit；submitCandidates 说这是一个 high-risk final submit candidate。
3. 原始 snapshot 里有 file input；uploadHints 说 accept 类型和可见 label。

### Layer 3：Relevance scoring

不要依赖单个“聪明规则”，而是组合多个弱信号。

可用信号：

- task keyword match
- pageType
- field requiredness
- visibility
- filled / missing / invalid state
- submit/action risk
- recency
- previous failure
- user correction
- label mapping confidence

3 个例子：

1. 必填且为空的 email 字段，比可选且已填的 portfolio 字段优先级更高。
2. 某字段附近的 visible error，比页面 footer 文本更重要。
3. 被 final-submit gate 拦截的动作，比成功的 `browser_wait` 更重要。

### Layer 4：Budget allocation

按 section 分配预算，不做全局粗暴截断。

浏览器填表任务的默认优先级：

1. Safety rules and blockers。
2. Task and completion criteria。
3. Current FormState missing / filled / errors / submit。
4. Current PageState summary。
5. Recent failed / high-risk actions。
6. Resume summary。
7. Low-risk recent successful actions。

3 个例子：

1. budget 紧张时，应先删旧的成功 `browser_wait`，而不是删 missing required fields。
2. final-submit gate denial 必须保留，即使旧页面文本被删掉。
3. 字段 label 和 value 应比 verbose textSummary 更优先。

### Layer 5：Compression and externalization

内容过大时，要根据类型选择不同压缩方式：

- 表单用结构化抽取。
- log 用 head/tail preview。
- 旧对话用 summary。
- memory / files / tools / skills 用 manifest / index。
- 完整输出保存到外部文件，只在 prompt 里放路径和预览。

3 个例子：

1. 超长 select dropdown 不应该完整塞进 prompt。可以放 selected option 和 top relevant options，完整 options 留给 artifact/debug。
2. 超长页面默认放 title、pageType、counts、textSummary、key actions。需要 exact refs 时再 snapshot。
3. 超大 tool result 保存完整文件，prompt 里只放 preview 和 retrieval path。

### Layer 6：Lazy expansion

默认 prompt 只放足够选择下一步动作的信息，不放所有可能细节。

3 个例子：

1. 先显示 deferred tool names；需要时通过 tool search 加载完整 schema。
2. 先显示 memory manifest；只读取被选中的 memories。
3. 先显示 PageState / FormState summary；refs 或字段细节不清楚时再调用 snapshot / form_snapshot。

### Layer 7：Freshness checks

过期信息往往比缺失信息更危险。

浏览器 Agent 的 refresh 触发点：

- page-changing action 之后。
- typing / filling / selecting 后，如果最终 form state 很关键。
- 高风险 click / submit 前。
- URL / title 变化时。
- locator / ref 失败时。
- run finalize 前。

3 个例子：

1. deterministic fill 后，在 final screenshot/report 前刷新 FormState。
2. 点击导航按钮后，先刷新 PageState，再决定下一步。
3. submit 或 block final submit 前，刷新 FormState，确认字段是否完成。

### Layer 8：Observability and tests

筛选逻辑要像 routing logic 一样测试，不能只相信 prompt 文案。

建议 metrics：

- per-section char/token size
- PageState age
- FormState age
- unknown pageType count
- missingRequired count
- filledFields count
- stale ref retries
- tool category counts
- context rebuild count
- context truncation count

建议测试：

1. Poisoned trace artifact test：ContextManager 忽略 artifact 文件。
2. Stale FormState test：填表后最终 FormState 反映字段值。
3. Oversized context test：section budget 优先截断低优先级 section。
4. Legal boundary test：recent actions 保留 blocked / gated actions。
5. Complex form test：options / uploadHints / visibleErrors 进入 prompt。

## 5. 怎么保障“大多数情况都适用”

不能绝对保障，但可以把工程目标设成：

> 让常见路径足够稳，让失败可见，让恢复成本足够低。

具体做法如下。

### 5.1 使用冗余信号

不要只靠一个信号，比如 keyword match。

浏览器填表任务可以组合：

- visible label
- placeholder
- input name/id
- nearby text
- required flag
- type
- current value
- validation error
- pageType

3 个例子：

1. Email 字段可以通过 label `Email`、input type `email`、name `email`、placeholder `you@example.com` 多种方式识别。
2. Resume upload 可以通过 file input type、accept `.pdf`、可见文字 `Upload resume`、uploadHints 识别。
3. Submit action 可以通过 button type、text、role、risk label、是否在 form 内综合判断。

### 5.2 使用保守默认值

不确定时，优先观察，不优先行动。

3 个例子：

1. 字段 label 不明确时，调用 `browser_form_snapshot`，不要猜。
2. refs 可能 stale 时，点击前调用 `browser_snapshot`。
3. 可能是 final submit 时，阻断或请求人工确认，不直接点击。

### 5.3 保留短因果记忆

模型需要知道刚刚发生了什么。

3 个例子：

1. “Typed name into Name field” 可以避免重复输入。
2. “Click was blocked by final-submit gate” 可以避免 retry loop。
3. “Snapshot refreshed after navigation” 可以告诉模型 refs 是当前的。

### 5.4 区分“决策所需”和“审计所需”

runtime context 只需要下一步决策的前置条件。

audit context 可以更大，放在旁路。

3 个例子：

1. Runtime 用 PageState/FormState；UI 读完整 trace artifact。
2. Runtime 看大输出 preview；完整输出保存成文件，需要时再读。
3. Runtime 看 memory summary；详细 memory 文件按需加载。

### 5.5 建立反馈回路

筛选质量只有在 miss 可度量时才会变好。

3 个例子：

1. 如果模型频繁调用 `browser_snapshot`，说明当前 PageState 可能信息不足。
2. 如果填表后 `missingRequired` 仍不为 0，说明字段映射不完整。
3. 如果 benchmark 因 FormState stale 失败，就增加 final observation refresh。

## 6. 对 web-buddy 的下一步建议

本节严格限定在 ContextManager / Prompt Sections 范围内，不要求 AgentRuntime 大重构。

### Step 1：增加 Context Selection Metrics

新增安全默认 metrics：

- `contextBuilds`
- `contextChars`
- `contextTruncations`
- `pageStateAgeMs`
- `formStateAgeMs`
- `recentActionsIncluded`
- `promptSectionChars` by section id

为什么：

没有这些指标，只能知道 run 失败了，无法判断模型是因为状态缺失、状态过期，还是因为内容被截断而失败。

### Step 2：增加 Freshness Metadata

可以先扩展 internal context snapshot，不一定立刻改 artifact schema：

- `pageStateUpdatedAt`
- `formStateUpdatedAt`
- `sourceSnapshotId`，如果可用。
- `stale` boolean 或 `ageMs`。

为什么：

模型需要知道 FormState 是否当前。runtime 也需要知道什么时候在高风险动作前刷新。

### Step 3：强化 Section Priority 和 Budget Tests

当前 `prompt-sections.ts` 已经有 per-section truncation 和 shrink order。建议补充 priority 测试：

- blockers 在 tight budget 下仍保留。
- missingRequired 应比 textSummary 更优先保留。
- recent blocked/high-risk actions 应比 low-risk waits 更优先保留。

为什么：

这会把 context selection 从“字符串缩短”升级成明确的产品决策。

### Step 4：增加复杂本地 benchmark 页面

不要新增真实网站适配。只加本地静态页面：

- 长表单，包含 optional / required fields。
- select 含很多 options。
- upload hints。
- validation errors。
- 多步骤 form。
- confirmation page。
- captcha-like blocker。

为什么：

大多数真实失败，在复杂本地结构里就能复现，不需要一开始上真实网站。

### Step 5：增加最小 TaskState

先不要做 workflow engine。

建议字段：

- `schemaVersion`
- `goal`
- `phase`: observing | filling | reviewing | blocked | done
- `knownBlockers`
- `completionCriteria`
- `updatedAt`

为什么：

PageState 说明“页面是什么”；FormState 说明“表单是什么”；TaskState 说明“Agent 正处在任务的哪个阶段”。

### Step 6：继续保持 Trace 解耦

保持这个不变量：

```text
ContextManager -> ObservationProvider memory
Benchmark/UI/debug -> trace artifacts
```

不要引入：

```text
ContextManager -> read output/traces/.../page-state-latest.json
```

为什么：

trace 是证据镜像。如果 runtime 把 trace 当 truth 读，debug 输出就会反向进入控制流，产生 stale-state bug。

## 7. 实用经验规则

做真实 Agent 信息筛选时，可以用这组规则：

1. 影响下一步动作的信息，尽量保留精确状态。
2. 总结旧对话，不要总结当前关键 affordances。
3. 安全 blockers 的优先级高于普通观察。
4. 不要切断 tool-call / tool-result 配对。
5. 页面和表单优先用结构化状态，不要依赖 raw DOM text。
6. memory、files、tools、skills 默认用 manifest，不默认用 full body。
7. page-changing action 后 refresh。
8. high-risk action 前 refresh。
9. trace 是 audit output，不是 runtime memory。
10. 明确度量 context selection。

3 个 failure / fix 例子：

1. 失败：模型 navigation 后点击旧 ref。
   修复：把 refs 绑定到 snapshot；pageChanged 后刷新 snapshot。
2. 失败：benchmark 已提交，但最终 FormState 为空。
   修复：final screenshot/report 前做 final observation refresh。
3. 失败：tool output 占满 prompt。
   修复：externalize 或 summarize 大输出，只放 preview 和 retrieval path。

## 8. 最终结论

可靠的信息筛选不是一个更聪明的 prompt，而是一条信息管线：

```text
Raw world
  -> structured observation
  -> source boundary
  -> relevance scoring
  -> section budget
  -> causal invariant preservation
  -> prompt rendering
  -> refresh / verify
  -> trace as side-effect evidence
```

对 `web-buddy` 来说，最稳的下一步是继续沿着当前 ContextManager / ObservationProvider 设计推进：

- 增加 context metrics。
- 增加 freshness。
- 强化 section priority。
- 增加复杂本地 benchmark。
- 然后引入最小 TaskState。

不要直接跳到 Skill、Memory、多 Agent 或完整 runtime rewrite。那些东西只有在当前 working set 可度量、稳定之后才有价值。
