[![codecov](https://codecov.io/gh/wichayutdew/pi-workflows/graph/badge.svg?token=33xrCBRM82)](https://codecov.io/gh/wichayutdew/pi-workflows)

# Pi Workflows

**Make repeatable Pi agent work explicit, durable, and safe to continue.**

Pi Workflows is a declarative, pauseable workflow harness for Pi. Define steps,
tools, prompts, approvals, and outcomes in YAML; it provides bounded execution,
durable checkpoints, main-session step policy, and a live status view without
dictating your language, framework, or delivery process.

## See it in action

<p align="center">
  <a href="https://raw.githubusercontent.com/wichayutdew/pi-workflows/main/assets/video.mp4">
    <img src="https://raw.githubusercontent.com/wichayutdew/pi-workflows/main/assets/demo.gif" alt="Animated terminal demonstration of a Pi workflow" width="960">
  </a>
</p>

<p align="center"><em>Animated preview — select it to download the full 73-second MP4.</em></p>

## At a glance

| Summary and status                                                                                                                                     | Workflow details                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/wichayutdew/pi-workflows/main/assets/Summary.png" alt="Pi Workflows summary and status view" width="100%"> | <img src="https://raw.githubusercontent.com/wichayutdew/pi-workflows/main/assets/Details.png" alt="Pi Workflows detailed workflow view" width="100%"> |
| See progress, approvals, and outcome at a glance.                                                                                                      | Inspect each workflow step and its execution details.                                                                                                 |

## Why Pi Workflows

- **Declarative & Structured**: Turn multi-step agent tasks into clear, reviewable workflow definitions with predictable transitions.
- **Durable Checkpoints**: Pause for human approval or feedback and resume seamlessly without repeating completed steps.
- **Safe Worktree Iterations**: Keep worktree-bound iterations isolated and carry forward verified changes for follow-up enhancements.
- **Resource & Loop Guarding**: Enforce strict tool and Bash allowlists and halt runaway loops before they exceed step limits.
- **Role Profiles**: Assign workflow-owned roles (`scout`, `planner`, `worker`, `reviewer`) with custom model and thinking overrides.
- **Live Terminal UI**: Interactive status board, execution path visualization, step transcript inspection, and real-time cost ledger.

## Quick Installation

Install the published extension in Pi:

```bash
pi install npm:@wichayutdew/pi-workflows
```

## Herdr workflow status

When Pi runs delegated workflow steps, the parent agent may be idle while child work continues. Pi Workflows includes a Herdr companion extension that reports workflow lifecycle state so the pane remains **working** until the workflow completes, pauses, or is interrupted.

The companion is inactive unless Herdr provides `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. It uses Herdr's existing managed Pi reporter, so it does not create a competing pane agent.

### Reapply after a Herdr update

Herdr manages `~/.pi/agent/extensions/herdr-agent-state.ts`; an integration update can replace the workflow lifecycle patch. Locate the installed package with `pi list`, change into that package directory, and run:

```bash
npm run patch:herdr
```

The script patches the managed integration at its default location. It is idempotent, so it is safe to run after every Herdr update. To patch a non-default integration path, set `HERDR_PI_EXTENSION_PATH` before running the script:

```bash
HERDR_PI_EXTENSION_PATH=/path/to/herdr-agent-state.ts npm run patch:herdr
```

Restart Pi or run `/reload` after patching. If Herdr's managed extension changes shape and the script reports an unsupported layout, do not edit it manually; update Pi Workflows or report the integration change.

## Explore

- [Getting started guide](./GETTING_STARTED.md) — install Pi Workflows and run your first workflow.
- [Contribution guide](./CONTRIBUTING.md) — development setup, code conventions, test layers, and validation pipeline.
- [Documentation → OpenWiki](./openwiki/quickstart.md) — architecture, workflow authoring, security, integrations, and development references.

## License

[MIT](./LICENSE)
