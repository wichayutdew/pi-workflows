# Get Started with Pi Workflows

This guide installs Pi Workflows and bootstraps the four ready-to-customize
workflows in [`examples/starter-kit`](./examples/starter-kit).

## 1. Install Pi Workflows

Install the published extension in Pi:

```bash
pi install npm:@wichayutdew/pi-workflows
```

Clone or download this repository to get the starter-kit files. For example:

```bash
git clone https://github.com/wichayutdew/pi-workflows.git
cd pi-workflows
```

The remaining commands assume your shell is at the repository root.

## 2. Install the approval integration

The starter workflows use built-in role prompts and Plannotator approval gates:

```bash
pi install npm:@plannotator/pi-extension
```

The kit selects the `scout`, `planner`, `worker`, `reviewer`, and `workspace-preparer` role prompts.
Set each step's `agent` field to a different role when needed. To customize a
role, create `~/.agents/agents/<role>.md`; user profiles override the bundled
prompt fallback.

An agent profile may optionally begin with YAML frontmatter. Its user-owned
`model` and `thinking` values apply only to Pi workers launched for that
profile:

```markdown
---
model: provider/model-id
thinking: high
---

Role instructions for this agent.
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. Omit `model` to use the current Pi default. Pi validates the model name
against its configured catalog when the worker starts.

## 3. Copy the starter workflows

Copy the workflow definitions and all referenced prompt files into your user
workflow directory:

```bash
mkdir -p ~/.pi/agent/workflows ~/.agents/agents
cp examples/starter-kit/*.workflow.yaml ~/.pi/agent/workflows/
cp -R examples/starter-kit/steps ~/.pi/agent/workflows/
cp examples/starter-kit/agents/*.md ~/.agents/agents/
```

Review and merge files if that directory already contains workflows; do not
blindly overwrite your existing configuration.

The copy provides these commands:

| Command | Workflow |
| --- | --- |
| `/work` | Prepare a dedicated worktree, approve a plan, implement a local change, and verify it. |

## 4. Tailor the starter kit

Before using a workflow, make its authority explicit for your environment:

1. Set `workspace.allowedRoots` in `work.workflow.yaml` to safe directories where a worktree may be created
   or reused. Roots may be relative to the run-start directory, absolute, or
   home-relative (for example, `~/repositories/worktrees`).
2. Configure or replace issue-tracker, forge, code-search, and observability integrations for your environment. No endpoint, organization, or credential is bundled.
3. Review every prompt and unrestricted Bash permission before allowing it to run against a repository.

## 5. Reload, validate, and run

Reload Pi and validate every copied workflow before the first execution:

```text
/reload
/workflow-reload
/workflow-doctor work
```

Start from the repository checkout that should supply the source workspace:

```text
/work update the navigation
```

After a completed `/work` run, use
`/workflow-restart <next enhancement>` to continue in the same prepared
worktree.

For workflow contracts, permissions, architecture, and integrations, continue
to the [OpenWiki documentation](./openwiki/quickstart.md).
