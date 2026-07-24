import assert from "node:assert/strict";
import test from "node:test";
import { hasRuntimeCommandConflict } from "../src/config/command-conflicts.ts";

test("detects commands owned by another loaded resource", () => {
  assert.equal(
    hasRuntimeCommandConflict("fix", [{ name: "fix" }], new Set()),
    true,
  );
  assert.equal(
    hasRuntimeCommandConflict(
      "fix",
      [{ name: "fix:1" }, { name: "fix:2" }],
      new Set(["fix"]),
    ),
    true,
  );
});

test("allows this harness to refresh its own workflow alias", () => {
  assert.equal(
    hasRuntimeCommandConflict("fix", [{ name: "fix" }], new Set(["fix"])),
    false,
  );
});
