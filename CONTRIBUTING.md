# Contributing to Pi Workflows

Thanks for helping make Pi Workflows more dependable.

## Development setup

Install the repository dependencies with Bun, then run the complete local check before opening a pull request:

```bash
bun install
bun run check
```

The project requires Node.js 22.19 or later and uses Bun 1.4.0.

`bun run check` validates:
- Linting (`bun run lint`)
- Formatting (`bun run format:check`)
- Type checking (`bun run typecheck`)
- Test coverage with strict 90% line and function thresholds (`bun run test:coverage`)
- End-to-end direct-worker execution (`bun run test:e2e`)
- Production bundling (`bun run build`)

## Architecture & Codebase Conventions

Pi Workflows follows a strict **purely functional architecture** partitioned into four explicit layers:

### 1. `src/domain/` (Domain Models & Schemas)
- Contains canonical data structures, schemas, entities, state invariants, and contracts.
- Includes `config.ts`, `state.ts`, `step-result.ts`, `policy.ts`, `subagent.ts`, `plannotator.ts`, `status.ts`, `harness.ts`, and `profile.ts`.
- Pure types and domain invariants only. No I/O, no process execution, no side-effects.

### 2. `src/function/` (Pure Functions)
- Contains deterministic business logic and transformations with zero side-effects.
- Subdirectories:
  - `engine/`: Immutable state transitions (`createRun`, `advanceRun`, `pauseRun`, `resumeRun`, `abortRun`, `reconcileRun`, `step-trace`, `usage`).
  - `config/`: Validation schemas, ceiling enforcement, conflict detection, and step digests.
  - `policy/`: Tool call and Bash command authorization and tokenization.
  - `prompt/`: Template rendering and step contract prompt generation.
  - `step-result/`: Output parsing and artifact contract verification.
  - `doctor/`: Graph analysis and cycle/liveness diagnostics.
  - `preflight/`: Prerequisite requirement validation.
  - `subagent/`: Protocol envelope encoding/decoding and safety diagnostics.
- Functions must be pure, synchronous where possible, and referentially transparent.

### 3. `src/infrastructure/` (Adapters & Orchestration)
- Handles side effects, external I/O, process execution, and host integration.
- Subdirectories:
  - `fs/`: Filesystem access, settings and workflow YAML loading, session persistence, and transcript reading.
  - `process/`: Direct Pi worker child process spawner and client.
  - `integrations/`: Plannotator client, interactive prompt gate UI, and Herdr socket reporter.
  - `runtime/`: Main step turn loop and completion handling (`createMainStepRuntime`), serial task queue (`createSerialTaskQueue`), and child runtime policy enforcement.
  - `harness/`: Harness composer (`createWorkflowHarness`), slash commands, and action handlers.
  - `agents/`: Agent role profile file resolution.

### 4. `src/ui/` (Terminal UI & Views)
- Terminal presentation, layout math, ANSI formatting, and TUI components.
- Includes `view.ts` (`createWorkflowStatusView`), board and detail rendering, usage summaries, and step log sanitization.

### Class-Free Paradigm
- Favor closures, factory functions (`create*`), and immutable records over stateful classes.
- Public class facades (such as `WorkflowHarness` and `WorkflowStatusView`) are thin, delegating wrappers maintained solely for backward compatibility with external consumers and TUI interfaces.

## Test Organization

Tests in `test/` mirror the source structure:
- `test/domain/`: Domain invariants, sanitization rules, and configuration limits.
- `test/function/`: Unit tests for pure engine transitions, policy checks, prompt templates, and graph analysis.
- `test/infrastructure/`: Integration tests for filesystem operations, harness actions, process spawning, and runtimes.
- `test/ui/`: Tests for status board layout, text formatting, and interactive TUI components.
- `test/e2e/`: Full end-to-end integration tests running isolated Pi processes.
- `test/fixtures/` & `test/helpers.ts`: Shared test values and mock factories.

## Making a change

Keep each pull request focused:
1. Update the implementation, tests, and documentation together when a behavior or public contract changes.
2. Put domain types in `src/domain/`, pure logic in `src/function/`, I/O and adapters in `src/infrastructure/`, and view formatting in `src/ui/`.
3. Place tests in the corresponding `test/<layer>/` directory.
4. Ensure all unit and integration tests pass and test coverage remains ≥ 90.00%.
5. Preserve existing checkpoints and recovery semantics: workflow safety, bounded execution, and durable recovery are core guarantees.

Relevant references:
- [Development and testing](./openwiki/development/testing.md)
- [Architecture overview](./openwiki/architecture/overview.md)
- [Workflow authoring](./openwiki/authoring/workflow-files.md)
- [Security policy model](./openwiki/security/policy-model.md)

## Pull requests

Describe the behavior change, include the verification you ran (`bun run check`), and note any compatibility or safety considerations.
