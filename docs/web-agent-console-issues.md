# Web Agent Console 问题记录

本文档按日期记录问题；每个日期下再按优先级分组。

状态说明：

- `已解决`：已有代码修复，并有明确测试或真实 run 证据。
- `部分解决`：关键路径已有改善，但原问题的验收条件还没有全部完成。
- `未解决`：还没有对应实现。
- `待验证`：代码里可能已有相关能力，但本文档尚未记录过验证证据。

安全备注：本文档不记录 API key 明文、cookies、storage state 或简历全文；后续 issue / log 也不应粘贴这些内容。

## 2026-06-18 Web Console Alibaba Preset 真实体验

测试上下文：

- Web 控制台：`http://localhost:5179/`
- 测试目标：阿里招聘网站 Alibaba preset
- 测试简历：用户提供的本地 PDF 简历（路径不记录）
- 成功跑通的测试 run：`runtime-2026-06-18T07-35-18-754Z`
- Trace 目录：`output/traces/claude_2026-06-18T07-35-19-374Z`
- 最新真实投递体验 run：`runtime-2026-06-18T07-44-10-627Z`
- 最新 Trace 目录：`output/traces/claude_2026-06-18T07-44-11-428Z`
- 最新 Runtime 目录：`output/claude-runtime/2026-06-18T07-44-11-428Z`

### S0 - 下一次真实投递前必须完成

1. **P0 - stdout / timeline 存在简历隐私泄露风险**（原编号：1）
   - 状态：`未解决`
   - 现象：运行过程中，模型 thinking / stdout 曾输出从简历解析出的姓名、邮箱、电话、技能等信息。
   - 影响：虽然 trace session 的部分字段有 redaction，但 `stdout.log`、Web timeline、stream-json 原始输出仍可能出现 PII。
   - 下一步：在写入 UI timeline 和普通日志前增加统一脱敏层；默认隐藏邮箱、手机号、姓名、地址等字段。完整原始日志仅允许显式 debug 模式保存，并在 UI 中提示风险。

2. **P0 - 高风险网页动作缺少 Web 侧用户确认**（原编号：2）
   - 状态：`部分解决`
   - 现象：agent 在测试流程中点击了 `投递简历`，该按钮被 MCP 标记为 L3 高风险；第一次点击被拒绝后，模型自行用 `confirmed=true` 重试。
   - 已解决部分：结构化 CLI Alibaba flow 已有人控 gate，不会自动最终投递。
   - 未解决部分：Web Console 侧还缺少统一确认 UI 和“用户确认后才允许 confirmed=true”的硬拦截。
   - 下一步：在 runtime wrapper 或 MCP tool 层拦截 L3/L4 动作，向 Web UI 发出确认事件；用户点击确认后才允许继续。确认文案必须说明目标网站、按钮文本和可能发送的数据。

3. **P1 - Prompt 安全边界需要更精细**（原编号：8）
   - 状态：`部分解决`
   - 现象：测试 prompt 写了“不要最终提交真实投递”，但模型仍将点击 `投递简历` 理解为可执行的流程验证。
   - 已解决部分：结构化 Alibaba flow 已把进入投递、登录、验证码、最终提交放在人控边界内。
   - 未解决部分：通用 Web Console / raw agent 仍需要更清晰的安全策略和工具层拦截。
   - 下一步：把 prompt 分为操作策略和安全策略。安全策略明确：未得到 Web 用户确认前，不点击任何可能发送简历、创建申请、提交表单的按钮。

4. **P0 - 提供新简历后仍可能直接用网站已有简历投递**（原编号：18）
   - 状态：`部分解决`
   - 现象：最新真实投递体验中，用户提供了本地 PDF 简历，但 trace 中没有实际 `mcp__playwright__browser_upload_file` 调用；agent 在确认弹窗中直接点击了 `投递`。
   - 已解决部分：结构化 Alibaba flow 当前不会自动完成真实最终投递，简历解析也已走 `resume-profile-v2`。
   - 未解决部分：仍没有“本次简历必须上传/解析/确认字段后才能最终提交”的 resume-first 硬闸门。
   - 下一步：当 `resumePath` 存在时进入 `resume-first` 模式：必须上传本次文件、等待解析、检查解析结果、补齐必填字段后，才允许点击任何最终投递按钮。

5. **P0 - 提交前缺少硬性投递闸门**（原编号：19）
   - 状态：`部分解决`
   - 现象：当前安全策略主要依赖 prompt 提醒模型“优先上传简历”，但 runtime / tool 层没有状态机阻止提交。
   - 已解决部分：结构化 Alibaba flow 的真实登录、验证码、进入投递、最终提交都不会静默自动完成。
   - 未解决部分：还没有通用 submit gate 状态机覆盖 Web Console 的所有路径。
   - 下一步：增加提交闸门状态，例如 `providedResumeUploaded=true`、`resumeParsed=true`、`requiredFieldsChecked=true`、`userSubmitApproved=true`。当用户提供了简历文件但这些条件未满足时，MCP wrapper 应拒绝 `投递 / 提交 / 确认投递` 等高风险点击。

6. **P1 - 完成态判断过于乐观**（原编号：21）
   - 状态：`部分解决`
   - 现象：最新 run 在点击确认投递后跳到个人中心附近，但随后浏览器会话被关闭，截图和重新打开页面都失败；agent 仍输出 `AGENT_STATUS=COMPLETED`。
   - 已解决部分：结构化 CLI flow 会输出 `no_match`、`blocked`、`login_required` 等更保守状态，不再把未验证详情或未完成投递当成功。
   - 未解决部分：Web Console / raw agent 的 `COMPLETED` 语义仍需用页面证据收紧。
   - 下一步：完成条件必须绑定可验证页面信号；如果浏览器关闭或风控中断发生在最终确认前，应标记为 `INCOMPLETE` 或 `NEEDS_CONFIRMATION`，并提示用户去个人中心确认。

7. **P2 - “真实投递”和“流程演示”模式没有清晰分离**（原编号：25）
   - 状态：`未解决`
   - 现象：本次测试是用户授权的真实投递，但系统没有在 UI 上显式展示当前是“真实提交模式”还是“演示/只到提交前模式”。
   - 影响：用户难以判断 agent 会不会点最终提交；模型也没有稳定的模式约束。
   - 下一步：增加运行模式开关：`演示到提交前`、`提交前请求确认`、`允许真实提交一次`。默认应为“提交前请求确认”；真实提交模式需要在 UI 上显示红色/橙色状态，并在最终提交前再次列出将发送的数据来源。

### S1 - MVP 体验稳定优先

1. **P1 - Timeline 太原始，用户进度和开发者 trace 混在一起**（原编号：5）
   - 状态：`未解决`
   - 现象：timeline 同时显示 stdout、assistant thinking、tool_use、tool_result、result、handoff 等事件。
   - 影响：对开发者有信息量，但普通用户很难判断“现在做到哪一步、是否需要我操作”。
   - 下一步：拆成两层：默认显示“用户可读进度流”，例如“打开网站 / 找到岗位 / 进入详情 / 等待登录”；高级面板再显示原始 trace 和 JSON。

2. **P1 - Handoff 体验还不够面向用户**（原编号：6）
   - 状态：`未解决`
   - 现象：到达登录页后，Web UI 进入 `blocked` 并显示 `Continue After Handoff`，但提示文案仍偏英文和工程化。
   - 影响：用户可能不知道应该去哪个浏览器窗口登录、登录完成后该点哪里、点了 Continue 会发生什么。
   - 下一步：中文化并强化 blocked 状态：显示“请在弹出的阿里登录窗口完成登录，然后点击继续”；按钮改为“我已完成登录，继续任务”；附带“停止任务”入口。

3. **P1 - maxTurns 不足时错误语义不清晰**（原编号：7）
   - 状态：`未解决`
   - 现象：上一次 `maxTurns=8` 时任务在投递入口附近停止，UI 显示 failed。
   - 影响：用户会误以为模型或网站失败，其实只是 turn budget 不够。
   - 下一步：识别 `error_max_turns`，在 UI 显示为 `incomplete` 或 “回合数不足”，并提供“一键继续 / 提高 max turns 后继续”。

4. **P2 - 长响应期间缺少 heartbeat**（原编号：11）
   - 状态：`未解决`
   - 现象：智谱模型某些阶段响应较慢，timeline 会数十秒不更新。
   - 影响：用户可能以为页面卡住。
   - 下一步：runtimeRuns 增加 heartbeat event，UI 显示 elapsed time、当前 pass、最近一次事件时间和“模型正在思考/工具正在执行”状态。

5. **P2 - Run / Stop / Continue 状态需要更严谨**（原编号：13）
   - 状态：`未解决`
   - 现象：blocked 后 wrapper 仍在等待 continue 文件；Stop 是否会关闭 handoff browser、清理子进程和 storage state，目前 UI 没有说明。
   - 影响：用户可能留下后台进程或浏览器窗口。
   - 下一步：Stop 文案改为“停止并关闭浏览器”；停止后确认子进程组、browser session、SSE subscriber 都被清理。

6. **P1 - `form_snapshot` 的 `uploadHints` 存在误判**（原编号：20）
   - 状态：`未解决`
   - 现象：最新 run 的 `form_snapshot` 返回 `1 upload hints`，但实际 hint 是按钮文本 `投递简历`，不是文件上传入口。
   - 影响：模型可能被误导，以为已经识别到“上传相关入口”，但没有真正发现 `<input type=file>` 或上传简历按钮。
   - 下一步：调整 `uploadHints` 规则：只把 `input[type=file]`、明确的“上传 / 选择文件 / 附件简历 / 重新上传 / 简历解析”等入口标记为上传；`投递简历` 应归类为 submit-like high-risk action，不应作为 upload hint。

7. **P1 - Web 左侧配置栏在任务结束后可能从视野中消失**（原编号：22）
   - 状态：`未解决`
   - 现象：用户体验中，任务结束后 Web 界面左侧似乎消失。初步检查新开页面时左侧 DOM 仍存在，基础 CSS 没有被删除。
   - 可能原因：当前 `.app` 使用 `min-height: 100vh`，timeline 事件很多时整页高度被撑大；页面滚动位置可能落在中下部，导致左侧顶部配置区不在视野内。
   - 下一步：改为固定工作台布局：`.app { height: 100vh; overflow: hidden; }`，`aside`、`main .timeline`、`.inspect` 分别内部滚动；同时在移动宽度下提供显式 tabs 或抽屉。

8. **P3 - 缺少运行历史入口**（原编号：16）
   - 状态：`未解决`
   - 现象：后端有 `/api/runtime/runs`，但 UI 没有历史 run 列表。
   - 影响：刷新页面后不容易找回刚才的 run、trace、runDir。
   - 下一步：左侧或右侧增加最近运行列表，支持点击恢复 run 状态和 trace。

9. **P2 - 最新 run 的选择和历史恢复能力不足**（原编号：24）
   - 状态：`未解决`
   - 现象：后端 `/api/runtime/runs` 能返回多个 run，但 Web UI 刷新后默认回到 `no run`，没有自动恢复最近一次真实投递记录。
   - 影响：用户任务完成后刷新页面或重新打开页面，会以为记录丢了；同时不容易对比“早一轮 blocked run”和“最新真实投递 run”。
   - 下一步：增加最近运行列表，并默认选中最近启动或最近更新的 run；每个 run 显示状态、开始时间、目标域名、是否 handoff、是否 completed/incomplete。

### S2 - 运维和调试可靠性

1. **P1 - API key 只保存在 Web server 内存中**（原编号：3）
   - 状态：`未解决`
   - 现象：智谱 `claude-code-runtime` key 配置成功后，重启 Web server 会回到 `key: NOT SET`。
   - 影响：每次重启都要重新从 BigModel 页面取 key，体验断裂。
   - 下一步：增加显式的“保存到本地配置”能力，可写入 repo `.env` 或用户目录安全配置文件。UI 要保持 masked 展示，不把 key 写入 trace、stdout 或普通日志。

2. **P1 - 空 API key 保存曾清空已有 key，需要补回归测试**（原编号：4）
   - 状态：`部分解决`
   - 现象：Web UI 点击 Run 前会调用 `saveConfig()`；当 key 输入框为空时，旧实现会让后端配置丢失 key，导致 `Missing model credential`。
   - 已解决部分：已修改为后端合并 `modelOverride`，空 key 不覆盖已有 key。
   - 未解决部分：本文档尚未记录 HTTP/API 回归测试。
   - 下一步：补一个 HTTP/API 回归测试：先 POST 带 key 的配置，再 POST 空 key 的配置，确认 `/api/config` 仍返回 `hasKey=true`。

3. **P2 - Trace 面板只有列表，不够可诊断**（原编号：9）
   - 状态：`未解决`
   - 现象：右侧 Trace Spans 当前主要显示 span 类型、名称、耗时，缺少详情展开。
   - 影响：需要回到文件系统看 `spans.jsonl` / `events.jsonl` 才能定位问题。
   - 下一步：增加 span 详情抽屉，显示 input/output 摘要、状态、错误、耗时、parent/child 关系；增加按 `llm_call`、`mcp_tool_call`、`runtime_event` 过滤。

4. **P2 - 缺少运行成本和 token 摘要**（原编号：10）
   - 状态：`未解决`
   - 现象：stream-json result 里有 `total_cost_usd`、token usage，但 Web UI 没有汇总展示。
   - 影响：用户无法感知一次运行的成本和 token 消耗。
   - 下一步：在 Run inspector 中增加 cost、input/output/cache tokens、model、duration、turns。

5. **P2 - 允许域名和登录跳转域名关系不清晰**（原编号：12）
   - 状态：`未解决`
   - 现象：运行配置显示 allowed domains 为 `talent-holding.alibaba.com`，但点击投递后跳到 `mozi-login.alibaba-inc.com`。
   - 影响：如果未来严格执行域名白名单，登录流程可能被误拦；如果不拦，UI 又会让用户误以为只访问了一个域名。
   - 下一步：在 Alibaba preset 中显式列出相关登录域名，或在跳转跨域时向 UI 记录“已跳转到登录域”事件。

6. **P2 - 配置表单缺少 provider 语义**（原编号：14）
   - 状态：`未解决`
   - 现象：UI 文案显示 `Model endpoint` / `Model`，但 saveConfig 固定按 Anthropic-compatible 写入。
   - 影响：用户可能填 OpenAI endpoint 后误用 Anthropic 协议。
   - 下一步：增加 provider 选择或固定文案为“Anthropic-compatible endpoint”；BigModel preset 可以一键填充官方兼容端点和模型。

7. **P3 - 缺少截图/页面状态可视化**（原编号：17）
   - 状态：`部分解决`
   - 现象：MCP 有 `browser_screenshot` 工具，但 Web UI 没有展示当前浏览器截图。
   - 已解决部分：trace/run artifact 中已经能保存关键截图，CLI run 可用于复盘。
   - 未解决部分：Web UI 还没有当前页面预览和关键截图面板。
   - 下一步：增加“当前页面预览”区域，展示关键截图或最后一次 screenshot；没有截图时提供按钮触发截图工具。

8. **P2 - 本地存在多个 Web server 实例，容易造成体验混乱**（原编号：23）
   - 状态：`未解决`
   - 现象：排查时发现 `dist/web/server.js` 同时监听 `5178` 和 `5179`；用户当前使用的是 `5179`，但另一个实例仍在运行。
   - 影响：用户可能打开不同端口看到不同运行状态、不同内存配置或不同 API key 状态；开发调试时也容易误判“配置丢失”或“run 不见了”。
   - 下一步：启动时检测已有实例并提示；UI 显示当前 server port 和启动时间；开发脚本提供 `npm run web:stop` 或自动清理旧进程。

### S3 - 产品 polish

1. **P3 - UI 中英文混杂**（原编号：15）
   - 状态：`未解决`
   - 现象：按钮和状态包含 `Run Agent`、`Refresh Trace`、`Continue After Handoff`、`blocked` 等英文。
   - 影响：面向中文用户时不够自然。
   - 下一步：做一版中文 UI 文案：运行任务、刷新 Trace、我已完成登录、停止任务、等待人工处理等。

## 2026-07-01 Alibaba Structured Flow E2E 修复与后续

测试上下文：

- 代码路径：`packages/web-buddy`
- 简历：用户提供的本地 PDF 简历（路径不记录）
- 缩小真实 smoke run：`output/2026-07-01T11-25-32`
- 完整可视化 run：`output/2026-07-01T11-26-46`
- 安全边界：真实登录、验证码、上传、保存、最终提交都必须停在人控 gate，不自动完成真实投递。

### S0 - 下一次真实投递前必须完成

1. **P0 - Alibaba 详情页伪成功和详情页打开不稳定**（新增编号：2026-07-01-01）
   - 状态：`已解决`
   - 现象：早前 `scrapeJobDetail` 会把 `position-list` 列表页误算为岗位详情页；修复伪成功后又暴露出 `detailUrl/positionId` 抽取不稳，fallback 点击找不到来源页卡片。
   - 已解决内容：`ScrapedJob` 保存 `sourcePageIndex/sourceCardIndex/sourceTitle/sourceRootListUrl`；真实 Alibaba 优先走 `position/search` 接口拿 `positionId` 和真实 `position-detail` URL；fallback 支持回到来源页再点击；详情验证继续拒绝 `position-list`。
   - 验证证据：缩小 smoke `detailsAttempted=3/detailsVerified=3/detailsFailed=0`；完整可视化 run `detailsAttempted=10/detailsVerified=10/detailsFailed=0`，所有 detail URL 都是 `position-detail`。

2. **P1 - LLM 重排后阈值判断只看第一项，可能漏掉已过线候选**（新增编号：2026-07-01-02）
   - 状态：`已解决`
   - 现象：完整 run 中有候选分数 `0.4573` 已超过 `0.45`，但 LLM 重排第一项是 `0.4481`，旧逻辑只看数组第一项导致 `no_match`。
   - 已解决内容：`decideMatchThreshold` 改为使用最高分候选做阈值判断，而不是只看 LLM 重排后的第一个。
   - 验证证据：`npm run build` 通过；`npm run test:matcher` 通过，并新增回归覆盖“第一项低于阈值、第二项高于阈值”的场景。

### S1 - MVP 体验稳定优先

1. **P1 - Alibaba 候选池采样偏窄，容易让 top candidates 偏向最新页热点岗位**（原编号：26）
   - 状态：`部分解决`
   - 现象：2026-07-01 的真实 Alibaba run `2026-07-01T11-26-46` 中，站点约有 513 个岗位，但完整可视化测试只抓前 5 页共 50 个岗位。最终 top candidates 偏向 AI、Agent、LLM、数据、安全相关岗位。
   - 已解决部分：详情页导航、`positionId/detailUrl` 抽取、真实详情验证、阈值判断 bug 都已修复；现在已有可靠的候选详情数据。
   - 未解决部分：候选池仍主要来自前几页，缺少广撒网采样、类别采样和人工复核 artifact。
   - 证据：`job-candidates-coarse.json` 显示 `scanned=50`、`pagesScanned=5`、`siteAdvertisedTotal=513`；这 50 个里命中“安全”的只有 6 个，不是只爬到了安全岗，而是简历目标和技能强匹配 AI/LLM/Agent/RL/RAG/Python/Docker 后，把相关岗位顶到了前面。额外抽样第 10、20、30、40、50 页能看到更多全栈、前端、AI 应用、AI 平台、搜索、AIOps、产品等岗位。
   - 下一步：增加广撒网候选池模式，例如采样页码 `1,2,5,10,20,30,40,50` 或按类别/关键词查询；生成候选复核 artifact，展示 top-N 高分岗位和按类别分散的 near-matches；即使没有过阈值，也给用户看几条已验证详情候选。

2. **P1 - 登录 handoff 后任务不应默认结束，应由用户决定继续或退出**（新增编号：2026-07-01-03）
   - 状态：`已解决`
   - 现象：用户授权进入真实 Alibaba 投递流程后，CLI 停在登录 gate；用户完成登录并选择继续，agent-loop 仍把 `Human login required before continuing.` 当作最终 blocked 状态结束，导致浏览器保留但任务不能原地恢复。
   - 影响：真实投递体验被中断；用户已经完成登录/验证码后，系统应该继续执行后续表单识别、简历确认和最终提交前 gate，而不是随意退出。
   - 已解决内容：`workflow_handoff` gate 批准后刷新页面状态并重新评估 workflow；已批准的 login/captcha gate 不再永久制造 blocker；登录/验证码消失并回到详情页时，workflow 可从 `login_required/captcha_required` 回到 `job_detail`，支持继续点击投递入口。
   - 安全边界：最终提交 gate 未放松；如果页面仍是登录/验证码，会继续提示用户处理；`decline/takeover` 仍会停止。
   - 验证证据：`npm run test:agent-runtime-workflow` 通过；真实可视化 run `output/2026-07-01T13-28-13` 没有再误判登录，最终停在 `direct_submit_review`，检测到 `loginWall=false`、`agreementCheckboxCount=1`、`submitApplyButtonCount=1`。

3. **P1 - 本次提供的简历必须优先上传，站内旧简历不能默认替代**（新增编号：2026-07-01-04）
   - 状态：`部分解决`
   - 现象：真实 Alibaba 投递体验中，agent 进入个人中心后看到站内已有旧简历，就判断“简历似乎已经上传”，没有优先上传本次命令传入的本地 PDF 简历。
   - 影响：用户以为系统会用本次简历投递，但实际可能沿用账号里旧简历，投递内容和用户意图不一致。
   - 已解决内容：本地 runtime 已暴露 `browser_upload_file`；prompt 安全规则新增“如果任务上下文提供当前简历文件路径，站内已有简历不能默认满足本次任务”；Alibaba LLM context 会传入当前 resume path，并要求看到上传/重新上传入口时先 `browser_form_snapshot`，再通过 `browser_upload_file` 上传本次文件。
   - 安全边界：上传本次简历仍走 `upload_resume` 人控 gate；最终提交 gate 未放松。
   - 验证证据：`npm run build`、`tool-catalog-test`、`permission-engine-test`、`agent-loop-test`、`test:agent-runtime-workflow` 均通过。
   - 未完成验证：尚未重新跑真实 Alibaba 流程到“上传本次简历成功”这一步；下一轮应确认 agent 不再沿用旧简历，并在上传本次 PDF 后继续填表。

4. **P1 - Alibaba 详情页投递前未勾选“已阅读并同意”导致入口按钮无响应**（新增编号：2026-07-01-05）
   - 状态：`已解决`
   - 现象：真实 run `output/2026-07-01T14-22-20` 停在岗位详情页；截图显示 `投递简历` 左侧的“申请此职位表明您已阅读并同意阿里巴巴集团及关联公司的《申请工作需知》”checkbox 未勾选。agent 多次直接点击 `投递简历`，页面没有进入后续申请表单。
   - 根因：`attemptApply` 之前把 agreement checkbox 统一视为 final-submit boundary，没有处理阿里详情页的“进入申请流程前置同意”；agent prompt 也只提示可点击入口按钮，没有明确要求先勾选该前置 checkbox。
   - 已修复内容：Alibaba detail apply 入口新增前置处理：用户批准进入投递流程后，若详情页存在“申请此职位/申请工作需知/阅读并同意”checkbox，会先勾选，再点击 `投递简历`；最终投递 gate 不放松。agent 安全提示也补充了阿里详情页 checkbox 规则。
   - 验证证据：真实 run `output/2026-07-02T02-49-16` 和 `output/2026-07-02T06-19-38` 均显示 agent 先处理详情页同意 checkbox，再点击 `投递简历` 进入后续确认/申请边界，没有再卡在未勾选状态。

5. **P1 - Alibaba 详情页二次确认弹窗“投递”被误判为 final_submit**（新增编号：2026-07-02-01）
   - 状态：`部分解决`
   - 现象：真实 run `output/2026-07-01T14-35-11` 中，登录后 agent 正确勾选详情页“申请工作需知”checkbox 并点击 `投递简历`，页面弹出“温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！”；用户批准点击弹窗内 `投递` 后，policy 将该按钮误判为 `final_submit`，completion gate 直接 `stopped_at_submit`，未继续进入后续申请/上传流程。
   - 根因：`browser_click` 的 ref label 是单独的 `投递`，旧规则只把 `投递简历/立即投递/apply` 识别为阿里详情页 apply-entry；单字 `投递` 落入通用 submit-like 规则，被当成最终提交。
   - 已修复内容：仅在 `talent-holding.alibaba.com/off-campus/position-detail` 页面，把 `投递/投递简历/立即投递/申请职位/开始申请/apply` 以及包含旁边“申请工作需知”文案的入口按钮标签优先识别为 `high_risk_action`，即使 workflow phase 曾漂到 `direct_submit_review/reviewing` 也不会直接结束任务；`确认投递/提交申请/完成投递` 仍按 `final_submit` 处理。
   - 本地验证：`node ./scripts/policy-engine-test.mjs` 通过，覆盖阿里详情页 `投递简历`、弹窗单字 `投递` 和带“申请工作需知”上下文的按钮都归为 `policy.workflow.alibaba_apply_entry` / `high_risk_action`。
   - 真实验证：`output/2026-07-02T06-19-38` 已验证详情页 `投递简历` 不再被当作 `final_submit`；弹窗单字 `投递` 仍需下一次真实流程跑到该点击并确认。

6. **P0 - final_submit gate 把“询问用户”错误实现成“直接结束任务”**（新增编号：2026-07-02-02）
   - 状态：`部分解决`
   - 现象：真实流程中只要某个按钮被识别为 `final_submit`，无论用户选择 approve/decline，`agent-loop` 都会立刻设置 `blocked=true/done=true` 并结束任务。对于误分类的阿里入口按钮，这会造成“用户同意继续，但任务反而停止”的极差体验。
   - 根因：运行时把 final-submit 安全闸门和任务生命周期结束绑定在一起；gate 的职责应该是暂停询问/限制工具执行，而不是擅自判定整个任务完成或失败。
   - 已修复内容：`final_submit` gate 仍不自动点击真正最终提交控件，但不再直接结束 loop；它会把 `FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY` 观察返回给 agent，由 agent 继续做安全检查、等待人工处理或显式 `agent_done`。
   - 本地验证：`node ./scripts/agent-runtime-workflow-test.mjs` 通过，覆盖 final-submit gate 返回观察给模型并让 loop 继续至少一轮，而不是 gate resolve 后直接结束。
   - 未完成验证：需重新跑真实流程到真正 `确认投递/提交申请/完成投递`，确认系统不自动点击，也不无解释退出。

7. **P0 - Alibaba 确认弹窗仍打开时模型调用 agent_done 导致任务提前结束**（新增编号：2026-07-02-03）
   - 状态：`部分解决`
   - 现象：真实 run `output/2026-07-02T02-49-16` 中，详情页同意框和 `投递简历` 入口已正确执行，页面出现“你暂未申请职位，本月能申请5个职位，请慎重选择！”弹窗；模型没有点击弹窗 `投递` 触发 gate，而是直接 `agent_done(blocked=true)`，任务结束。
   - 根因：`agent_done` 的接受条件过宽，只要模型声称 blocked 就结束，没有校验页面上是否仍存在可处理的阿里申请确认弹窗。
   - 已修复内容：运行时新增阿里确认弹窗保护：如果当前页面仍是 `talent-holding.alibaba.com/off-campus/position-detail` 且弹窗包含“本月能申请 N 个职位 / 请慎重选择 / 投递 / 取消”，则拒绝这次 `agent_done(blocked=true)`，把观察返回给模型，要求继续通过正常 gate 点击 `投递` 或取消/接管。
   - 本地验证：`node ./scripts/agent-runtime-workflow-test.mjs` 通过，覆盖阿里确认弹窗仍打开时 premature `agent_done(blocked=true)` 被拦截，模型获得机会取消或继续处理弹窗。
   - 未完成验证：需重新跑真实流程，确认弹窗出现后不再由模型直接结束，而是进入用户确认后继续。

8. **P0 - 自主 Agent、硬编码流程和安全 Gate 的职责边界不清**（新增编号：2026-07-02-04）
   - 状态：`部分解决`
   - 现象：真实 Alibaba 投递流程中，页面已经清楚展示 checkbox、`投递简历`、二次确认弹窗和上传/投递相关按钮；用户期望 agent 能自主判断并在高风险动作前询问意愿，同意后继续。但当前实现混合了结构化流程、prompt 规则、policy 分类和 runtime completion gate，导致一些动作被写成局部硬规则，另一些动作又完全依赖模型自觉，体验上表现为“问了用户却停止”“模型过早 agent_done”“误把投递按钮当上传入口”。
   - 根因：缺少清晰三层边界：模型负责页面语义和下一步计划；Policy/Permission 只负责把工具调用归一成 `ActionIntent`、做风险分类并判断是否需要询问；Runtime 负责可恢复 gate 生命周期，而不是把 gate 和任务结束绑定。上传工具也缺少“必须绑定真实上传控件”的前置校验。
   - 目标方案：保持模型自主操作页面，但用安全护栏纠偏：`apply_entry/high_risk_action` 为“问用户 -> 同意 -> 执行 -> 刷新观察 -> 继续”；`upload_resume` 只允许真实上传入口；`final_submit` 不自动执行但也不直接杀死任务；`agent_done(blocked=true)` 必须通过 completion gate，页面上仍有可处理动作时不能提前结束。
   - 已完成文档化：已同步到 `docs/golden-problems.md`，作为 GP-001 面试复盘材料；`docs/safety-model.md` 记录 `ActionIntent`、可恢复 gate、上传入口和 completion gate 边界。
   - 面试价值：这是一个可以讲清楚项目深度的黄金问题：真实网页 agent 不是“能点按钮”这么简单，而是要处理模型自主性、安全边界、可恢复人机协作、任务状态机和工具可审计之间的张力。
   - 下一步：继续落地 `uploadHints` 分类修复、上传入口真实校验和 completion gate 的证据化完成条件；不要把阿里流程扩展成完整硬编码步骤表。

### 本地测试和真实 E2E 验证结果

本地验证（2026-07-02，`packages/web-buddy`）：

- `npm run build` 通过。
- `node ./scripts/policy-engine-test.mjs` 通过：覆盖阿里详情页 `投递/投递简历` 的 `high_risk_action` 分类，以及真正 `确认投递` 的 `final_submit` 分类。
- `node ./scripts/agent-runtime-workflow-test.mjs` 通过：覆盖登录 handoff 后继续、final-submit gate 不直接结束 loop、阿里确认弹窗仍开时拒绝 premature `agent_done`。
- `node ./scripts/direct-submit-flow-test.mjs` 通过：覆盖没有真实可填写表单时停在 direct-submit review / final-submit 前。
- `node ./scripts/completion-gate-test.mjs` 通过：覆盖完成态需要 workflow/completion 证据。
- `node ./scripts/upload-file-test.mjs` 通过：覆盖普通 `投递简历` 按钮不能作为文件上传目标。

真实 E2E 证据：

- `output/2026-07-01T13-28-13`：登录 handoff 后任务没有默认结束；最终识别 `direct_submit_review`，artifact 显示 `loginWall=false`、`realFillableFieldCount=0`、`agreementCheckboxCount=1`、`submitApplyButtonCount=1`，下一步是 `final_submit` 边界。
- `output/2026-07-01T14-35-11`：暴露弹窗 `投递` 被误判为 `final_submit` 后停止的问题。
- `output/2026-07-02T02-49-16`：暴露确认弹窗仍打开时模型直接 `agent_done(blocked=true)`，说明 `agent_done` 也需要 completion gate。
- `output/2026-07-02T06-19-38`：修复后 `投递简历` 已按 `policy.workflow.alibaba_apply_entry` 进入 `high_risk_action` gate，approve 后继续；同一 run 暴露 `uploadHints` 仍把 `投递简历` 误导为上传入口，任务停在 `upload_resume` 审批/真实上传入口校验之前，未自动最终提交。

### S3 - 产品 polish / 架构后续

1. **P3 - Skill system 需要作为单独设计线，不应混入 Alibaba E2E 修复**（原编号：27）
   - 状态：`未解决`
   - 现象：前期讨论过 skill 系统方向，但 Alibaba 端到端修复阶段明确不做 skill 系统重构。
   - 影响：如果把 skill 抽象混进真实站点 bug 修复，会扩大改动面，让登录、投递、安全 gate、artifact 兼容性一起承压。
   - 下一步：单独开设计/实现阶段，先定义清楚 skill 边界、输入、输出、安全 gate、trace artifact 和测试方式；优先从窄技能开始，例如简历解析、岗位抓取、岗位匹配、表单填写；真实登录、验证码、上传、保存、最终提交继续保留在人控 gate 后；迁移时保持现有 CLI 和 artifact 兼容。

## 当前状态汇总

截至 2026-07-02：

- `已解决`：2026-07-01-01、2026-07-01-02、2026-07-01-03、2026-07-01-05。
- `部分解决`：2、4、8、17、18、19、21、26、2026-07-01-04、2026-07-02-01、2026-07-02-02、2026-07-02-03、2026-07-02-04。
- `未解决`：1、3、5、6、7、9、10、11、12、13、14、15、16、20、22、23、24、25、27。
- `待验证`：当前无单独 `待验证` 条目；若按真实 E2E 口径，2026-07-02-01、2026-07-02-02、2026-07-02-03、2026-07-02-04 仍需要继续复跑到上传/最终提交前边界。

## 已验证的正向能力

1. Web 控制台可以通过 UI 启动 `claude-runtime + Playwright MCP`。
2. 智谱兼容 Anthropic endpoint 配置后，模型和 MCP server 能正常连通。
3. stream-json trace 能持续产生 span。
4. Alibaba preset 能打开阿里招聘、识别岗位列表、进入岗位详情。
5. 到达登录页后，handoff 状态能传回 Web UI，并显示 Continue 按钮。
6. 真实体验 run 能在 handoff 后继续执行，并把最终 runtime 事件和 span 写入 trace。
7. 截图能力正常，保存了申请确认弹窗和岗位详情截图，可用于复盘 UI 行为。
8. 结构化 Alibaba flow 在 2026-07-01 已能稳定打开并验证真实 `position-detail` 详情页。
