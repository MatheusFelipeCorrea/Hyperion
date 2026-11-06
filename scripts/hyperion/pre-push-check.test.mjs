import test from "node:test";
import assert from "node:assert/strict";
import {
  isCodeChange,
  appTouches,
  selectPrePushCommands,
  planPrePush,
  runPrePushCheck,
} from "./pre-push-check.mjs";

test("isCodeChange ignores docs/cards/specs-only pushes", () => {
  assert.equal(isCodeChange([".github/cards/stories/A.md", "README.md"]), false);
  assert.equal(isCodeChange(["src/index.js", "README.md"]), true);
  assert.equal(isCodeChange(["__force_check__"]), true);
});

test("appTouches respects app path prefixes", () => {
  assert.equal(appTouches(".", ["src/a.ts"]), true);
  assert.equal(appTouches("apps/web", ["apps/web/src/x.tsx"]), true);
  assert.equal(appTouches("apps/web", ["apps/api/src/x.ts"]), false);
});

test("selectPrePushCommands: node api gets build+test; web gets typecheck+test", () => {
  const api = selectPrePushCommands({
    stack: "node",
    gates: {
      build: { command: "npm run build" },
      test: { command: "npm test" },
      typecheck: { command: "npx tsc --noEmit" },
    },
  });
  assert.deepEqual(
    api.map((c) => c.name),
    ["build", "test"]
  );

  const web = selectPrePushCommands({
    stack: "node",
    web: { framework: "next" },
    gates: {
      build: { command: "npm run build" },
      test: { command: "npm test" },
      typecheck: { command: "npx tsc --noEmit" },
    },
  });
  assert.deepEqual(
    web.map((c) => c.name),
    ["typecheck", "test"]
  );

  const dotnet = selectPrePushCommands({
    stack: "dotnet",
    gates: {
      build: { command: "dotnet build" },
      test: { command: "dotnet test" },
    },
  });
  assert.deepEqual(
    dotnet.map((c) => c.name),
    ["build", "test"]
  );

  const py = selectPrePushCommands({
    stack: "python",
    gates: { test: { command: "pytest" }, build: { command: "unused" } },
  });
  assert.deepEqual(
    py.map((c) => c.name),
    ["test"]
  );
});

test("planPrePush only includes touched apps with commands", () => {
  const scan = {
    apps: [
      {
        name: "api",
        path: "apps/api",
        stack: "node",
        gates: { build: { command: "npm run build" }, test: { command: "npm test" } },
      },
      {
        name: "web",
        path: "apps/web",
        stack: "node",
        web: { framework: "react" },
        gates: { test: { command: "npm test" }, typecheck: { command: "npx tsc --noEmit" } },
      },
      { name: "tooling", path: "tools", stack: "node", tooling: true, gates: { test: { command: "npm test" } } },
    ],
  };
  const plans = planPrePush("/tmp/repo", ["apps/web/src/App.tsx"], scan);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, "web");
  assert.deepEqual(
    plans[0].commands.map((c) => c.name),
    ["typecheck", "test"]
  );
});

test("SKIP_PREPUSH bypasses", () => {
  const prev = process.env.SKIP_PREPUSH;
  process.env.SKIP_PREPUSH = "1";
  try {
    assert.equal(runPrePushCheck({ root: process.cwd(), stdinText: "" }), 0);
  } finally {
    if (prev === undefined) delete process.env.SKIP_PREPUSH;
    else process.env.SKIP_PREPUSH = prev;
  }
});
