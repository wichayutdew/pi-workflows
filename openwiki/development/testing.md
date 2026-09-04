# Development And Testing

## Check Pipeline

```mermaid
flowchart LR
  Install[bun install] --> Check[bun run check]
  Check --> Typecheck[tsc --noEmit]
  Typecheck --> Tests[bun run test:coverage]
  Tests --> Coverage[aggregate LCOV lines and functions at least 90%]
  Coverage --> E2E[bun run test:e2e<br/>real Pi RPC /work]
  E2E --> Build[bun run build]
```

Ordinary and focused tests use `bunfig.toml` with coverage disabled.
`bun run test:coverage` instead uses `bunfig.coverage.toml`, preserving the 90%
lines, functions, and statements thresholds while writing release evidence to
`coverage/full/lcov.info`. The E2E run also keeps coverage disabled, so neither
focused nor E2E tests can replace that report before CI uploads it to Codecov.

## Test Coverage Map

```mermaid
flowchart TD
  Tests[test/{domain,function,infrastructure,ui}]
  Tests --> Config[test/function/config.test.ts<br/>YAML loading, validation, ceilings]
  Tests --> Engine[test/function/engine.test.ts<br/>state, transitions, gates]
  Tests --> Policy[test/function/policy.test.ts<br/>Bash, MCP, tool selection]
  Tests --> Doctor[test/function/workflow-doctor.test.ts<br/>graph liveness and deterministic diagnostics]
  Tests --> DirectClient[test/infrastructure/direct-worker-client.test.ts<br/>delegation events, timeout, cancellation]
  Tests --> Child[test/infrastructure/subagent-child-runtime.test.ts<br/>runtime enforcement]
  Tests --> Recovery[test/function/delegation-recovery.test.ts<br/>terminal evidence and replay safety]
  Tests --> Harness[test/infrastructure/direct-worker-harness.test.ts<br/>main, delegation, pause/resume, gates]
  Tests --> E2E[test/e2e/direct-worker-runtime.test.ts<br/>real Pi RPC revisit, captured cwd, and actual profiles]
  Tests --> Misc[checkpoint, artifacts, completion batch, immutable input, queue, examples, extension, preflight, Plannotator]
```

Harness tests verify that a run captures its starting absolute cwd and reuses it
across steps, revisits, recovery attempts, and resume. Policy tests treat command
families and argument placement as opaque while enforcing generic tokenization
and the exact executable/argument-prefix rules declared in YAML.

## Where To Change Code

```mermaid
flowchart TD
  Change[Change request] --> Kind{What changes?}
  Kind -- workflow config field --> Config[schemas/workflow.schema.json<br/>src/domain/config.ts<br/>src/function/config/*<br/>test/function/config.test.ts]
  Kind -- run state or transition --> Engine[src/domain/state.ts<br/>src/function/engine/*<br/>test/function/engine.test.ts]
  Kind -- step permission --> Policy[src/domain/policy.ts<br/>src/function/policy/*<br/>main and child runtime tests]
  Kind -- delegated worker transport --> Subagent[src/domain/subagent.ts<br/>src/function/subagent/*<br/>src/infrastructure/*subagent*<br/>direct-worker and child-runtime tests]
  Kind -- review provider --> Review[src/domain/plannotator.ts<br/>src/infrastructure/integrations/*<br/>src/infrastructure/harness/*gate*<br/>integration tests]
  Kind -- command surface --> Commands[src/infrastructure/harness/commands.ts<br/>src/infrastructure/harness/harness.ts<br/>extension or harness tests]
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
  List --> Start["/workflow-start work input"]
  Start --> Doctor{delegated step cannot start?}
  Doctor -- yes --> SubDoctor["/subagents-doctor"]
  Doctor -- no --> Done[workflow running]
```
