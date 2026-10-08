import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanRepoForGates,
  buildGateQuestions,
  resolveGatePlan,
  gateCommand,
  normalizeMode,
  suggestGatesYaml,
  mergeGateConfig,
  questionStatus,
  estimateCiMinutes,
  lineDiff,
  questionText,
} from "./pipeline-gates.mjs";

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-gates-"));
  write(root, "apps/api/package.json", {
    name: "api",
    scripts: { test: "jest", lint: "eslint .", "format:check": "prettier --check .", format: "prettier --write ." },
    devDependencies: { jest: "^29", eslint: "^9", prettier: "^3", prisma: "^5" },
  });
  write(root, "apps/api/package-lock.json", "{}");
  write(root, "apps/api/prisma/schema.prisma", "datasource db { provider = \"postgresql\" }");
  write(root, "apps/api/docker-compose.yml", [
    "services:",
    "  db:",
    "    image: postgres:16",
    "    healthcheck:",
    "      test: pg_isready",
    "  queue:",
    "    image: rabbitmq:3.13-management",
    "  app:",
    "    build: .",
    "",
  ].join("\n"));
  write(root, "apps/api/Dockerfile", "FROM node:22\n");
  write(root, "apps/web/package.json", {
    name: "web",
    scripts: { test: "vitest", build: "vite build", lint: "eslint .", typecheck: "tsc --noEmit" },
    devDependencies: { vitest: "^2", typescript: "^5", "@playwright/test": "^1" },
  });
  write(root, "apps/web/pnpm-lock.yaml", "");
  write(root, "apps/web/playwright.config.ts", "export default {}");
  write(root, "apps/mobile/pubspec.yaml", "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n");
  write(root, "apps/mobile/lib/main.dart", "void main() {}");
  write(root, "apps/mobile/test/widget_test.dart", "void main() {}");
  write(root, "apps/mobile/android/build.gradle", "plugins {}");
  write(root, "svc/pyproject.toml", "[project]\nname='svc'\ndependencies=['fastapi']\n[project.optional-dependencies]\ndev=['pytest','pytest-cov','ruff','mypy']\n[tool.ruff]\nline-length=100\n");
  write(root, "svc/tests/test_x.py", "def test_x(): pass");
  write(root, "infra/main.tf", "terraform {}");
  write(root, "Hyperion/package.json", { name: "hyperion-kit", scripts: { test: "node --test" } });
  write(root, "node_modules/foo/package.json", { name: "foo", scripts: { test: "x" } });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanRepoForGates", () => {
  it("finds every app across the monorepo, skipping the kit, node_modules and Flutter native folders", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const names = scan.apps.map((a) => `${a.name}:${a.stack}`).sort();
    assert.deepEqual(names, ["api:node", "mobile:flutter", "svc:python", "web:node"]);
  });

  it("detects node gates from scripts and devDependencies (jest coverage, prisma, pm)", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const api = scan.apps.find((a) => a.name === "api");
    assert.equal(api.pm, "npm");
    assert.equal(api.install, "npm ci");
    assert.equal(api.gates.format.command, "npm run format:check");
    assert.equal(api.gates.format.fix, "npm run format");
    assert.match(api.gates.coverage.command, /--coverage --coverageReporters=json-summary/);
    assert.equal(api.gates.coverage.report, "coverage/coverage-summary.json");
    assert.equal(api.gates.migrations.tool, "prisma");
    assert.equal(api.gates.audit.fix, "npm audit fix");
    assert.equal(api.gates.build, null);
  });

  it("flags a missing vitest coverage provider and uses pnpm commands", () => {
    const web = scanRepoForGates(root, { kitRootRel: "Hyperion" }).apps.find((a) => a.name === "web");
    assert.equal(web.pm, "pnpm");
    assert.equal(web.gates.typecheck.command, "pnpm run typecheck");
    assert.equal(web.gates.coverage.needs, "@vitest/coverage-v8");
    assert.match(web.gates.coverage.command, /^pnpm run test --coverage/);
    assert.equal(web.gates.audit.fix, "pnpm audit --fix");
  });

  it("detects python tools from pyproject (ruff lint+format, mypy, pytest-cov)", () => {
    const svc = scanRepoForGates(root, { kitRootRel: "Hyperion" }).apps.find((a) => a.name === "svc");
    assert.equal(svc.gates.lint.command, "ruff check .");
    assert.equal(svc.gates.format.command, "ruff format --check .");
    assert.equal(svc.gates.typecheck.command, "mypy .");
    assert.equal(svc.gates.coverage.report, "coverage.xml");
    assert.equal(svc.gates.coverage.needs, null);
  });

  it("detects flutter format/analyze/coverage", () => {
    const mobile = scanRepoForGates(root, { kitRootRel: "Hyperion" }).apps.find((a) => a.name === "mobile");
    assert.equal(mobile.gates.format.command, "dart format --output=none --set-exit-if-changed lib test");
    assert.equal(mobile.gates.coverage.report, "coverage/lcov.info");
    assert.equal(mobile.gates.audit, null);
  });

  it("detects repo-level docker, compose infra services, e2e and terraform", () => {
    const { repo } = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    assert.deepEqual(repo.dockerfiles.map((d) => d.path), ["apps/api/Dockerfile"]);
    const compose = repo.compose[0];
    assert.equal(compose.path, "apps/api/docker-compose.yml");
    assert.deepEqual(compose.services.map((s) => [s.name, s.infra]), [["db", "postgres"], ["queue", "rabbitmq"], ["app", null]]);
    assert.equal(compose.services[0].healthcheck, true);
    assert.deepEqual(repo.e2e.map((e) => e.tool), ["playwright"]);
    assert.deepEqual(repo.iac.terraform, ["infra"]);
    assert.ok(repo.codeqlLanguages.includes("javascript-typescript"));
    assert.ok(repo.codeqlLanguages.includes("python"));
  });
});

describe("buildGateQuestions", () => {
  it("asks about every detected gate, follow-ups for coverage/audit, and repo-level options", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const qs = buildGateQuestions(scan);
    const ids = new Set(qs.map((x) => x.id));
    for (const id of [
      "apps.api.format",
      "apps.api.coverage",
      "apps.api.audit",
      "apps.api.migrations",
      "apps.mobile.coverage",
      "docker.build",
      "docker.scan",
      "compose.apps/api/docker-compose.yml",
      "iac.terraform",
      "commitlint",
      "codeql",
      "dependabot",
      "required_checks",
    ]) {
      assert.ok(ids.has(id), `missing question ${id}`);
    }
    const cov = qs.find((x) => x.id === "apps.api.coverage");
    assert.deepEqual(cov.followUps.map((f) => f.id), ["metric", "min", "ignore", "ratchet", "comment", "diff"]);
    const audit = qs.find((x) => x.id === "apps.api.audit");
    assert.ok(audit.followUps.some((f) => f.id === "fix"));
    assert.ok(qs.every((x) => x.question.pt && x.question.en && x.question.es));
    assert.ok(qs.every((x) => (x.followUps || []).every((f) => f.pt && f.en && f.es)));
  });

  it("picks the question text by language base, falling back to English", () => {
    const question = { pt: "Olá?", en: "Hello?", es: "¿Hola?" };
    assert.equal(questionText(question, "pt-BR"), "Olá?");
    assert.equal(questionText(question, "es-MX"), "¿Hola?");
    assert.equal(questionText(question, "fr"), "Hello?");
    assert.equal(questionText({ en: "Hello?" }, "es"), "Hello?");
  });

  it("offers adopting a tool when a gate is not detected", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const ids = buildGateQuestions(scan).map((x) => x.id);
    assert.ok(!ids.includes("apps.mobile.audit"));
    assert.ok(ids.includes("apps.web.format.adopt"));
  });
});

describe("resolveGatePlan", () => {
  it("merges defaults, per-app overrides, exclusions and custom apps", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, {
      defaults: { coverage: { mode: "warn", min: 70 }, audit: { level: "critical" } },
      apps: {
        api: { coverage: { mode: "block", min: 90 }, commands: { test: "npm run test:ci" } },
        mobile: "off",
        docs: { path: "docs", stack: "custom", commands: { install: "pip install mkdocs", build: "mkdocs build --strict" } },
      },
      docker: { build: true, scan: "warn" },
      compose_smoke: "warn",
    });
    const names = plan.apps.map((a) => a.name).sort();
    assert.deepEqual(names, ["api", "docs", "svc", "web"]);
    const api = plan.apps.find((a) => a.name === "api");
    assert.equal(api.decisions.coverage.mode, "block");
    assert.equal(api.decisions.coverage.min, 90);
    assert.equal(api.decisions.audit.level, "critical");
    assert.equal(gateCommand(api, "test"), "npm run test:ci");
    assert.equal(gateCommand(api, "audit"), "npm audit --audit-level=critical");
    const web = plan.apps.find((a) => a.name === "web");
    assert.equal(web.decisions.coverage.min, 70);
    assert.equal(plan.docker.build, "block");
    assert.equal(plan.docker.scan, "warn");
    assert.equal(plan.composeSmoke.mode, "warn");
    assert.equal(plan.composeSmoke.file, "apps/api/docker-compose.yml");
  });

  it("normalizes gate modes", () => {
    assert.equal(normalizeMode(true), "block");
    assert.equal(normalizeMode(false), "off");
    assert.equal(normalizeMode("WARN"), "warn");
    assert.equal(normalizeMode("garbage", "warn"), "warn");
  });
});

describe("suggestGatesYaml", () => {
  it("emits a ci.gates draft that parses and validates against the plan resolver", async () => {
    const { load } = await import("js-yaml");
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const draft = suggestGatesYaml(scan, { defaultBranch: "main" });
    const doc = load(`ci:\n${draft}\n`);
    assert.deepEqual(doc.ci.gates.branches, ["main"]);
    assert.equal(doc.ci.gates.apps.mobile.audit, "off");
    assert.equal(doc.ci.gates.compose_smoke.mode, "warn");
    const plan = resolveGatePlan(scan, doc.ci.gates);
    assert.equal(plan.apps.length, 4);
  });

  it("emits a preset draft with only repo-specific overrides", async () => {
    const { load } = await import("js-yaml");
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const doc = load(`ci:\n${suggestGatesYaml(scan, { defaultBranch: "dev", preset: "balanced" })}\n`);
    assert.equal(doc.ci.gates.preset, "balanced");
    assert.equal(doc.ci.gates.apps.api.migrate, true);
    assert.equal(doc.ci.gates.docs, "off");
    const plan = resolveGatePlan(scan, doc.ci.gates);
    assert.equal(plan.preset, "balanced");
    assert.equal(plan.apps.find((a) => a.name === "mobile").decisions.audit.mode, "off");
  });
});

describe("expanded detection", () => {
  it("detects toolchain versions, test services, migrate commands, web and mobile targets", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const api = scan.apps.find((a) => a.name === "api");
    assert.equal(api.setup.version, "22");
    assert.equal(api.migrate, "npx prisma migrate deploy");
    assert.deepEqual(
      api.services.map((s) => [s.kind, s.image]),
      [["postgres", "postgres:16"], ["rabbitmq", "rabbitmq:3.13-management"]]
    );
    assert.equal(api.deps, undefined);
    assert.equal(api.manifestText, undefined);
    const web = scan.apps.find((a) => a.name === "web");
    assert.equal(web.web.framework, "vite");
    assert.equal(web.web.dist, "dist");
    const mobile = scan.apps.find((a) => a.name === "mobile");
    assert.deepEqual(mobile.mobile, { android: true, ios: false, kind: "flutter" });
    assert.equal(scan.apps.find((a) => a.name === "svc").setup.version, "3.12");
  });
});

describe("presets and expanded ci.gates", () => {
  it("merges scalar overrides into object presets", () => {
    assert.deepEqual(mergeGateConfig({ mode: "warn", min: 70 }, "block", "coverage"), { mode: "block", min: 70 });
    assert.deepEqual(mergeGateConfig({ build: "block", cache: true }, "off", "docker"), { build: "off", cache: true });
    assert.deepEqual(mergeGateConfig({ mode: "warn", min: 80 }, 60, "diff"), { mode: "warn", min: 60 });
  });

  it("applies the balanced preset while explicit keys win", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, { preset: "balanced", defaults: { coverage: "block" }, secrets_scan: "warn" });
    const api = plan.apps.find((a) => a.name === "api");
    assert.equal(api.decisions.coverage.mode, "block");
    assert.equal(api.decisions.coverage.min, 70);
    assert.equal(api.decisions.coverage.comment, true);
    assert.equal(api.decisions.fix.format, "suggest");
    assert.deepEqual(api.resolvedServices.map((s) => s.kind), ["postgres", "rabbitmq"]);
    assert.equal(plan.secretsScan, "warn");
    assert.equal(plan.dependencyReview.mode, "warn");
    assert.equal(plan.affected.enabled, true);
    assert.equal(plan.prChecks.title.mode, "warn");
    assert.equal(plan.docker.cache, true);
    assert.equal(plan.lighthouse.mode, "off");
  });

  it("strict enables diff coverage, web quality and mobile builds for detected targets", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, { preset: "strict" });
    assert.deepEqual(plan.apps.find((a) => a.name === "api").decisions.coverage.diff, { mode: "block", min: 80 });
    assert.equal(plan.lighthouse.app, "web");
    assert.equal(plan.a11y.mode, "warn");
    assert.equal(plan.mobileBuild.app, "mobile");
    assert.equal(plan.mobileBuild.ios, false);
    assert.equal(plan.bundleSize.mode, "off");
    assert.equal(plan.notify.on, "failure");
    assert.equal(plan.prChecks.size.max, 800);
  });

  it("keeps legacy behaviour without a preset", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, {});
    assert.equal(plan.preset, null);
    assert.equal(plan.affected.enabled, false);
    assert.equal(plan.secretsScan, "off");
    assert.equal(plan.mergeGroup, true);
    const api = plan.apps.find((a) => a.name === "api");
    assert.equal(api.decisions.fix.format, "off");
    assert.deepEqual(api.resolvedServices, []);
  });

  it("resolves matrix, retry, services lists and runner overrides per app", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, {
      runner: "self-hosted",
      timeout_minutes: 45,
      apps: { api: { matrix: { versions: [20, 22], os: ["ubuntu-latest"] }, retry: 9, services: ["redis"], format: { fix: "commit" } } },
    });
    const api = plan.apps.find((a) => a.name === "api");
    assert.deepEqual(api.decisions.matrix, { versions: ["20", "22"], os: ["ubuntu-latest"] });
    assert.equal(api.decisions.retry, 3);
    assert.deepEqual(api.resolvedServices, [{ kind: "redis", image: "redis:7" }]);
    assert.equal(api.decisions.fix.format, "commit");
    assert.equal(api.decisions.format, "block");
    assert.equal(plan.runner, "self-hosted");
    assert.equal(plan.timeout, 45);
  });
});

describe("project.schema.json ci.gates", () => {
  it("accepts every expanded key and rejects unknown values", async () => {
    const Ajv = (await import("ajv/dist/2020.js")).default;
    const schemaPath = new URL("../../.github/project.schema.json", import.meta.url);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
    const gateErrors = (gates) => {
      validate({ ci: { gates } });
      return (validate.errors || []).filter((e) => e.instancePath.startsWith("/ci"));
    };
    assert.deepEqual(
      gateErrors({
        preset: "strict",
        declined: ["notify"],
        merge_group: true,
        runner: "ubuntu-latest",
        timeout_minutes: 20,
        affected: { paths: ["packages/shared/**"] },
        artifacts: true,
        defaults: { lint: { mode: "block", fix: "suggest" }, services: "auto", retry: 1, coverage: { mode: "warn", comment: true, diff: 80 } },
        apps: { api: { matrix: { versions: [20, 22] }, services: { postgres: "postgres:15", redis: true }, migrate: true, version: "22" }, mobile: "off" },
        docker: { build: "block", lint: "warn", cache: true, publish: { platforms: ["linux/amd64"] } },
        dependency_review: { mode: "block", severity: "high" },
        secrets_scan: "block",
        pr_checks: { mode: "warn", title: { mode: "block", pattern: "^feat" }, size: 800 },
        lighthouse: { mode: "warn", min: { performance: 0.7 } },
        a11y: { mode: "warn", urls: ["/"] },
        bundle_size: "warn",
        mobile_build: { mode: "warn", ios: false },
        notify: { on: "failure", discord: false },
        docs: { links: "block", external: false },
      }),
      []
    );
    assert.ok(gateErrors({ defaults: { lint: { fix: "yes" } } }).length);
    assert.ok(gateErrors({ apps: { api: { services: ["oracle"] } } }).length);
    assert.ok(gateErrors({ preset: "max" }).length);
    assert.ok(gateErrors({ notify: "sometimes" }).length);
  });
});

describe("interview memory and cost", () => {
  it("marks questions as answered or declined from ci.gates", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const gates = { declined: ["notify"], docker: "block", apps: { api: { lint: "block" } } };
    const qs = buildGateQuestions(scan, { gates });
    const status = (id) => qs.find((x) => x.id === id)?.status;
    assert.equal(status("notify"), "declined");
    assert.equal(status("docker.build"), "answered");
    assert.equal(status("docker.scan"), "new");
    assert.equal(status("apps.api.lint"), "answered");
    assert.equal(status("apps.api.format"), "new");
    assert.equal(questionStatus({ id: "x", yaml: "ci.gates.x" }, null), "new");
  });

  it("asks every new category for the detected repo", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const ids = new Set(buildGateQuestions(scan).map((x) => x.id));
    for (const id of [
      "preset",
      "triggers.merge_group",
      "settings.runner",
      "settings.affected",
      "apps.api.format.fix",
      "apps.api.matrix",
      "apps.api.services",
      "apps.api.migrate",
      "apps.api.retry",
      "docker.lint",
      "docker.cache",
      "docker.publish",
      "dependency_review",
      "secrets_scan",
      "pr_checks",
      "lighthouse",
      "a11y",
      "bundle_size",
      "mobile_build",
      "notify",
    ]) {
      assert.ok(ids.has(id), `missing question ${id}`);
    }
  });

  it("estimates more CI minutes for strict than minimal and bills macOS at 10x", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const minimal = estimateCiMinutes(resolveGatePlan(scan, { preset: "minimal" }));
    const strict = estimateCiMinutes(resolveGatePlan(scan, { preset: "strict" }));
    assert.ok(strict.perPush > minimal.perPush);
    assert.ok(minimal.perPullRequest <= minimal.perPush + 1);
    const mac = estimateCiMinutes(resolveGatePlan(scan, { apps: { svc: { matrix: { os: ["macos-latest"] } } } }));
    assert.equal(mac.jobs.find((j) => j.name === "app-svc").billable, 30);
  });

  it("only counts repo-level jobs the repo can run when given the scan", () => {
    const scan = scanRepoForGates(root, { kitRootRel: "Hyperion" });
    const plan = resolveGatePlan(scan, { openapi: "block", docs: "warn", docker: "block" });
    const names = estimateCiMinutes(plan, scan).jobs.map((j) => j.name);
    assert.ok(names.includes("docker"));
    assert.ok(!names.includes("openapi"));
    assert.ok(!names.includes("docs"));
  });

  it("diffs workflow text for --preview", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nC\nd\ne\nf\ng\nh", { context: 1 });
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.deepEqual(d.lines.slice(0, 4), ["  …", "  b", "- c", "+ C"]);
    assert.equal(d.lines.at(-1), "+ h");
  });
});
