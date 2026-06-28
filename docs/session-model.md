# Session Model

Phase 2A adds a file-backed runtime fact source for Web Buddy runs.

```text
output/sessions/<sessionId>/
  session.json
  transcript.jsonl
  events.jsonl
  workflow.json
```

`session.json` stores run identity, source, status, goal, paths, and the related
trace run id. `transcript.jsonl` is append-only and records user goals,
assistant messages, tool calls, tool results, policy decisions, workflow
snapshots, final results, and errors. `events.jsonl` stores realtime
`KernelEvent` records for UI, metrics, and later kernel work. `workflow.json`
contains the latest workflow snapshot for resume-oriented state.

Trace remains an audit surface. Runtime, context, workflow, and session code do
not read `output/traces` to recover state. Deleting trace artifacts must not make
the session transcript unreadable.

Phase 2B adds `AgentKernel` and `QueryLoop` around the existing local loop. The
kernel emits realtime lifecycle events through `onEvent`, but session transcript
and event files are still written by `SessionRecorder` inside `runAgentLoop`.
This keeps the append-only session contract compatible while giving later plans
a single run-control entry point.
