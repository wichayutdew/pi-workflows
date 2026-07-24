import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/config/load.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bundled example and schemas are readable", async () => {
  const catalog = await loadCatalog({
    cwd: repositoryRoot,
    projectTrusted: false,
    userDirectory: join(repositoryRoot, "examples"),
  });
  assert.deepEqual(catalog.diagnostics, []);
  assert.equal(catalog.workflows.get("mr-comments")?.definition.command, "mr-comments");

  for (const schema of ["workflow.schema.json", "settings.schema.json"]) {
    const raw = await readFile(join(repositoryRoot, "schemas", schema), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  }

  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { pi?: { subagents?: { agents?: string[] } } };
  assert.deepEqual(packageJson.pi?.subagents?.agents, ["./agents"]);
  assert.match(
    await readFile(join(repositoryRoot, "agents", "step.md"), "utf8"),
    /package: pi-workflows/,
  );
});
