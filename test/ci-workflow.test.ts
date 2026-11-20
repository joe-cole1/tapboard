import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/rebuild-guardrails.yml", import.meta.url),
  "utf8",
);

// The `main` ruleset requires these jobs, and PRs land through a merge queue. The queue only
// merges once each required job reports on its `merge_group` run.
const requiredJobs = ["check", "e2e", "production-container"];

function topLevelBlock(name: string): string {
  const match = new RegExp(`^${name}:\\n((?:[ #].*\\n|\\n)*)`, "m").exec(workflow);
  assert.ok(match, `workflow has a top-level ${name}: block`);
  return match[1] ?? "";
}

void test("CI runs on pull requests and on the merge queue's merge groups", () => {
  const triggers = topLevelBlock("on")
    .split("\n")
    .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
    .filter((trigger) => trigger !== undefined);
  assert.ok(triggers.includes("pull_request"));
  assert.ok(triggers.includes("merge_group"));
});

void test("every required job runs for every trigger", () => {
  const jobs = topLevelBlock("jobs");
  for (const job of requiredJobs) {
    const body = new RegExp(`^ {2}${job}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(jobs)?.[1];
    assert.ok(body !== undefined, `workflow defines the ${job} job`);
    assert.doesNotMatch(body, /^ {4}if:/m, `${job} has no job-level condition that could skip it`);
  }
});
