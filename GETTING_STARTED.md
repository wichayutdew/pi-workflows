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

## 2. Install the starter integrations

The starter workflows use Pi Subagents profiles and Plannotator approval gates:

```bash
pi install npm:pi-subagents
pi install npm:@plannotator/pi-extension
```

The kit selects the `scout`, `planner`, `worker`, and `reviewer` profiles.
Change those names in the workflow files if your Pi Subagents setup uses
different profiles.

## 3. Copy the four starter workflows

Copy the workflow definitions and all referenced prompt files into your user
workflow directory:

```bash
mkdir -p ~/.pi/agent/workflows
cp examples/starter-kit/*.workflow.yaml ~/.pi/agent/workflows/
cp -R examples/starter-kit/steps ~/.pi/agent/workflows/
```

Review and merge files if that directory already contains workflows; do not
blindly overwrite your existing configuration.

The copy provides these commands:

| Command       | Workflow                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------- |
| `/work`       | Prepare a dedicated worktree, approve a plan, implement a local change, and verify it.    |
| `/ticket`     | Prepare a dedicated worktree, read a ticket, approve a plan, implement it, and verify it. |
| `/mr-review`  | Fetch, approve, publish, and verify a hosted merge-request or pull-request review.        |
| `/mr-comment` | Fetch review comments, approve fixes, implement, verify, push, and reply.                 |

## 4. Tailor the starter kit

Before using a workflow, make its authority explicit for your environment:

1. Set `workspace.allowedRoots` in `work.workflow.yaml` and
   `ticket.workflow.yaml` to safe relative directories where a worktree may be
   created or reused.
2. Configure or replace the `atlassian`, `gitlab`, and `github` MCP selectors.
   The MR workflows can use their configured GitHub/GitLab CLIs or cURL
   fallbacks; the ticket workflow requires Atlassian MCP by default.
3. Review every prompt and unrestricted Bash permission before allowing it to
   run against a repository.

## 5. Reload, validate, and run

Reload Pi and validate every copied workflow before the first execution:

```text
/reload
/workflow-reload
/workflow-doctor work
/workflow-doctor ticket
/workflow-doctor mr-review
/workflow-doctor mr-comment
```

Start from the repository checkout that should supply the source workspace:

```text
/work update the navigation
/ticket PROJ-123 retry failed requests
/mr-review https://gitlab.example.com/group/project/-/merge_requests/42
/mr-comment https://github.com/example/project/pull/42
```

After a completed `/work` or `/ticket` run, use
`/workflow-restart <next enhancement>` to continue in the same prepared
worktree.

For workflow contracts, permissions, architecture, and integrations, continue
to the [OpenWiki documentation](./openwiki/quickstart.md).
