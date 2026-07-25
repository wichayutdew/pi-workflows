# Development And Testing

## Check Pipeline

```mermaid
flowchart LR
  Install[bun install] --> Check[bun run check]
  Check --> Typecheck[tsc --noEmit]
  Typecheck --> Tests[bun run test:coverage]
  Tests --> Coverage[100% lines, functions, statements<br/>plus src manifest check]
  Coverage --> E2E[bun run test:e2e<br/>real Pi RPC /work]
  E2E --> Build[bun run build]
```

## Test Coverage Map

```mermaid
flowchart TD
  Tests[test/*.test.ts]
  Tests --> Config[test/config.test.ts<br/>YAML loading, validation, ceilings]
  Tests --> Engine[test/engine.test.ts<br/>state, transitions, gates]
  Tests --> Policy[test/policy.test.ts<br/>Bash, MCP, tool selection]
  Tests --> Approved[test/approved-commands.test.ts<br/>reviewed exact-command filtering]
  Tests --> Protocol[test/subagent-protocol.test.ts<br/>policy envelope, result validation]
  Tests --> Client[test/subagent-client.test.ts<br/>events, timeout, cancellation]
  Tests --> Child[test/subagent-child-runtime.test.ts<br/>runtime enforcement]
  Tests --> Harness[test/harness-subagent.test.ts<br/>main, delegation, pause/resume, gates]
  Tests --> E2E[test/e2e/workflow-runtime.test.ts<br/>real Pi RPC /work flow and actual profiles]
  Tests --> Misc[checkpoint, completion batch, immutable input, queue, examples, extension, preflight, Plannotator]
```

Reviewed command fixtures include an absolute `repositories[].cwd`. Harness
tests verify existing-target launch, reviewed-source bootstrap for a missing
target, and fail-closed malformed or ambiguous paths. Child-runtime tests
confine edits and writes to the reviewed target while exact command tests reject
any unreviewed Bash string.

## Where To Change Code

```mermaid
flowchart TD
  Change[Change request] --> Kind{What changes?}
  Kind -- workflow config field --> Config[schemas/workflow.schema.json<br/>src/config/types.ts<br/>src/config/validate.ts<br/>tests/config.test.ts]
  Kind -- run state or transition --> Engine[src/engine/*<br/>tests/engine.test.ts]
  Kind -- step permission --> Policy[src/policy/*<br/>main and child runtime tests]
  Kind -- subagent transport --> Subagent[src/integrations/subagents/*<br/>src/harness.ts<br/>subagent tests]
  Kind -- review provider --> Review[src/integrations/*<br/>src/harness.ts<br/>src/engine/*<br/>integration tests]
  Kind -- command surface --> Commands[src/commands.ts<br/>src/harness.ts<br/>extension or harness tests]
```

## Mutation Safety Pattern

```mermaid
sequenceDiagram
  participant Command as slash command
  participant Event as async event
  participant Queue as SerialTaskQueue
  participant Harness as WorkflowHarness
  participant State as WorkflowRun checkpoint

  Command->>Queue: enqueue mutation
  Event->>Queue: enqueue mutation
  Queue->>Harness: run first mutation
  Harness->>State: append checkpoint
  Queue->>Harness: run next mutation
  Harness->>State: append checkpoint
```

## Local Pi Smoke Test

```mermaid
flowchart TD
  Check[bun run check] --> Install[pi install /absolute/path/to/pi-workflows]
  Install --> Reload["/reload"]
  Reload --> WorkflowReload["/workflow-reload"]
  WorkflowReload --> List["/workflow-list"]
  List --> Start["/workflow-start mr-comments input"]
  Start --> Doctor{delegated step cannot start?}
  Doctor -- yes --> SubDoctor["/subagents-doctor"]
  Doctor -- no --> Done[workflow running]
```
