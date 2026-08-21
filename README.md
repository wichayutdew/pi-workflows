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

- Turn multi-step agent work into clear, reviewable workflow definitions.
- Pause for human approval and resume from the same durable checkpoint.
- Keep worktree-bound iterations safe, including follow-up enhancements.
- Enforce declared resources and stop unsafe loops before they run away.
- Assign a workflow-owned role prompt with `agent: planner`, `worker`,
  `reviewer`, or `scout`; customize profiles under your user workflow
  directory's `agents/` folder.

## Herdr workflow status

When Pi runs delegated workflow steps, the parent agent may be idle while child work continues. Pi Workflows includes a Herdr companion extension that reports workflow lifecycle state so the pane remains **working** until the workflow completes, pauses, or is interrupted.

The companion is inactive unless Herdr provides `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. It uses Herdr's existing managed Pi reporter, so it does not create a competing pane agent.

### Install from npm

```bash
pi install npm:@wichayutdew/pi-workflows
```

Start a new Pi session in Herdr, then run a workflow normally. Herdr should show the pane as working while the workflow is active and display the terminal workflow message after completion or interruption.

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

- [Getting started guide](./GETTING_STARTED.md) — install Pi Workflows and
  run your first workflow.
- [Contribution guide](./CONTRIBUTING.md) — set up the project, validate a
  change, and open a focused pull request.
- [Documentation → OpenWiki](./openwiki/quickstart.md) — architecture,
  workflow authoring, security, integrations, and development references.

## License

[MIT](./LICENSE)
