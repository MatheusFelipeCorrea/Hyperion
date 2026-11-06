import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  scanRepoForGates,
  walkRepo,
  resolveServices,
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
  fakeGit(root);
});

/** origin/HEAD resolves on the first git probe, so CLI runs spend one git spawn on detectDefaultBranch. */
function fakeGit(dir) {
  write(dir, ".git/HEAD", "ref: refs/heads/main\n");
  write(dir, ".git/refs/remotes/origin/HEAD", "ref: refs/remotes/origin/main\n");
  write(dir, ".git/refs/heads/.keep", "");
  write(dir, ".git/objects/.keep", "");
}

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

  it("diffs identical text with a single collapsed context marker", () => {
    const same = lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nc\nd\ne\nf", { context: 1 });
    assert.deepEqual(same, { lines: ["  …"], added: 0, removed: 0 });
    assert.deepEqual(lineDiff("x", "").lines, ["- x", "+ "]);
  });

  it("diffs workflow text for --preview", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nC\nd\ne\nf\ng\nh", { context: 1 });
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.deepEqual(d.lines.slice(0, 4), ["  …", "  b", "- c", "+ C"]);
    assert.equal(d.lines.at(-1), "+ h");
  });
});
describe("polyglot repo: every stack analyzer", () => {
  let poly;
  let scan;
  const app = (name) => scan.apps.find((a) => a.name === name);

  before(() => {
    poly = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-gates-poly-"));
    const files = {
      "rust/Cargo.toml": "[package]\nname = 'r'\n",
      "rust/crates/sub/Cargo.toml": "[package]\nname = 'sub'\n",
      "dotnet/App.sln": "",
      "dotnet/src/App/App.csproj": '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup><PackageReference Include="Npgsql" /></Project>',
      "tools/Stray.csproj": "<Project />",
      "maven/pom.xml":
        "<project><properties><maven.compiler.release>17</maven.compiler.release></properties>" +
        "<plugins>jacoco-maven-plugin maven-checkstyle-plugin spotless-maven-plugin dependency-check-maven</plugins>" +
        "<dependency>org.postgresql</dependency></project>",
      "maven/mvnw": "",
      "maven/core/pom.xml": "<project/>",
      "legacyjava/pom.xml": "<project><properties><java.version>1.8</java.version></properties></project>",
      "gradle/build.gradle.kts":
        'plugins { id("com.android.application"); id("io.gitlab.arturbosch.detekt"); id("com.diffplug.spotless"); id("org.jetbrains.kotlinx.kover"); id("org.owasp.dependencycheck") }\nkotlin { jvmToolchain(21) }\n',
      "gradle/gradlew": "",
      "gradle/app/build.gradle.kts": 'dependencies { implementation("org.springframework.boot:spring-boot-starter-data-redis") }\n',
      "gradle2/build.gradle": "plugins { id 'org.jlleitschuh.gradle.ktlint'; id 'jacoco' }\nsourceCompatibility = '11'\n",
      "gradle2/.java-version": "17\n",
      "gradle3/build.gradle": "apply plugin: 'checkstyle'\n",
      "gradle3/.tool-versions": "java temurin-21.0.2\n",
      "gradle4/build.gradle": "java { sourceCompatibility = JavaVersion.VERSION_1_8 }\n",
      "php/composer.json": {
        require: { php: "^8.2" },
        "require-dev": { "phpunit/phpunit": "^11", "phpstan/phpstan": "^1", "friendsofphp/php-cs-fixer": "^3", "pestphp/pest": "^2" },
      },
      "php/artisan": "",
      "php2/composer.json": { "require-dev": { "laravel/pint": "^1" } },
      "php2/phpunit.xml": "<phpunit/>",
      "php2/.tool-versions": "php 8.1.2\n",
      "node-vitest/package.json": { scripts: { lint: "eslint ." }, devDependencies: { vitest: "^2", "@vitest/coverage-v8": "^2" } },
      "node-jest/package.json": { scripts: { lint: "eslint ." } },
      "node-jest/jest.config.js": "module.exports = {};",
      "php3/composer.json": "{ not json",
      "ruby/Gemfile": "gem 'rails'\ngem 'pg'\ngem 'rspec-rails'\ngem 'rubocop'\ngem 'standard'\ngem 'sorbet'\ngem 'simplecov'\ngem 'bundler-audit'\n",
      "ruby/bin/rails": "",
      "ruby/.ruby-version": "3.3.0\n",
      "ruby2/Gemfile": "source 'https://rubygems.org'\n",
      "ruby2/.tool-versions": "# pinned\nruby 3.2.2\n",
      "pydj/requirements.txt": "django\nflake8\n",
      "pydj/manage.py": "",
      "pyreq/requirements.txt": "requests\n",
      "pyreq/requirements-dev.txt": "pytest\n",
      "pyprod/setup.py": "",
      "pyprod/requirements-prod.txt": "requests\n",
      "gosvc/go.mod": "module example.com/gosvc\n\ngo 1.22\n",
      "gosvc/.golangci.yml": "linters: {}\n",
      "node-pnpm/package.json": { packageManager: "pnpm@9.0.0", scripts: { build: "tsc -p ." }, devDependencies: { typescript: "^5" } },
      "node-yarn/package.json": { packageManager: "yarn@4.0.0", scripts: { test: "mocha" } },
      "node-bun/package.json": { packageManager: "bun@1.1.0", scripts: { lint: "biome lint ." } },
      "node-broken/package.json": "{ not json",
      "web/package.json": {
        scripts: { build: "vite build" },
        devDependencies: { vite: "^5", react: "^18" },
        "size-limit": [{ path: "dist/*.js", limit: "100 kB" }],
      },
      "web/package-lock.json": "{}",
      "dart/pubspec.yaml": "name: d\n",
      "dart/bin/main.dart": "",
      "flutterapp/pubspec.yaml": "name: f\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "flutterapp/.fvmrc": { flutter: "3.22.0" },
      "flutterapp/test/a_test.dart": "",
      "flutterapp/ios/Runner/Info.plist": "",
      "openapi.yaml": "openapi: 3.0.0\n",
      "docs/guide.md": "# Guide\n",
      ".markdownlint.json": "{}",
      "docker-compose.yml": "services:\n  cache:\n    image: redis:7\n",
      Dockerfile: "FROM scratch\n",
      "charts/app/Chart.yaml": "name: app\n",
      "k8s/deploy.yaml": "kind: Deployment\n",
      "commitlint.config.js": "",
      "renovate.json": "{}",
      CODEOWNERS: "",
      ".hadolint.yaml": "",
      "release-please-config.json": "{}",
      "vercel.json": "{}",
      ".editorconfig": "",
      "lefthook.yml": "",
    };
    for (const [rel, content] of Object.entries(files)) write(poly, rel, content);
    fakeGit(poly);
    scan = scanRepoForGates(poly);
  });

  after(() => fs.rmSync(poly, { recursive: true, force: true }));

  it("collapses nested multi-module builds, lets a .sln win over stray projects and drops tooling-only packages", () => {
    const paths = scan.apps.map((a) => a.path);
    for (const nested of ["rust/crates/sub", "maven/core", "gradle/app", "tools", "dotnet/src/App", "node-broken"]) {
      assert.ok(!paths.includes(nested), `${nested} should be collapsed or skipped`);
    }
    assert.equal(app("rust").gates.lint.command, "cargo clippy --all-targets -- -D warnings");
    assert.equal(app("rust").gates.coverage.needs, "cargo-llvm-cov (installed in CI)");
  });

  it("dotnet: TargetFramework or global.json version and driver services", () => {
    const net = app("dotnet");
    assert.deepEqual([net.setup.version, net.setup.versionSource], ["9.0.x", "TargetFramework"]);
    assert.deepEqual(net.services.map((s) => s.kind), ["postgres"]);
    assert.match(net.gates.audit.command, /dotnet list package --vulnerable/);
    assert.equal(net.gates.coverage.tool, "coverlet");
    assert.equal(scan.apps.filter((a) => a.stack === "dotnet").length, 1);
  });

  it("maven: wrapper, plugins, compiler release and legacy 1.x versions", () => {
    const mvn = app("maven");
    assert.equal(mvn.install, "./mvnw -B -q dependency:go-offline");
    assert.equal(mvn.gates.lint.command, "./mvnw -B checkstyle:check");
    assert.equal(mvn.gates.format.fix, "./mvnw -B spotless:apply");
    assert.equal(mvn.gates.coverage.report, "target/site/jacoco/jacoco.xml");
    assert.match(mvn.gates.audit.command, /dependency-check-maven:check/);
    assert.deepEqual([mvn.setup.version, mvn.setup.versionSource], ["17", "build file"]);
    assert.deepEqual(mvn.hints, []);
    assert.deepEqual(mvn.services.map((s) => s.kind), ["postgres"]);
    const legacy = app("legacyjava");
    assert.equal(legacy.setup.version, "8");
    assert.equal(legacy.gates.coverage, null);
    assert.equal(legacy.gates.audit, null);
    assert.match(legacy.hints[0], /jacoco-maven-plugin/);
  });

  it("gradle: plugin-driven gates, Android detection and version sources", () => {
    const g = app("gradle");
    assert.equal(g.install, "./gradlew --version");
    assert.equal(g.gates.lint.command, "./gradlew detekt");
    assert.equal(g.gates.format.command, "./gradlew spotlessCheck");
    assert.equal(g.gates.coverage.tool, "kover");
    assert.equal(g.gates.audit.command, "./gradlew dependencyCheckAnalyze");
    assert.deepEqual(g.mobile, { android: true, ios: false, kind: "android", gradle: "./gradlew" });
    assert.deepEqual([g.setup.version, g.setup.wrapper], ["21", true]);
    assert.deepEqual(g.services.map((s) => s.kind), ["redis"]);
    const g2 = app("gradle2");
    assert.equal(g2.gates.lint.command, "gradle ktlintCheck");
    assert.equal(g2.gates.coverage.tool, "jacoco");
    assert.deepEqual([g2.setup.version, g2.setup.versionSource], ["17", ".java-version"]);
    const g3 = app("gradle3");
    assert.equal(g3.gates.lint.command, "gradle checkstyleMain");
    assert.deepEqual([g3.setup.version, g3.setup.versionSource], ["21", ".tool-versions"]);
    const g4 = app("gradle4");
    assert.equal(g4.gates.lint, null);
    assert.equal(g4.gates.coverage, null);
    assert.deepEqual([g4.setup.version, g4.setup.versionSource], ["8", "build file"]);
  });

  it("php: pest/phpunit, phpstan, php-cs-fixer or pint, artisan migrations", () => {
    const php = app("php");
    assert.equal(php.gates.test.command, "vendor/bin/pest");
    assert.equal(php.gates.lint.command, "vendor/bin/phpstan analyse");
    assert.match(php.gates.format.command, /php-cs-fixer fix --dry-run/);
    assert.equal(php.gates.coverage.tool, "phpunit");
    assert.equal(php.migrate, "php artisan migrate --force");
    assert.deepEqual([php.setup.version, php.setup.versionSource], ["8.2", "composer.json"]);
    const php2 = app("php2");
    assert.equal(php2.gates.format.command, "vendor/bin/pint --test");
    assert.equal(php2.gates.test.command, "vendor/bin/phpunit");
    assert.equal(php2.setup.version, "8.1.2");
    const php3 = app("php3");
    assert.equal(php3.gates.test, null);
    assert.equal(php3.gates.audit.command, "composer audit");
    assert.equal(php3.setup.version, "8.3");
  });

  it("ruby: rspec/rails/rubocop/standard/sorbet/simplecov and fallbacks", () => {
    const rb = app("ruby");
    assert.equal(rb.gates.test.command, "bundle exec rspec");
    assert.equal(rb.gates.lint.fix, "bundle exec rubocop -a");
    assert.equal(rb.gates.format.command, "bundle exec standardrb");
    assert.equal(rb.gates.typecheck.command, "bundle exec srb tc");
    assert.equal(rb.gates.coverage.report, "coverage/.last_run.json");
    assert.equal(rb.gates.audit.command, "bundle exec bundle-audit check --update");
    assert.equal(rb.setup.version, "3.3.0");
    assert.deepEqual(rb.services.map((s) => s.kind), ["postgres"]);
    const rb2 = app("ruby2");
    assert.equal(rb2.gates.test.command, "bundle exec rake test");
    assert.equal(rb2.gates.lint, null);
    assert.match(rb2.gates.audit.command, /^gem install bundler-audit/);
    assert.equal(rb2.setup.version, "3.2.2");
  });

  it("versionSource names .tool-versions when the version came from it", () => {
    assert.deepEqual([app("php2").setup.version, app("php2").setup.versionSource], ["8.1.2", ".tool-versions"]);
    assert.deepEqual([app("ruby2").setup.version, app("ruby2").setup.versionSource], ["3.2.2", ".tool-versions"]);
  });

  it("ruby: bin/rails enables db:prepare and the migrations gate", () => {
    const rb = app("ruby");
    assert.equal(rb.migrate, "bin/rails db:prepare");
    assert.equal(rb.gates.migrations?.tool, "rails");
    assert.equal(app("ruby2").migrate, null);
  });

  it("walkRepo indexes Ruby binstubs but still skips bin/ build output elsewhere", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-walk-bin-"));
    try {
      for (const rel of ["rb/Gemfile", "rb/bin/rails", "net/App.csproj", "net/bin/Debug/App.dll", "bin/tool"]) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), "");
      }
      assert.deepEqual(walkRepo(root), ["net/App.csproj", "rb/Gemfile", "rb/bin/rails"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("python: requirements installs, flake8 and Django test runner", () => {
    const dj = app("pydj");
    assert.equal(dj.install, "pip install -r requirements.txt");
    assert.equal(dj.gates.lint.command, "flake8 .");
    assert.equal(dj.gates.test.command, "python manage.py test");
    assert.equal(dj.gates.migrations.tool, "django");
    assert.equal(dj.gates.audit.command, "pip-audit -r requirements.txt");
    assert.equal(app("pyreq").install, "pip install -r requirements-dev.txt && pip install -r requirements.txt");
    const prod = app("pyprod");
    assert.equal(prod.install, "pip install -r requirements-prod.txt");
    assert.equal(prod.gates.audit.command, "pip-audit");
  });

  it("node: packageManager field, missing lockfile, non-web builds and size-limit", () => {
    const pnpm = app("node-pnpm");
    assert.deepEqual([pnpm.pm, pnpm.setup.lockfile, pnpm.install], ["pnpm", null, "pnpm install --frozen-lockfile"]);
    assert.equal(pnpm.web, null);
    assert.equal(pnpm.gates.test, null);
    assert.equal(app("node-yarn").pm, "yarn");
    assert.equal(app("node-yarn").gates.coverage, null);
    assert.equal(app("node-bun").pm, "bun");
    assert.deepEqual([app("node-vitest").gates.coverage.command, app("node-vitest").gates.coverage.needs], [
      "npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text --coverage.reporter=lcov",
      null,
    ]);
    assert.match(app("node-jest").gates.coverage.command, /^npx jest --coverage /);
    const web = app("web");
    assert.equal(web.web.framework, "vite-react");
    assert.equal(web.bundleSize.command, "npx size-limit");
    assert.equal(app("gosvc").gates.lint.command, "golangci-lint run");
    assert.equal(app("flutterapp").setup.versionSource, "fvm");
    assert.equal(app("dart").stack, "dart");
  });

  it("repo-level detection: helm, k8s, openapi, docs, release, deploy, hooks", () => {
    const r = scan.repo;
    assert.deepEqual(r.iac.helm, ["charts/app"]);
    assert.equal(r.iac.kubernetes, true);
    assert.deepEqual(r.openapi, ["openapi.yaml"]);
    assert.equal(r.commitlint, "commitlint.config.js");
    assert.equal(r.github.renovate, true);
    assert.equal(r.github.codeowners, true);
    assert.equal(r.hadolint, true);
    assert.equal(r.editorconfig, true);
    assert.equal(r.preCommit.lefthook, true);
    assert.deepEqual(r.release, ["release-please"]);
    assert.deepEqual(r.deploy, ["vercel", "helm", "kubernetes"]);
    assert.deepEqual([r.docs.markdownFiles, r.docs.docsDir, r.docs.markdownlint], [1, true, true]);
  });

  it("asks adoption questions for missing lint/test/coverage and repo-level openapi, docs and bundle size", () => {
    const qs = buildGateQuestions(scan);
    const ids = new Set(qs.map((x) => x.id));
    for (const id of ["apps.node-yarn.lint.adopt", "apps.node-pnpm.test.adopt", "apps.node-yarn.coverage.adopt", "openapi", "docs", "bundle_size"]) {
      assert.ok(ids.has(id), `missing question ${id}`);
    }
    assert.equal(qs.find((x) => x.id === "bundle_size").yaml, "ci.gates.bundle_size");
    assert.ok(!ids.has("dependabot"));
    assert.match(qs.find((x) => x.id === "commitlint").question.en, /commitlint configured/);
  });

  it("resolveServices accepts maps and ignores unknown shapes", () => {
    assert.deepEqual(resolveServices({ postgres: "postgres:15", redis: true, oracle: "x" }), [
      { kind: "postgres", image: "postgres:15" },
      { kind: "redis", image: "redis:7" },
    ]);
    assert.deepEqual(resolveServices("sometimes"), []);
  });

  it("docker.publish: object form, true with branches, and absent", () => {
    const custom = resolveGatePlan(scan, { docker: { publish: { branches: "release", tags: false, platforms: ["linux/arm64"] } } });
    assert.deepEqual(custom.docker.publish, { branches: ["release"], tags: false, platforms: ["linux/arm64"] });
    const simple = resolveGatePlan(scan, { branches: ["trunk", "dev"], docker: { publish: true } });
    assert.deepEqual(simple.docker.publish, { branches: ["trunk"], tags: true, platforms: ["linux/amd64"] });
    assert.equal(resolveGatePlan(scan, { docker: { publish: {} } }).docker.publish.branches, null);
    assert.equal(resolveGatePlan(scan, {}).docker.publish, null);
  });

  it("CLI human summary lists bundle, helm and renovate", () => {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
    delete env.HYPERION_ROOT;
    const SCRIPT = fileURLToPath(new URL("./pipeline-gates.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [SCRIPT, "--en"], { cwd: poly, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bundle {5}npx size-limit/);
    assert.match(r.stdout, /helm: charts\/app/);
    assert.match(r.stdout, /dependabot renovate {2}codeowners yes/);
    assert.match(r.stdout, /hadolint {3}\.hadolint\.yaml {2}docs 1 md \(markdownlint config\)/);
    assert.match(r.stdout, /release {4}release-please {2}deploy vercel, helm, kubernetes/);
  });

  it("walkRepo tolerates a missing root", () => {
    assert.deepEqual(walkRepo(path.join(os.tmpdir(), "hyperion-gates-missing-xyz")), []);
  });
});

describe("pipeline-gates CLI", () => {
  const SCRIPT = fileURLToPath(new URL("./pipeline-gates.mjs", import.meta.url));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
  delete env.HYPERION_ROOT;
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: "utf8" });
  const productCi = () => path.join(root, ".github/workflows/hyperion-product-ci.yml");

  it("prints the human summary (default) in the requested language", () => {
    const r = run(["--lang", "en"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /■ api {2}\[node\/npm\] {2}apps\/api/);
    assert.match(r.stdout, /services {3}postgres=postgres:16/);
    assert.match(r.stdout, /migrate {4}npx prisma migrate deploy/);
    assert.match(r.stdout, /web {8}vite → dist/);
    assert.match(r.stdout, /mobile {5}flutter: android/);
    assert.match(r.stdout, /compose {4}apps\/api\/docker-compose\.yml: db=postgres:16/);
    assert.match(r.stdout, /- \[apps\.api\.lint\] .*lint gate\?/);
    assert.equal(run(["--en", "--pending"]).status, 0);
  });

  it("--json, --yaml and --estimate", () => {
    const json = JSON.parse(run(["--json"]).stdout);
    assert.ok(json.scan.apps.length >= 4);
    assert.ok(json.questions.length > 10);
    assert.ok(json.estimate.perPush > 0);
    assert.match(run(["--yaml", "--preset", "strict"]).stdout, /preset: strict/);
    const est = run(["--estimate"]);
    assert.match(est.stdout, /CI minutes estimate/);
    assert.match(est.stdout, /min per push/);
    assert.doesNotMatch(est.stdout, /Preview/);
  });

  it("--preview renders, diffs, reports no changes and adds a diagram", () => {
    write(root, "draft.yml", "ci:\n  gates:\n    defaults:\n      coverage: warn\n");
    try {
      const fresh = run(["--preview", "--gates-file", "draft.yml"]);
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.match(fresh.stdout, /does not exist yet — full render/);
      assert.match(fresh.stdout, /Diagram of this pipeline: add --diagram/);

      const start = fresh.stdout.indexOf("full render:\n\n") + "full render:\n\n".length;
      write(root, ".github/workflows/hyperion-product-ci.yml", fresh.stdout.slice(start, fresh.stdout.indexOf("\n\nNothing written")));
      const same = run(["--preview", "--gates-file", "draft.yml"]);
      assert.match(same.stdout, /Preview \.github\/workflows\/hyperion-product-ci\.yml: \+0 −0\r?\nNo changes\./);

      const changed = run(["--preview", "--preset", "minimal", "--diagram", "--no-steps"]);
      assert.equal(changed.status, 0, changed.stderr);
      assert.match(changed.stdout, /Preview \.github\/workflows\/hyperion-product-ci\.yml: \+\d+ −\d+/);
      assert.match(changed.stdout, /```mermaid/);
    } finally {
      fs.rmSync(path.join(root, ".github"), { recursive: true, force: true });
      fs.rmSync(path.join(root, "draft.yml"), { force: true });
    }
    assert.ok(!fs.existsSync(productCi()));
  });

  it("exits 2 for an unknown preset and 1 for an unreadable gates file", () => {
    const preset = run(["--preset", "max"]);
    assert.equal(preset.status, 2);
    assert.match(preset.stderr, /Unknown preset "max"/);
    write(root, "bad.yml", "gates: [unclosed\n");
    try {
      const bad = run(["--json", "--gates-file", "bad.yml"]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /YAMLException/);
    } finally {
      fs.rmSync(path.join(root, "bad.yml"), { force: true });
    }
  });
});
