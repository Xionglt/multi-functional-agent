# 完整体验教程 / Full Experience Guide

> 中文版在前，English version follows.

本教程面向第一次拉取仓库的人，目标是从零开始完整体验当前项目的主要能力：离线 demo、Web 控制台、模型配置、任意招聘网站填表、阿里巴巴招聘投递 runtime、raw 对照运行、trace 和日志查看。

## 中文版

### 1. 前置要求

建议环境：

- macOS / Linux / Windows WSL。
- Node.js 18 或更高版本，建议 Node.js 20+。
- npm。
- Git。
- 一个支持 tool calling 的模型 API Key。

已经验证过的模型接入方式：

- 智谱 GLM，Anthropic-compatible API，推荐 `glm-4.7`。
- OpenAI-compatible API，只要模型支持 function/tool calling。

如果只是体验离线 demo，可以先不配置模型 Key。

### 2. 拉取仓库

```bash
git clone https://github.com/Xionglt/multi-functional-agent.git
cd multi-functional-agent
git checkout main
```

项目当前没有根目录 `package.json`，主要需要安装两个 package：

- `packages/playwright-mcp`
- `packages/web-buddy`

### 3. 安装依赖

```bash
cd packages/playwright-mcp
npm install
npm run build

cd ../web-buddy
npm install
npm run build
```

`packages/playwright-mcp` 的 `postinstall` 会安装 Chromium。如果 Chromium 没装成功，可以手动执行：

```bash
cd ../playwright-mcp
npx playwright install chromium
```

### 4. 先跑不需要 Key 的离线 demo

离线 demo 使用本地 mock 表单，不访问真实招聘网站，适合验证浏览器、构建、trace 是否正常。

```bash
cd packages/playwright-mcp
npm run demo
```

你应该能看到一个 Chromium 窗口打开本地 mock 表单，并看到 agent 尝试填写字段。

也可以跑基础测试：

```bash
npm run test:smoke
npm run test:resume
npm run test:agent-loop
```

### 5. 配置模型 Key

在仓库根目录创建 `.env`：

```bash
cd ../..
cp configs/agent.env.example .env
```

然后编辑 `.env`。

如果使用智谱 GLM：

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=你的智谱APIKey
ANTHROPIC_MODEL=glm-4.7
```

如果使用 OpenAI-compatible API：

```env
MODEL_API_KEY=你的APIKey
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

注意：

- 不要提交 `.env`。
- `.env` 已被 gitignore 忽略。
- Claude runtime bridge 也支持 `--env-file /path/to/.env` 显式传入配置。

### 6. 准备简历

支持三种格式：

- PDF
- JSON
- TXT

如果没有传简历，部分本地 demo 会自动生成 sample resume。

推荐把自己的简历放在一个本地路径，然后运行命令时通过 `--resume` 传入：

```bash
--resume /path/to/resume.pdf
```

也可以在 `.env` 中设置：

```env
RESUME_PDF_PATH=/path/to/resume.pdf
```

### 7. 启动 Web 控制台

Web 控制台适合观察 agent 行为、配置模型、上传简历、查看事件流和 trace。

```bash
cd packages/playwright-mcp
npm run web
```

浏览器打开：

```text
http://localhost:5178
```

如果 5178 被占用，server 会自动尝试后续端口。

在 Web UI 中可以体验：

- 配置 provider / model / key。
- 上传简历。
- 运行 `demo-form`。
- 运行通用 fill。
- 观察 think / act / observe / gate 事件。
- 查看截图和 trace。
- 在遇到登录、验证码、扫码时通过 UI 继续。

### 8. 体验任意网站填表

第一步，登录一次并保存 cookie：

```bash
cd packages/playwright-mcp
npm run login -- https://your-recruiting-site.com/
```

浏览器打开后，手动完成登录、验证码、扫码等步骤。完成后根据终端提示继续，系统会保存 Playwright `storageState`。

第二步，让 agent 填写申请表：

```bash
npm run fill -- https://your-recruiting-site.com/apply
```

如果你要显式传简历：

```bash
npm run fill -- https://your-recruiting-site.com/apply --resume /path/to/resume.pdf
```

说明：

- `fill` 需要模型 Key。
- agent 会通过浏览器工具读取页面、选择输入框、填写字段。
- 登录、验证码、上传、保存、提交等敏感步骤会进入人工交接。
- 首次测试真实网站时建议选择你自己的账号和可控页面。

### 9. 体验阿里巴巴招聘 Claude runtime

这是当前项目的重点路径：恢复版 Claude Code runtime 通过 Playwright MCP 操作阿里巴巴官方招聘网站。

先做 dry-run，确认配置和 MCP 工具都能生成：

```bash
cd packages/playwright-mcp
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --dry-run
```

真实运行：

```bash
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

如果 `.env` 不在仓库根目录，可以显式传入：

```bash
npm run alibaba:apply -- \
  --env-file /path/to/.env \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

常用调试参数：

```bash
# 输出 Claude Code stream-json，便于 Web 控制台和 trace 分析
npm run alibaba:apply -- --resume /path/to/resume.pdf --stream-json

# 限制 Claude turn 数，只用于调试
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-turns 20

# 限制 wrapper 自动续跑轮数
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-passes 2

# 遇到 BLOCKED 后不等待人工交接
npm run alibaba:apply -- --resume /path/to/resume.pdf --no-wait-on-blocked
```

运行时如果遇到登录、短信验证码、扫码或人机验证，终端会提示你在浏览器里人工处理。处理完成后回到终端按 Enter，runtime 会保存登录状态并继续同一个任务。

### 10. 体验 raw 对照路径

raw 路径不走恢复版 Claude Code runtime，而是使用本项目的本地 minimal agent loop。它适合对比“Claude runtime + MCP”和“本地 raw runtime”的行为差异。

```bash
cd packages/playwright-mcp
npm run alibaba:apply:raw -- \
  --resume /path/to/resume.pdf \
  --keep-browser-open
```

也可以直接指定任意 URL 和 prompt：

```bash
node dist/cli/demo.js raw 'https://example.com' \
  --resume /path/to/resume.pdf \
  --prompt '请打开页面，观察当前信息，然后总结页面主要内容。'
```

### 11. 阿里职位匹配只读模式

如果只想体验职位抓取和匹配，不进入真实投递流程：

```bash
cd packages/playwright-mcp
npm run demo:match
```

这个模式会尝试抓取阿里职位列表和详情，根据简历做匹配，然后在申请入口前交给人工。

### 12. 查看运行输出

运行产物主要在：

```text
output/
```

常见目录：

```text
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/<runId>/shot-*.png
output/claude-runtime/<timestamp>/run-events.log
output/claude-runtime/<timestamp>/stdout.log
output/claude-runtime/<timestamp>/stderr.log
output/claude-runtime/<timestamp>/mcp.playwright.json
output/traces/<traceId>/session.json
output/traces/<traceId>/spans.jsonl
output/traces/<traceId>/events.jsonl
```

排查问题时优先看：

1. `run-events.log`
2. `stdout.log`
3. `stderr.log`
4. `spans.jsonl`
5. 最后的截图

### 13. 安全注意事项

- 不要提交 `.env`、Cookie、storage state、简历原文或验证码信息。
- `output/` 默认是运行产物目录，里面可能包含截图、日志、登录态路径或简历相关信息。
- 真实招聘网站测试请使用你有权操作的账号和简历。
- 首次测试建议先用 `--dry-run` 或离线 demo。
- 真实投递相关动作会受到 runtime、工具和人工交接逻辑影响，但你仍然应该在浏览器里观察关键步骤。

### 14. 常见问题

#### npm 找不到 package.json

如果你已经在 `packages/playwright-mcp` 目录里，就不要再写：

```bash
npm --prefix packages/playwright-mcp run ...
```

应该直接运行：

```bash
npm run ...
```

如果你在仓库根目录，才使用：

```bash
npm --prefix packages/playwright-mcp run web
```

#### 缺少模型 Key

确认仓库根目录 `.env` 存在，并且设置了：

```env
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=glm-4.7
```

或者 OpenAI-compatible：

```env
MODEL_API_KEY=...
MODEL_BASE_URL=...
MODEL_NAME=...
```

#### 浏览器没有打开

确认：

```env
PLAYWRIGHT_HEADLESS=false
```

或者命令里加：

```bash
--headful
```

#### 网站打不开或被拦截

检查 allowlist：

```env
PLAYWRIGHT_ALLOWED_DOMAINS=talent-holding.alibaba.com
```

如果是其他网站，把目标域名加进去，多个域名用逗号分隔。

#### 运行中断但没有完成

查看最新目录：

```text
output/claude-runtime/<timestamp>/
```

重点看 `run-events.log` 和 `stdout.log` 中的 `AGENT_STATUS`。

### 15. 建议体验顺序

推荐按这个顺序体验：

1. `npm run build`
2. `npm run demo`
3. `npm run web`
4. 配置模型 Key
5. Web UI 运行 `demo-form`
6. `npm run login -- <your-site>`
7. `npm run fill -- <your-apply-url>`
8. `npm run alibaba:apply -- --resume /path/to/resume.pdf --dry-run`
9. `npm run alibaba:apply -- --resume /path/to/resume.pdf --headful --keep-browser-open`
10. 查看 `output/` trace 和日志

---

## English Version

This guide is for someone who clones the repository for the first time and wants to experience the main capabilities end to end: offline demo, Web console, model configuration, generic recruiting-site form filling, Alibaba Careers Claude runtime, raw comparison runtime, traces, and logs.

### 1. Prerequisites

Recommended environment:

- macOS / Linux / Windows WSL.
- Node.js 18 or newer, Node.js 20+ recommended.
- npm.
- Git.
- A model API key that supports tool/function calling.

Verified model options:

- Zhipu GLM through an Anthropic-compatible API, recommended model: `glm-4.7`.
- Any OpenAI-compatible API whose model supports tool/function calling.

If you only want to try the offline demo, you can skip the model key at first.

### 2. Clone the Repository

```bash
git clone https://github.com/Xionglt/multi-functional-agent.git
cd multi-functional-agent
git checkout main
```

The repository currently has no root-level `package.json`. Install the two main packages:

- `packages/playwright-mcp`
- `packages/web-buddy`

### 3. Install Dependencies

```bash
cd packages/playwright-mcp
npm install
npm run build

cd ../web-buddy
npm install
npm run build
```

`packages/playwright-mcp` runs `playwright install chromium` during postinstall. If Chromium is missing, install it manually:

```bash
cd ../playwright-mcp
npx playwright install chromium
```

### 4. Run the Offline Demo Without a Key

The offline demo uses a local mock form. It does not touch a real recruiting website and is the safest first check.

```bash
cd packages/playwright-mcp
npm run demo
```

You should see Chromium open a mock form and the agent attempt to fill it.

You can also run basic tests:

```bash
npm run test:smoke
npm run test:resume
npm run test:agent-loop
```

### 5. Configure a Model Key

Create `.env` in the repository root:

```bash
cd ../..
cp configs/agent.env.example .env
```

Then edit `.env`.

For Zhipu GLM:

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=your_zhipu_api_key
ANTHROPIC_MODEL=glm-4.7
```

For an OpenAI-compatible API:

```env
MODEL_API_KEY=your_api_key
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

Notes:

- Never commit `.env`.
- `.env` is ignored by git.
- The Claude runtime bridge also supports `--env-file /path/to/.env`.

### 6. Prepare a Resume

Supported formats:

- PDF
- JSON
- TXT

Some local demos generate a sample resume automatically. For real runs, pass your resume explicitly:

```bash
--resume /path/to/resume.pdf
```

Or set it in `.env`:

```env
RESUME_PDF_PATH=/path/to/resume.pdf
```

### 7. Start the Web Console

The Web console is useful for model configuration, resume upload, live events, screenshots, and trace review.

```bash
cd packages/playwright-mcp
npm run web
```

Open:

```text
http://localhost:5178
```

If port 5178 is busy, the server will try the next ports automatically.

In the Web UI you can:

- configure provider / model / key.
- upload a resume.
- run `demo-form`.
- run generic fill.
- watch think / act / observe / gate events.
- inspect screenshots and trace.
- continue after login, captcha, or scan handoffs.

### 8. Try Generic Form Filling on Any Website

First, log in once and save cookies:

```bash
cd packages/playwright-mcp
npm run login -- https://your-recruiting-site.com/
```

Complete login, captcha, or scan manually in the browser. Then follow the terminal prompt so the system can save Playwright `storageState`.

Second, let the agent fill an application form:

```bash
npm run fill -- https://your-recruiting-site.com/apply
```

With an explicit resume:

```bash
npm run fill -- https://your-recruiting-site.com/apply --resume /path/to/resume.pdf
```

Notes:

- `fill` requires a model key.
- The agent reads the page through browser tools and fills matching fields.
- Login, captcha, upload, save, and submit-like steps are handled through human handoff.
- For first real-site tests, use an account and page you control.

### 9. Try the Alibaba Careers Claude Runtime

This is the main project path: the recovered Claude Code runtime operates Alibaba Careers through Playwright MCP.

First run dry-run:

```bash
cd packages/playwright-mcp
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --dry-run
```

Real run:

```bash
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

If your `.env` lives elsewhere:

```bash
npm run alibaba:apply -- \
  --env-file /path/to/.env \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

Useful debugging options:

```bash
npm run alibaba:apply -- --resume /path/to/resume.pdf --stream-json
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-turns 20
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-passes 2
npm run alibaba:apply -- --resume /path/to/resume.pdf --no-wait-on-blocked
```

If the site requires login, SMS, QR scan, captcha, or other human-only steps, the terminal will pause. Complete the step in the browser, then press Enter in the terminal. The runtime saves the browser state and continues the same task.

### 10. Try the Raw Comparison Runtime

The raw path does not use the recovered Claude Code runtime. It uses this repository's local minimal agent loop, which is useful for comparison.

```bash
cd packages/playwright-mcp
npm run alibaba:apply:raw -- \
  --resume /path/to/resume.pdf \
  --keep-browser-open
```

You can also run a custom raw URL and prompt:

```bash
node dist/cli/demo.js raw 'https://example.com' \
  --resume /path/to/resume.pdf \
  --prompt 'Open the page, inspect the visible information, and summarize it.'
```

### 11. Alibaba Job Matching Read-Only Mode

To try job scraping and matching without entering the real application flow:

```bash
cd packages/playwright-mcp
npm run demo:match
```

This mode attempts to scrape Alibaba job list/detail pages, match jobs to the resume, and hand off before the application gate.

### 12. Inspect Run Outputs

Run artifacts live under:

```text
output/
```

Common files:

```text
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/<runId>/shot-*.png
output/claude-runtime/<timestamp>/run-events.log
output/claude-runtime/<timestamp>/stdout.log
output/claude-runtime/<timestamp>/stderr.log
output/claude-runtime/<timestamp>/mcp.playwright.json
output/traces/<traceId>/session.json
output/traces/<traceId>/spans.jsonl
output/traces/<traceId>/events.jsonl
```

For debugging, check in this order:

1. `run-events.log`
2. `stdout.log`
3. `stderr.log`
4. `spans.jsonl`
5. final screenshot

### 13. Safety Notes

- Do not commit `.env`, cookies, storage state, raw resume content, or verification codes.
- `output/` may contain screenshots, logs, paths to login state, and resume-related information.
- Use real recruiting websites only with accounts and resumes you are allowed to operate.
- Start with `--dry-run` or the offline demo.
- Watch the browser during important real-site steps.

### 14. Troubleshooting

#### npm cannot find package.json

If you are already inside `packages/playwright-mcp`, do not run:

```bash
npm --prefix packages/playwright-mcp run ...
```

Run this instead:

```bash
npm run ...
```

Use `--prefix` only from the repository root:

```bash
npm --prefix packages/playwright-mcp run web
```

#### Missing model key

Make sure root `.env` exists and contains:

```env
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=glm-4.7
```

Or OpenAI-compatible settings:

```env
MODEL_API_KEY=...
MODEL_BASE_URL=...
MODEL_NAME=...
```

#### Browser does not open

Set:

```env
PLAYWRIGHT_HEADLESS=false
```

Or pass:

```bash
--headful
```

#### Website is blocked by navigation policy

Check:

```env
PLAYWRIGHT_ALLOWED_DOMAINS=talent-holding.alibaba.com
```

For other websites, add the target host. Multiple domains are comma-separated.

#### Run exits before completion

Open the latest folder:

```text
output/claude-runtime/<timestamp>/
```

Check `run-events.log` and `stdout.log`, especially the final `AGENT_STATUS`.

### 15. Recommended Experience Order

1. `npm run build`
2. `npm run demo`
3. `npm run web`
4. configure model key
5. run `demo-form` in the Web UI
6. `npm run login -- <your-site>`
7. `npm run fill -- <your-apply-url>`
8. `npm run alibaba:apply -- --resume /path/to/resume.pdf --dry-run`
9. `npm run alibaba:apply -- --resume /path/to/resume.pdf --headful --keep-browser-open`
10. inspect `output/` traces and logs
