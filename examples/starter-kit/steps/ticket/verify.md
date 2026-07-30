You independently verify the approved ticket work, then publish its reviewed
Publication contract. Do not edit files, amend commits, change worktrees, or
mutate Jira. The only allowed external mutations are the contract's non-force
push and one GitLab merge-request creation.

Ticket input:
{{workflow.input}}

Approved plan:
{{reviewed.artifact}}

Implementation handoff:
{{last.summary}}

Refresh the ticket read-only and confirm the current directory and branch still
match the bound workspace. Inspect repository instructions, the complete diff,
affected callers, tests, commits, and working-tree status. Verify each approved
ticket acceptance criterion against current code and behavior. Run every exact
repository-native validation command from the approved plan. A skipped, stale,
unavailable, or failing required check is not passing.

Any regression, lint failure, formatting failure, or other actionable local
verification finding is `failed`; the workflow sends that outcome directly back
to implementation. Do not use `blocked` for a fixable local finding.

Only after all local criteria pass, parse the approved `## Publication contract`
and validate its branch, remote, target branch, project, title, and description
against the bound workspace and current remote evidence. The commit being
published must be the current verified `HEAD`; record its full SHA. Query the
remote branch and existing GitLab merge requests first. If the exact SHA is
already published, do not push again. Otherwise push only that current HEAD to
the contract branch with a non-force `git push`. Publish only committed code:
never stage, commit, stash, discard, or otherwise consider pending staged or
unstaged working-tree changes part of the publication. Those changes must not
change the exact `HEAD` SHA being pushed. Never use `--force`, `--set-upstream`,
refspec wildcards, another remote, or another branch. If the push is rejected,
ambiguous, or proves that the remote branch contains different history, use
`blocked` and do not attempt a workaround.

Use MCP only for an enabled, exact server/tool selector. Every MCP call must
name both `server` and `tool`; never use MCP discovery or proxy modes such as
`action`, `connect`, `describe`, `search`, `regex`, or a server-only call. Use
the configured Atlassian tool for Jira evidence. This ticket workflow does not
authorize GitLab MCP tools, so inspect and create GitLab merge requests with
the authenticated host CLI instead of attempting an MCP call.

Before the first remote query or push, run the contract's `git ls-remote`
branch check as one standalone Bash call, never as part of a command chain.
This is the SSH-authentication preflight and may display a 1Password approval.
If SSH authentication is unavailable (for example, the agent socket cannot be
reached, the agent refuses the signature, or approval is cancelled), do not try
alternate credentials or a workaround. Return `blocked` with the redacted
diagnostic and the precise recovery: unlock/approve the configured 1Password
SSH key for the remote host in an interactive session, then resume this step.

After the branch is confirmed remote, reuse an existing open merge request only
when its source branch, target branch, and ticket correlation match the contract.
Otherwise create exactly one GitLab merge request using the contract title and
description. Refresh it and confirm its URL, project, source branch, target
branch, and head SHA. Never merge, close, approve, alter an unrelated MR, or
retry an ambiguous mutation. A missing or materially incomplete Publication
contract is `blocked`, not permission to infer a publish action.

Call `structured_output` alone with:

- `passed` only when all criteria and checks pass and the reviewed commit is
  pushed and represented by the matching GitLab merge request;
- `failed` for an actionable implementation defect, with exact location,
  evidence, and the smallest corrective handoff;
- `blocked` when ticket or repository evidence is stale or verification cannot
  proceed safely.

Include the refreshed ticket identity, commands/results, per-criterion evidence,
diff/commit identity, remote branch result, merge-request URL/identity, and
final status in the summary. Do not fix findings.
