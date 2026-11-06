import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { runWithFetchMock } from "../hyperion/fetch-mock.mjs";
import { cleanEnv, cleanupTempDirs, installStubs, makeTempDir, scriptPath, setStubPlan, writeFile } from "./test-support/ci-fixture.mjs";

const report = scriptPath("report-pr-guard-check.mjs");
let route;

before(() => {
  route = writeFile(
    makeTempDir("hyperion-report-route-"),
    "route.mjs",
    `export default (req) => {
  if (req.method !== "POST" || req.url !== "https://api.github.com/repos/acme/app/check-runs") return undefined;
  if (process.env.ROUTE_FAIL) return new Response("boom", { status: 500 });
  return { id: 1 };
};
`
  );
});

after(cleanupTempDirs);

/** Replace (not merge) the inherited env: unset every host var, then apply the clean test env. */
function isolatedEnv(extra) {
  return { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), ...cleanEnv(extra) };
}

function run(args, { env = {}, guardExit = 0 } = {}) {
  const ws = makeTempDir("hyperion-report-ws-");
  installStubs(ws, ["pr-board-guard.mjs"]);
  setStubPlan(ws, { "pr-board-guard.mjs": [{ exit: guardExit }] });
  return runWithFetchMock(report, args, { cwd: ws, route, env: isolatedEnv(env) });
}

test("requires a head sha", () => {
  const r = run([], { env: { GITHUB_TOKEN: "tok" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--head-sha or CARDS_PR_HEAD_SHA required/);
  assert.equal(r.calls.length, 0);
});

test("requires a token", () => {
  const r = run(["--head-sha", "abc"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_TOKEN required/);
});

test("rejects a malformed GITHUB_REPOSITORY", () => {
  const r = run(["--head-sha", "abc"], { env: { GITHUB_TOKEN: "tok", GITHUB_REPOSITORY: "no-slash" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[report-check\] FATAL ERROR/);
  assert.match(r.stderr, /GITHUB_REPOSITORY required \(owner\/repo\)/);
});

test("passing guard posts a success check run with the guard's base ref + strict git", () => {
  const r = run(["--head-sha", "abcdef1234567", "--base-sha", "base123"], {
    env: { GITHUB_TOKEN: "tok", CARDS_PR_CHECK_NAME: "my-check" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STUB pr-board-guard\.mjs#1 .* BASE=base123 GITHUB_BASE_SHA=base123 STRICT=true/);
  assert.match(r.stdout, /Posted check "my-check" → success on abcdef1/);
  assert.equal(r.calls.length, 1);
  const [call] = r.calls;
  assert.equal(call.headers.Authorization, "Bearer tok");
  assert.equal(call.body.name, "my-check");
  assert.equal(call.body.head_sha, "abcdef1234567");
  assert.equal(call.body.status, "completed");
  assert.equal(call.body.conclusion, "success");
  assert.equal(call.body.output.title, "Board guard passed");
  assert.match(call.body.output.summary, /no external drift/);
});

test("failing guard posts a failure check run and propagates the guard's exit code", () => {
  const r = run([], {
    env: { CARDS_PR_HEAD_SHA: "fff0000", GH_TOKEN: "gh-tok", CARDS_CI_STRICT_GIT: "false" },
    guardExit: 1,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /BASE= GITHUB_BASE_SHA= STRICT=false/);
  assert.match(r.stdout, /Posted check "board-guard" → failure on fff0000/);
  const [call] = r.calls;
  assert.equal(call.headers.Authorization, "Bearer gh-tok");
  assert.equal(call.body.conclusion, "failure");
  assert.equal(call.body.output.title, "Board drift detected");
  assert.match(call.body.output.summary, /cards:reverse/);
});

test("Check Runs API errors are fatal", () => {
  const r = run(["--head-sha", "abc"], { env: { GITHUB_TOKEN: "tok", ROUTE_FAIL: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Check run API failed \(500\): boom/);
});
