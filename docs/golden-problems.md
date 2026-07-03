# 黄金问题集合

这个文档记录项目里最适合复盘、面试和技术讲述的“黄金问题”。每个问题都尽量包含真实场景、为什么难、最终方案、工程取舍和可展示证据。

记录原则：

- 不记录 API key、cookies、storage state、验证码、账号密码或完整简历内容。
- 优先记录真实用户体验中暴露的问题，而不是只记录代码 bug。
- 每个问题都要能讲清楚“我为什么这么设计”，而不是只说“修了一个 if”。
- 如果问题还没完全解决，也要记录当前方案和下一步，这反而能体现工程判断。

## GP-001：自主 Web Agent 的高风险动作应该如何“问完继续”，而不是问完就结束？

### 一句话版本

在真实阿里招聘投递流程里，agent 已经能看到页面上的同意框、投递按钮、二次确认弹窗和疑似上传入口，但系统一度把“高风险动作需要确认”实现成“确认后任务结束”。这个问题的核心不是按钮没点对，而是自主 agent、动作意图、安全策略、可恢复人类确认和任务生命周期之间的职责边界设计。

### 真实场景

用户希望体验一次完整的真实投递流程：

- agent 根据简历抓取并匹配阿里岗位。
- 进入岗位详情页。
- 勾选“申请此职位表明您已阅读并同意《申请工作需知》”。
- 点击 `投递简历`。
- 处理“本月能申请 5 个职位，请慎重选择”的二次确认弹窗。
- 继续进入后续简历上传/表单填写流程。
- 最终提交前停住，等待用户人工确认。

实际暴露出多层问题：

- `投递简历` 被策略层误判成 `final_submit`，用户同意后任务直接停止。
- 弹窗里的单字 `投递` 被当成最终提交，无法继续进入后续流程。
- 模型看到弹窗后过早 `agent_done(blocked=true)`，没有继续请求用户确认。
- `form_snapshot` 曾把 `投递简历` 按钮当成 `uploadHints`，模型随后尝试用它上传本次简历。
- 真实 E2E 里任务能推进到确认弹窗，但仍会停在“上传入口不真实 / 最终提交不能自动点”的边界上。

### 为什么这是黄金问题

这个问题可以讲出一个真实 Web Agent 项目的核心复杂度：

- 模型不是看不见页面，它能读到 checkbox、按钮和弹窗，但它会保守误判或过早结束。
- 不能把真实招聘投递写成完全硬编码流程，否则失去 agent 的通用性。
- 也不能完全相信模型自主判断，否则会误提交、误上传、误结束。
- 高风险动作必须有人类确认，但确认机制不能破坏任务连续性。
- “最终提交不能自动点”和“所有投递相关按钮都不能点”不是一回事。

### 根因拆解

#### 1. 模型层

模型负责理解页面语义和下一步动作，例如：

- 看到同意框后先勾选。
- 看到 `投递简历` 后判断是进入申请流程。
- 看到弹窗后判断是二次确认。
- 看到上传入口后上传本次简历。

问题是模型会因为安全提示过强而过早 `agent_done(blocked=true)`，或者把非上传按钮当上传入口。

#### 2. ActionIntent / Policy / Permission 层

策略层不应该写死阿里流程，而应该把工具调用、按钮文本、当前 URL、页面状态和 workflow phase 归一成动作意图 `ActionIntent`，再做风险分类：

- `high_risk_action`：进入申请流程、打开投递弹窗等，需要问用户，但同意后可以继续。
- `upload_resume`：上传本地简历，必须问用户，并且只能绑定真实上传入口。
- `final_submit`：真正的 `确认投递 / 提交申请 / 完成投递`，不能自动执行。
- `agent_done`：模型声明完成或阻塞，但必须经过 completion gate 验证。

问题是旧策略把 `投递简历`、弹窗 `投递`、最终 `确认投递` 都混在一个 submit-like 类别里。

#### 3. Runtime 层

运行时负责 gate 生命周期：

- 暂停。
- 问用户。
- 用户同意后执行动作。
- 刷新页面状态。
- 继续下一步。

旧实现的问题是把 `final_submit gate` 和 `done=true` 绑定，导致“用户同意继续”也会结束任务。

### 核心抽象：ActionIntent

`ActionIntent` 的价值是把“这是阿里第几步”换成“这个动作想造成什么现实后果”。这不是完整硬编码流程，而是一层安全语义：

| Intent | 典型页面动作 | 默认处理 |
| --- | --- | --- |
| `apply_entry` / `high_risk_action` | 详情页 `投递简历`、申请前置确认弹窗 `投递` | 询问或按 permission mode 自动放行；执行后刷新页面继续 |
| `upload_resume` | `input[type=file]`、上传/重新上传/附件简历/选择文件入口 | 必须询问；必须绑定真实上传入口 |
| `final_submit` | `确认投递`、`提交申请`、`完成投递` | 不自动执行；把观察返回给 agent 和用户 |
| `agent_done` | 模型声称完成或阻塞 | 交给 completion gate，页面仍有可处理动作时拒绝提前结束 |

这样代码没有写“阿里第 1 步、第 2 步、第 3 步”，但能稳定回答一个更重要的问题：这个动作到底是进入流程、上传敏感文件、最终提交，还是结束声明。

### 解决方案

#### 原则一：流程由模型自主走，代码只做护栏

不要把阿里投递流程完全写成死流程。代码不应该规定“第 1 步点 A、第 2 步点 B、第 3 步点 C”。模型应根据页面快照和表单快照做计划。

但代码必须提供安全护栏：

- 页面仍有可处理弹窗时，不接受模型直接 `agent_done(blocked=true)`。
- 上传工具不能绑定普通投递按钮。
- 最终提交不能被 permission mode 自动放行。
- 进入申请流程的按钮可以被 gate 后执行，不等同于最终提交。

#### 原则二：Gate 是可恢复暂停，不是任务终止

正确语义：

```text
高风险动作 -> 询问用户 -> 用户同意 -> 执行动作 -> 刷新观察 -> 继续
```

错误语义：

```text
高风险动作 -> 询问用户 -> 用户同意/拒绝 -> 任务结束
```

因此要把 `HumanGate`、`PermissionEngine`、`CompletionGate` 的职责拆开：

- `HumanGate`：只负责问用户。
- `PermissionEngine`：只决定 allow / ask / deny。
- `CompletionGate`：只判断任务是否真的能结束。
- `runAgentLoop`：不应因为一次 gate 就擅自结束任务。

#### 原则三：Final submit 不自动执行，但也不直接杀死任务

对于真正最终提交：

- 不自动点击。
- 返回 `FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY` 观察给模型和用户。
- 允许用户手动完成后继续观察。
- 如果没有安全后续动作，模型再 `agent_done`。

这样既守住安全边界，也不会让用户感觉“系统随便退出”。

#### 原则四：上传简历必须有真实上传入口证据

`browser_upload_file` 只能在这些情况下调用：

- 有 `input[type=file]`。
- 有明确上传/重新上传/附件简历/选择文件入口。
- `form_snapshot` 或页面结构能证明它是上传控件。

不能因为页面上有 `投递简历` 就调用上传工具。

#### 原则五：agent_done 也要过 completion gate

`agent_done` 不是“模型说结束就结束”。运行时需要检查当前页面是否仍有可处理的确认弹窗、上传入口、未完成表单、登录/验证码 handoff 或最终提交边界。真实阿里 run 证明，模型会把“二次确认弹窗”过早理解成最终不可继续状态，所以 completion gate 必须能拒绝 premature done，并把可恢复观察返回给模型。

### 已落地的改动

- 阿里详情页 `投递简历` 和弹窗单字 `投递` 在 `position-detail` 页面优先识别为 `high_risk_action`，不是 `final_submit`。
- `final_submit gate` 不再直接设置 `done=true` 结束 loop，而是返回“最终提交未自动执行”的观察，让 agent 继续安全处理。
- 阿里“本月能申请 N 个职位，请慎重选择”弹窗还开着时，运行时拒绝模型过早 `agent_done(blocked=true)`。
- prompt 中明确阿里详情页同意框属于进入申请流程前置条件，不代表最终提交许可。
- `browser_upload_file` 的本地回归已覆盖“普通 `投递简历` 按钮不是文件上传控件”。
- 问题已同步到 `docs/web-agent-console-issues.md`。

### 还需要继续做

- 修 `form_snapshot` 的上传入口识别：`uploadHints` 不能把 `投递简历` 当上传入口。
- `browser_upload_file` 调用前继续加强真实上传控件校验，尤其是 text/ref 指向普通按钮但不会打开 file chooser 的情况。
- completion gate 需要更多页面证据：表单已填、弹窗已解决、用户手动最终提交、页面显示成功或明确停在安全边界等。
- 把真实流程跑到“上传本次 PDF 简历”并验证不会沿用站内旧简历。

### 验证结果

本地回归验证（2026-07-02）：

- `npm run build` 通过。
- `node ./scripts/policy-engine-test.mjs` 通过，覆盖阿里详情页 `投递/投递简历` 作为 `high_risk_action`、`确认投递` 作为 `final_submit`。
- `node ./scripts/agent-runtime-workflow-test.mjs` 通过，覆盖 final-submit gate 不直接结束 loop，以及阿里确认弹窗仍打开时拒绝过早 `agent_done`。
- `node ./scripts/direct-submit-flow-test.mjs` 和 `node ./scripts/completion-gate-test.mjs` 通过，覆盖 direct-submit review 和 completion gate。
- `node ./scripts/upload-file-test.mjs` 通过，覆盖普通 `投递简历` 按钮不能被当作上传文件目标。

真实 E2E 证据：

- `output/2026-07-01T13-28-13`：登录 handoff 后没有默认结束，最终识别为 `direct_submit_review`；artifact 显示 `loginWall=false`、`realFillableFieldCount=0`、`agreementCheckboxCount=1`、`submitApplyButtonCount=1`，下一步是 `final_submit` 边界。
- `output/2026-07-01T14-35-11`：暴露弹窗单字 `投递` 被误判成 `final_submit` 后任务停止的问题。
- `output/2026-07-02T02-49-16`：暴露模型在阿里确认弹窗仍打开时直接 `agent_done(blocked=true)`，completion gate 当时没有阻止提前结束。
- `output/2026-07-02T06-19-38`：修复后真实流程中 `投递简历` 已按 `policy.workflow.alibaba_apply_entry` 进入 `high_risk_action` gate，approve 后继续；同一 run 也暴露 `uploadHints` 仍把 `投递简历` 误导为上传入口，任务停在 `upload_resume` 审批/真实上传入口校验之前。

### 面试讲法

可以这样讲：

```text
我做这个项目时遇到一个很典型的真实 Web Agent 问题：模型其实能看懂页面，但系统不能简单相信模型，也不能把流程写死。

在阿里招聘投递里，页面上有“同意申请工作需知”“投递简历”“本月可申请 5 个职位”的弹窗。早期系统把这些按钮都归成 submit-like 动作，结果用户明明同意继续，agent 却直接停止。

我后来把问题抽象成三层：模型负责页面语义和下一步计划；Policy/Permission 负责把工具调用归一成 ActionIntent 并判断是否要问用户；Runtime 负责可恢复的人机 gate。这样高风险动作会先问用户，用户同意后继续执行；真正最终提交仍不会自动点，但也不会让任务无故退出。

这个改动让我意识到 Web Agent 的核心不是“让模型点按钮”，而是设计一个安全、可恢复、可审计的人机协作循环。
```

### 可展示证据

- 问题记录：`docs/web-agent-console-issues.md`
- 安全模型：`docs/safety-model.md`
- 关键测试：
  - `npm run build`
  - `node ./scripts/policy-engine-test.mjs`
  - `node ./scripts/agent-runtime-workflow-test.mjs`
  - `node ./scripts/direct-submit-flow-test.mjs`
  - `node ./scripts/completion-gate-test.mjs`
  - `node ./scripts/upload-file-test.mjs`
- 真实 trace 示例：
  - `output/2026-07-02T02-49-16/trace.jsonl`
  - `output/2026-07-02T06-19-38/trace.jsonl`

## GP-002：投递前如何证明“本次简历已生效、表单已完整、下一步真的是最终投递”？

### 一句话版本

2026-07-03 的真实阿里 E2E 比上一轮明显推进：agent 能抓取岗位、打开真实详情页、登录后勾选申请工作需知、找到真实“重新上传”入口并上传本次 PDF。但它也暴露出更关键的问题：阿里弹窗提示“本月能申请 5 个职位，请慎重选择”时，模型和策略仍把弹窗 `投递` 当作普通申请流程确认，实际点击后直接进入个人中心，极可能已经消耗一次真实投递机会；同时 agent 在上传后自动点击“是，覆盖掉”和“保存”，没有先证明简历详情与后续表单已完整检查。

### 真实场景

本轮真实 E2E 命令：

```text
PLAYWRIGHT_HEADLESS=false PLAYWRIGHT_VISUAL_HIGHLIGHT=true PLAYWRIGHT_KEEP_BROWSER_OPEN=true PLAYWRIGHT_SLOWMO_MS=250 PLAYWRIGHT_TYPE_DELAY_MS=40 HUMAN_GATE_MODE=cli PERMISSION_MODE=safe AGENT_MAX_STEPS=150 node ./dist/cli/demo.js --mode alibaba-apply --resume '/Users/sunqiankai/唐哥简历.pdf' --headful --keep-browser-open --permission-mode safe --max-pages 5 --max-crawl-jobs 100 --max-jobs 10 --match-threshold 0.25 --profile alibaba-action-intent-e2e
```

事实证据：

- trace：`output/2026-07-03T03-57-39/trace.jsonl`
- session transcript：`output/sessions/session_2026-07-03T03-57-39_7e003fea/transcript.jsonl`
- chosen job：`企业智能事业部-高级算法专家-杭州`
- details：`detailsAttempted=10`、`detailsVerified=10`、`detailsFailed=0`
- 登录：进入 `mozi-login.alibaba-inc.com`，人工登录后返回真实 `position-detail`
- 弹窗：识别到 quota dialog，文案包含“本月能申请5个职位，请慎重选择”
- 上传：进入 `personal/social-resume`，通过真实“重新上传”控件上传本次 PDF
- 停止原因：用户拒绝后续重复 `投递简历` gate，最终 stopped

### 新暴露的问题

#### 1. quota 警告弹窗应该升级为 final_submit

本轮最关键的事实是：弹窗 `投递` 被点击后，页面跳转到 `personal/social-application`。模型后续自己也推理出“第一次申请可能已经成功提交，并且使用的是旧简历”。这说明弹窗文案不是普通“进入流程确认”，而是会消耗投递名额的最终投递确认信号。

当前策略的问题：

- `PageFacts` 已经能识别 `hasApplicationQuotaDialog=true` 和 `quotaDialogText`。
- `browser_snapshot` 也把弹窗事实展示给模型。
- 但 `inferActionIntent()` 对阿里详情页弹窗 `投递` 仍优先归为 `application_confirm` 或 `unknown_high_risk`，没有基于 quota dialog 升级为 `final_submit`。
- `actionIntentContextText()` 没有直接把 `quotaDialogText` / `visibleBlockingDialog.kind=quota` 作为强信号传给 policy。

正确目标：

```text
有投递名额/本月可申请次数/请慎重选择等 quota 警告 + 弹窗按钮为 投递/确认/继续
=> final_submit gate
=> runtime 不自动点击
=> 让用户人工决定是否真的消耗投递机会
```

#### 2. 简历更新必须发生在任何最终投递确认之前

本轮流程顺序有问题：先在详情页点击了 quota 弹窗 `投递`，之后才进入个人中心上传本次 PDF。后续模型意识到“可能已经使用旧简历投递”，这正是用户体验上最不能接受的地方。

正确目标：

- 在进入任何可能消耗投递机会的确认弹窗前，workflow 必须知道 `currentResumeUploaded=true`。
- 如果站点已有旧简历，不能默认满足本次任务，除非能证明它就是当前 PDF，或用户明确选择复用。
- 如果尚未上传本次 PDF，点击 quota/final-submit 前必须阻塞，并提示先更新简历。

#### 3. 覆盖简历详情和保存简历属于资料修改，也需要 gate

本轮上传后出现“是否根据您上传附件中的简历，刷新简历详情中的信息？刷新之后，原来的信息将丢失。”agent 直接点击“是，覆盖掉”，随后又直接点击“保存”。

当前策略的问题：

- `SAVE_DRAFT_TEXT` 包含“保存简历/保存草稿”，但不包含单独的“保存”。
- “覆盖掉/刷新之后原来的信息将丢失”没有归类为资料修改或 save-resume gate。

正确目标：

- 覆盖、刷新、丢失原信息、保存当前简历详情，都应进入 `save_resume` 或单独的 `profile_mutation` gate。
- gate 文案要告诉用户：这不是最终投递，但会修改站内简历资料。

#### 4. 表单完整性不能只看首屏，需要主动滚动取证

用户想要的效果不是“上传了就算完成”，而是：

- 上传本次 PDF。
- 等解析完成。
- 自主滚动简历/申请表单。
- 检查所有必填项、错误提示、下拉选择、文本域、附件状态。
- 只有形成“表单完整性证明”后，才允许停在最终提交前。

当前不足：

- `browser_form_snapshot(maxFields=120)` 能抓控件，但不保证已经滚动覆盖所有懒加载区域。
- workflow 只知道 `missingRequiredCount`，还没有 `formCoverage`、`lastScrollAudit`、`currentResumeUploaded` 这类证据。
- prompt 让模型“继续 filling any required fields”，但没有强制“提交前必须滚动审计完整表单”。

### 根因拆解

这次不是单纯“模型笨”或“规则不够多”，而是三层信息没有闭环：

- 观察层已经看到了 quota 弹窗，但 policy 没有消费这个强信号。
- 模型能事后推理“可能已经提交”，但 prompt/workflow 没要求它在事前把 quota 警告当成最终投递风险。
- workflow 没有保存关键业务状态：本次简历是否已上传、是否保存、是否完成全表单滚动审计、当前是否停在最终投递前。

### 解决方向

#### 方向一：让模型判断，但给它结构化证据

继续让模型做页面语义判断，但把关键证据更清楚地喂给它：

- `CURRENT_PAGE_STATE.facts.quotaDialogText`
- `visibleBlockingDialog.kind=quota`
- `submit button inside quota dialog`
- `resumeFreshness: current task resume uploaded / unknown / old site resume`
- `formCoverage: top/middle/bottom observed`

这样不是硬编码阿里流程，而是让模型在高质量证据上判断。

#### 方向二：policy 增加“后果优先”的 final-submit 判定

不要只看按钮文字，也要看弹窗后果语义：

- 名额、次数、慎重选择、投递机会、不可撤销、确认投递等词，优先升级为 `final_submit`。
- 如果当前存在 quota dialog，那么弹窗内的 `投递/确认/继续` 默认是 `final_submit`，不是 `application_confirm`。
- 详情页普通 `投递简历` 可以仍是 `apply_entry`，但弹窗 quota `投递` 不再是。

#### 方向三：引入提交前 workflow proof

建议在 workflow state 里增加轻量证据字段：

- `currentResumeUploaded`
- `resumeSavedOrParsed`
- `profileMutationPending`
- `formScrollAuditStatus`
- `missingRequiredCount`
- `finalSubmitBoundaryReached`

最终提交 gate 前必须满足：

```text
currentResumeUploaded=true
profileMutationPending=false
formScrollAuditStatus=complete
missingRequiredCount=0
finalSubmitBoundaryReached=true
```

如果缺少任何证据，模型应继续观察/滚动/补填，而不是点击或结束。

### 后续解决过程记录

- [ ] 修正 `inferActionIntent()`：quota dialog + 弹窗提交按钮升级为 `final_submit`。
- [ ] 把 `PageFacts.quotaDialogText`、`visibleBlockingDialog` 纳入 `actionIntentContextText()` 或 policy input。
- [ ] 增加测试：阿里 quota 弹窗 `投递` 必须是 `final_submit` gate，且 runtime 不执行点击。
- [ ] 增加测试：普通详情页 `投递简历` 仍是 `apply_entry`，避免回退成“一律不点”。
- [ ] 增加资料修改 gate：`覆盖掉`、`刷新后原信息丢失`、单字 `保存` 在简历页应进入 `save_resume/profile_mutation`。
- [ ] 增加提交前表单滚动审计能力：至少记录 top/middle/bottom snapshot 或 scroll coverage。
- [ ] 增加 workflow proof：本次 PDF 已上传/解析/保存、必填项为 0、无可见错误、停在最终提交前。
- [ ] 再跑真实阿里 E2E，目标是先更新简历和表单完整性，再停在 quota/final-submit gate 前。

### 面试讲法

可以这样讲：

```text
我在真实阿里招聘站点验证时发现一个很有代表性的 Web Agent 问题：按钮文字本身不够判断风险，弹窗文案和点击后果才是核心。

同样叫“投递”，详情页上的按钮可能只是进入流程，但弹窗里提示“本月只能申请 5 个职位，请慎重选择”的“投递”，实际就很像最终提交，会消耗投递机会。早期系统只看按钮文字和 URL，把它归成 application_confirm，结果先消耗了机会，后面才去上传本次简历。

我把这个问题抽象成“提交前证明”：模型仍然负责理解页面和自主滚动检查表单，但 runtime 必须提供结构化证据和后果优先的安全策略。最终提交前不仅要问用户，还要证明本次简历已上传、资料修改已确认、表单已完整检查、没有必填缺失。
```
