# Safety Model

This document describes the MVP safety boundary for `multi-functional-agent` as
of Phase 5B. The goal is simple: the runtime may observe pages and prepare safe
drafts, but sensitive real-world steps remain human-controlled and auditable.

## Safety Goals

- Keep local demos runnable without accounts, captchas, or live sites.
- Let browser agents observe pages and fill low-risk draft fields.
- Stop or hand off login, captcha, upload, save, payment, and final submit.
- Record enough trace, metrics, and safety-report data for review.
- Keep diagnostic artifacts separate from runtime state.

## Risk Levels

| Level | Meaning | Default handling |
| --- | --- | --- |
| `L0` | Pure observation or internal bookkeeping. | Allow. |
| `L1` | Safe navigation or low-risk page interaction. | Allow if navigation policy permits it. |
| `L2` | Ordinary form input such as name, email, phone, or text fields. | Allow in guarded flows. |
| `L3` | Submit-like, apply-like, save-like, or other high-impact actions. | Gate or block depending on workflow phase and target. |
| `L4` | Passwords, captchas, uploads, payment, credentials, or verification. | Human handoff or block. |

## PolicyEngine Decisions

`PolicyEngine.evaluate()` is the policy boundary before tool execution. It
classifies each proposed tool call and returns one of:

- `allow`: the tool may execute.
- `gate`: the tool needs a human confirmation or handoff first.
- `block`: the tool must not execute.
- `auto_confirm`: compatibility behavior for selected raw-mode high-risk clicks.

The policy result includes stable audit fields such as `policyCode`, `ruleId`,
`reason`, `riskLevel`, `gateKind`, and optional workflow phase metadata.

Important boundary: `PolicyEngine` only decides. It does not execute tools, read
trace artifacts, infer hidden user intent, or perform human interaction.

## HumanGate Responsibilities

`HumanGate` is responsible for the user-facing confirmation or handoff once
policy requests it. It may ask the user to approve, take over, or stop. It does
not decide policy and does not reinterpret the risk level.

Default checkpoints:

| Gate | Meaning |
| --- | --- |
| `login` | A login wall, QR code, SMS step, or account session step appeared. |
| `captcha` | A captcha or human verification challenge appeared. |
| `upload_resume` | The task wants to attach a file or resume. |
| `save_resume` | The task wants to persist a site-side draft or profile. |
| `final_submit` | The task wants to submit, apply, pay, confirm, or send a final action. |

## Workflow Phases And Sensitive Gates

The runtime tracks a minimal `WorkflowState` working set. Policy uses this state
to distinguish similar-looking UI actions:

- Apply-entry actions may be part of entering a workflow.
- Final-submit actions are terminal and sensitive.
- Login/captcha phases route to human handoff.
- Review-ready phases tighten submit-like gates.

This is not yet a full `WorkflowEngine`, workflow definition system, or
persistent workflow state store. It is a runtime working set used to improve
context and policy decisions.

## Final Submit Contract

The MVP does not silently final-submit real forms. Submit-like actions include
text such as submit, apply, confirm, send, pay, application, and common Chinese
equivalents such as submit/apply wording used in job sites.

Local or sandbox benchmarks may exercise submit behavior only when the target is
explicitly local/sandboxed and the test path permits it. Real external sites
must remain gated or blocked at final submit.

## Login And Captcha Handoff Contract

The runtime does not perform real login, solve captchas, bypass QR codes, or
handle SMS/email verification automatically. When those states appear, the run
must hand control to the user or stop with a clear blocked state.

Saved cookies can be reused after a user manually logs in through the explicit
`login <url>` command. The runtime stores Playwright `storageState`; it does not
store credentials in code.

## Trace, Metrics, And Safety Report

Runs write diagnostic outputs under `output/`. The explicit safety report
command adds `safety-report.json` for a selected run:

```text
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/traces/<sessionId>/run-manifest.json
output/traces/<sessionId>/metrics.json
output/traces/<sessionId>/agent-state.json
output/traces/<sessionId>/safety-report.json
output/traces/<sessionId>/artifacts/page-state-latest.json
output/traces/<sessionId>/artifacts/form-state-latest.json
```

Generate a safety report:

```bash
cd packages/web-buddy
npm run report:safety
npm run report:safety -- --run-id <runId>
npm run report:safety -- --trace-dir ../../output/traces/<sessionId>
```

`safety-report.json` summarizes final status, final submit attempts, blocked
final submit, login/captcha handoffs, high-risk action count, policy gate count,
and policy codes.

Important boundary: trace, metrics, screenshots, reports, and latest artifacts
are observability outputs. Runtime, context, policy, tool execution, and
workflow code must not read them back as the source of runtime state. The safety
report and metrics scripts may read trace artifacts because they are offline
diagnostic tools.

## Raw Mode Compatibility

Raw mode exists for comparison and advanced experimentation where an LLM drives
the browser more directly. Its `auto_confirm` behavior is a compatibility path,
not the recommended default safety posture. Use guarded modes for normal demos
and user-facing workflows.

Raw mode still records policy decisions and should not be used to claim that the
runtime can safely automate arbitrary sites end to end.

## What The Runtime Never Does

- It never promises arbitrary-site, arbitrary-task full automation.
- It never bypasses login, captcha, verification, or account ownership checks.
- It never treats trace artifacts as runtime state.
- It never uses safety reports as policy input during the same run.
- It never final-submits real external workflows without a human boundary.
- It never commits user secrets, cookies, raw resumes, or verification codes.

## Known Limitations

- Policy is an MVP boundary, not a complete formal policy DSL.
- Workflow state is a working set, not Phase 6 `WorkflowEngine`.
- Site-specific skill overlays are not implemented yet.
- Some high-risk UI labels are heuristic and must be validated by benchmarks and
  trace review.
- `npx tsc --noEmit` may still expose pre-existing type issues in paths outside
  the current build contract; `npm run build` and `npm run test:mvp` are the MVP
  verification entry points.
