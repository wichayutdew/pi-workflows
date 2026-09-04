Push the verified branch and open or update the PR/MR. Prefer MCP over CLI.

Request: `{{workflow.input}}`
Approved plan: `{{reviewed.artifact}}`

Derive host, repository, and target from observed `origin`. Validate the approved Conventional Commit title first. Push only with non-force `git push --set-upstream origin <sourceBranch>`.

Use GitHub MCP (`pull_request_read`, `create_pull_request`, `update_pull_request`) or GitLab MCP. Use `gh`/`glab` only when MCP cannot do the job, and record why.

New review: fill only a verified repository or host description template. Never invent a free-form body. If no template is verified, create it with no description adjustment; read back its description and treat that exact body as the template before updating the managed region.

Existing open review: title is immutable. Change only the interior of one matching pair:

<!-- ai-only-start -->
<!-- ai-only-end -->

No markers: append one pair. Mixed, duplicated, or malformed markers: `blocked`. Never replace the whole body. Never approve, merge, or close.

`published`: push plus permitted create/update.
`retry`: transient failure before mutation.
`blocked`: unsafe or ambiguous state.
