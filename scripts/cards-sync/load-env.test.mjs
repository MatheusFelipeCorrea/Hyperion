import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isAllowedKey, loadLocalEnv, parseDotenv, shouldAutoLoad } from "./load-env.mjs";

const dir = mkdtempSync(join(tmpdir(), "hyperion-env-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("loadLocalEnv reads .env.local over .env and never overrides what is set", () => {
  writeFileSync(join(dir, ".env"), "PROJECT_NUMBER=7\nPROJECT_OWNER=from-env\n# comment\nPROJECT_SYNC_TOKEN=ghp_env\n");
  writeFileSync(join(dir, ".env.local"), "PROJECT_NUMBER=42\n");
  const env = { PROJECT_SYNC_TOKEN: "already-set" };

  const loaded = loadLocalEnv(dir, env);

  assert.equal(env.PROJECT_NUMBER, "42");
  assert.equal(env.PROJECT_OWNER, "from-env");
  assert.equal(env.PROJECT_SYNC_TOKEN, "already-set");
  assert.deepEqual(loaded.sort(), ["PROJECT_NUMBER", "PROJECT_OWNER"]);
});

test("loadLocalEnv only loads keys Hyperion reads, never the product's own settings", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperion-env-allow-"));
  try {
    writeFileSync(
      join(root, ".env"),
      [
        "DATABASE_URL=postgres://secret",
        "NODE_OPTIONS=--require ./evil.js",
        "PATH=/tmp",
        "GITHUB_TOKEN=ghp_x",
        "JIRA_API_TOKEN=jira",
        "CARDS_SYNC_BACKEND=jira",
        "HYPERION_TELEMETRY=true",
      ].join("\n")
    );
    const env = { PATH: "/usr/bin" };
    const loaded = loadLocalEnv(root, env);
    assert.deepEqual(loaded.sort(), ["CARDS_SYNC_BACKEND", "GITHUB_TOKEN", "HYPERION_TELEMETRY", "JIRA_API_TOKEN"]);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.PATH, "/usr/bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isAllowedKey covers the card-sync backends and rejects everything else", () => {
  for (const key of ["GH_TOKEN", "PROJECT_NUMBER", "LINEAR_API_TOKEN", "AZDO_PAT", "AZURE_DEVOPS_EXT_PAT", "GITLAB_TOKEN", "CARDS_CI_STRICT_GIT"]) {
    assert.ok(isAllowedKey(key), key);
  }
  for (const key of ["DATABASE_URL", "NODE_OPTIONS", "AWS_SECRET_ACCESS_KEY", "github_token"]) {
    assert.ok(!isAllowedKey(key), key);
  }
});

test("loadLocalEnv is a no-op without env files", () => {
  const empty = mkdtempSync(join(tmpdir(), "hyperion-env-empty-"));
  try {
    const env = {};
    assert.deepEqual(loadLocalEnv(empty, env), []);
    assert.deepEqual(env, {});
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("parseDotenv (fallback for Node < 20.12) handles comments, export, quotes and CRLF", () => {
  const parsed = parseDotenv(
    [
      "# comment",
      "",
      "PROJECT_NUMBER=7",
      "export PROJECT_OWNER=acme",
      'JIRA_URL="https://x.atlassian.net" # trailing',
      "JIRA_EMAIL='me@x.com'",
      "GITLAB_TOKEN=glpat-1 # inline comment",
      'CARDS_MSG="a\\nb"',
      "not a pair",
      "EMPTY=",
    ].join("\r\n")
  );
  assert.deepEqual(parsed, {
    PROJECT_NUMBER: "7",
    PROJECT_OWNER: "acme",
    JIRA_URL: "https://x.atlassian.net",
    JIRA_EMAIL: "me@x.com",
    GITLAB_TOKEN: "glpat-1",
    CARDS_MSG: "a\nb",
    EMPTY: "",
  });
});

test("loadLocalEnv works with the fallback parser and strips a UTF-8 BOM", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperion-env-bom-"));
  try {
    writeFileSync(join(root, ".env"), "\uFEFFPROJECT_NUMBER=9\n");
    const env = {};
    assert.deepEqual(loadLocalEnv(root, env, { parse: parseDotenv }), ["PROJECT_NUMBER"]);
    assert.equal(env.PROJECT_NUMBER, "9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldAutoLoad: only for a cards entry script, never in CI or with HYPERION_NO_DOTENV=1", () => {
  const entry = join("repo", "scripts", "cards-sync", "sync.mjs");
  assert.equal(shouldAutoLoad(entry, {}), true);
  assert.equal(shouldAutoLoad(join("repo", "scripts", "cards-sync", "doctor.mjs"), {}), true);
  assert.equal(shouldAutoLoad(entry, { CI: "true" }), false);
  assert.equal(shouldAutoLoad(entry, { HYPERION_NO_DOTENV: "1" }), false);
  assert.equal(shouldAutoLoad(join("repo", "scripts", "cards-sync", "sync.test.mjs"), {}), false, "a test file");
  assert.equal(shouldAutoLoad(join("repo", "scripts", "cards-sync", "validate.mjs"), {}), false, "not a cards entry script");
  assert.equal(shouldAutoLoad(join("repo", "other", "sync.mjs"), {}), false, "same name elsewhere");
  assert.equal(shouldAutoLoad(undefined, {}), false);
});

test("importing load-env loads .env only when a cards entry script is the process entry point", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperion-env-import-"));
  try {
    writeFileSync(join(root, ".env"), "PROJECT_NUMBER=5\n");
    const loadEnvUrl = new URL("./load-env.mjs", import.meta.url).href;
    const probeSource = `await import(${JSON.stringify(loadEnvUrl)});\nconsole.log(process.env.PROJECT_NUMBER ?? "unset");\n`;
    mkdirSync(join(root, "cards-sync"));
    writeFileSync(join(root, "cards-sync", "sync.mjs"), probeSource);
    writeFileSync(join(root, "cards-sync", "probe.mjs"), probeSource);
    const env = { ...process.env, CI: "", HYPERION_NO_DOTENV: "" };
    delete env.PROJECT_NUMBER;
    const probe = (file) => spawnSync(process.execPath, [join(root, "cards-sync", file)], { cwd: root, encoding: "utf8", env });

    const entry = probe("sync.mjs");
    assert.equal(entry.stdout.trim(), "5", entry.stderr);
    const other = probe("probe.mjs");
    assert.equal(other.stdout.trim(), "unset", other.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
