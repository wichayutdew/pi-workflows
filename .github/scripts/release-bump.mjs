import { appendFileSync } from "node:fs";

const title = process.env.PR_TITLE ?? "";
const body = process.env.PR_BODY ?? "";
const conventionalCommit = /^(?<type>[a-z]+)(?:\([^)]+\))?(?<breaking>!)?:\s+.+$/;
const match = title.match(conventionalCommit);
const hasBreakingChange = match?.groups?.breaking === "!" || /(^|\n)BREAKING CHANGE:\s/.test(body);

let bump = "";
if (hasBreakingChange) {
  bump = "major";
} else if (match?.groups?.type === "feat") {
  bump = "minor";
} else if (["fix", "perf"].includes(match?.groups?.type ?? "")) {
  bump = "patch";
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `bump=${bump}\n`);
}

if (process.env.REQUIRE_BUMP === "true" && !bump) {
  console.error(
    "PR title must use Conventional Commits: feat: for a minor release, fix: or perf: for a patch release, or append ! (or use BREAKING CHANGE: in the body) for a major release.",
  );
  process.exit(1);
}
