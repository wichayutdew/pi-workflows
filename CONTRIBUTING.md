# Contributing to Pi Workflows

Thanks for helping make Pi Workflows more dependable.

## Development setup

Install the repository dependencies with Bun, then run the complete local
check before opening a pull request:

```bash
bun install
bun run check
```

The project requires Node.js 22.19 or later and uses Bun 1.3.14.

## Making a change

Keep each pull request focused. Update the implementation, tests, and
documentation together when a behavior or public contract changes. Preserve
existing user work and checkpoints: workflow safety, bounded execution, and
durable recovery are core project guarantees.

Use the relevant reference before changing an area:

- [Development and testing](./openwiki/development/testing.md)
- [Architecture overview](./openwiki/architecture/overview.md)
- [Workflow authoring](./openwiki/authoring/workflow-files.md)
- [Security policy model](./openwiki/security/policy-model.md)

## Pull requests

Describe the behavior change, include the verification you ran, and call out
any compatibility, migration, or safety considerations. Keep generated output
out of the change unless it is intentionally versioned.
