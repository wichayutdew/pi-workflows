[![codecov](https://codecov.io/gh/wichayutdew/pi-workflows/graph/badge.svg?token=33xrCBRM82)](https://codecov.io/gh/wichayutdew/pi-workflows)

# Pi Workflows

**Make repeatable Pi agent work explicit, durable, and safe to continue.**

Pi Workflows is a declarative, pauseable workflow harness for Pi. Define steps,
tools, prompts, approvals, and outcomes in YAML; it provides bounded execution,
durable checkpoints, isolated subagent work, and a live status view without
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

## Explore

- [Getting started guide](./GETTING_STARTED.md) — install Pi Workflows and
  run your first workflow.
- [Contribution guide](./CONTRIBUTING.md) — set up the project, validate a
  change, and open a focused pull request.
- [Documentation → OpenWiki](./openwiki/quickstart.md) — architecture,
  workflow authoring, security, integrations, and development references.

## License

[MIT](./LICENSE)
