import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  detectPackageManager,
  detectTestCommand,
  detectLintCommand,
  detectBuildCommand,
  detectAuditCommand,
  detectStackSummary,
  detectRepoAdaptation,
  isHyperionInstalled,
  readProjectCommands,
  readProjectYmlText,
  rootHasFile,
} from "./repo-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-detect-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("repo-detect", () => {
  it("detects npm for this kit", () => {
    assert.equal(detectPackageManager(root), "npm");
  });

  it("detects npm test", () => {
    const cmd = detectTestCommand(root);
    assert.ok(cmd?.includes("test"));
  });

  it("detects npm audit", () => {
    const cmd = detectAuditCommand(root);
    assert.ok(cmd?.includes("audit"));
  });

  it("hyperion installed in kit repo", () => {
    assert.equal(isHyperionInstalled(root), true);
  });

  it("detects dotnet from csproj", () => {
    withFixture({ "App.csproj": "<Project />" }, (dir) => {
      assert.equal(detectPackageManager(dir), "dotnet");
      assert.equal(detectTestCommand(dir), "dotnet test");
      assert.equal(detectBuildCommand(dir), "dotnet build");
      assert.ok(detectStackSummary(dir).includes("dotnet"));
    });
  });

  it("detects maven from pom.xml", () => {
    withFixture({ "pom.xml": "<project />" }, (dir) => {
      assert.equal(detectPackageManager(dir), "maven");
      assert.equal(detectTestCommand(dir), "mvn test");
      assert.ok(detectStackSummary(dir).includes("java-maven"));
    });
  });

  it("detects gradle from build.gradle.kts", () => {
    withFixture({ "build.gradle.kts": "plugins {}" }, (dir) => {
      assert.equal(detectPackageManager(dir), "gradle");
      assert.equal(detectTestCommand(dir), "gradle test");
      assert.ok(detectStackSummary(dir).includes("java-gradle"));
    });
  });

  it("detects php and ruby", () => {
    withFixture({ "composer.json": "{}" }, (dir) => {
      assert.equal(detectPackageManager(dir), "php");
      assert.equal(detectTestCommand(dir), "composer test");
    });
    withFixture({ Gemfile: "source 'https://rubygems.org'" }, (dir) => {
      assert.equal(detectPackageManager(dir), "ruby");
      assert.equal(detectTestCommand(dir), "bundle exec rake test");
    });
  });

  it("detects bun lockfile", () => {
    withFixture({ "bun.lockb": "", "package.json": '{"scripts":{"test":"bun test"}}' }, (dir) => {
      assert.equal(detectPackageManager(dir), "bun");
      assert.equal(detectTestCommand(dir), "bun test");
    });
  });
});

const SCRIPT = join(__dirname, "repo-detect.mjs");
const ALL_SCRIPTS = JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "vite build" } });

function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-detect-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MATRIX = [
  { label: "pnpm", files: { "pnpm-lock.yaml": "", "package.json": ALL_SCRIPTS }, pm: "pnpm", test: "pnpm test", lint: "pnpm run lint", build: "pnpm run build", audit: "pnpm audit" },
  { label: "yarn", files: { "yarn.lock": "", "package.json": ALL_SCRIPTS }, pm: "yarn", test: "yarn test", lint: "yarn lint", build: "yarn build", audit: "yarn npm audit --all --recursive" },
  { label: "bun", files: { "bun.lock": "", "package.json": ALL_SCRIPTS }, pm: "bun", test: "bun test", lint: "bun run lint", build: "bun run build", audit: "bun pm audit" },
  { label: "npm", files: { "package-lock.json": "{}", "package.json": ALL_SCRIPTS }, pm: "npm", test: "npm test", lint: "npm run lint", build: "npm run build", audit: "npm audit --audit-level=moderate" },
  { label: "npm placeholder test", files: { "package.json": JSON.stringify({ scripts: { test: "echo \"no tests\"" } }) }, pm: "npm", test: "npm test", lint: null, build: null, audit: "npm audit --audit-level=moderate" },
  { label: "npm invalid package.json", files: { "package.json": "{ not json" }, pm: "npm", test: "npm test", lint: null, build: null, audit: "npm audit --audit-level=moderate" },
  { label: "bun without package.json", files: { "bun.lockb": "" }, pm: "bun", test: "bun test", lint: null, build: null, audit: "bun pm audit" },
  { label: "python", files: { "pyproject.toml": "[project]\n" }, pm: "python", test: "python -m pytest", lint: null, build: null, audit: "pip-audit" },
  { label: "python + pytest.ini", files: { "uv.lock": "", "pytest.ini": "" }, pm: "python", test: "pytest", lint: null, build: null, audit: "pip-audit" },
  { label: "go", files: { "go.mod": "module x\n" }, pm: "go", test: "go test ./...", lint: "go vet ./...", build: "go build ./...", audit: "go list -m all" },
  { label: "cargo", files: { "Cargo.toml": "[package]\n" }, pm: "cargo", test: "cargo test", lint: "cargo clippy -- -D warnings", build: "cargo build", audit: "cargo audit" },
  { label: "dotnet props", files: { "Directory.Build.props": "<Project />" }, pm: "dotnet", test: "dotnet test", lint: "dotnet format --verify-no-changes", build: "dotnet build", audit: "dotnet list package --vulnerable" },
  { label: "maven", files: { "pom.xml": "<project />" }, pm: "maven", test: "mvn test", lint: "mvn -q checkstyle:check", build: "mvn -q package", audit: "mvn org.owasp:dependency-check-maven:check" },
  { label: "gradle wrapper", files: { "settings.gradle": "", gradlew: "" }, pm: "gradle", test: "./gradlew test", lint: "./gradlew check", build: "./gradlew build", audit: "./gradlew dependencyCheckAnalyze" },
  { label: "gradle", files: { "build.gradle": "" }, pm: "gradle", test: "gradle test", lint: "gradle check", build: "gradle build", audit: "gradle dependencyCheckAnalyze" },
  { label: "php + phpunit", files: { "composer.json": "{}", "vendor/bin/phpunit": "" }, pm: "php", test: "./vendor/bin/phpunit", lint: "composer normalize --dry-run", build: "composer install --no-dev --optimize-autoloader", audit: "composer audit" },
  { label: "ruby + spec", files: { Gemfile: "", "spec/a_spec.rb": "" }, pm: "ruby", test: "bundle exec rspec", lint: "bundle exec rubocop", build: "bundle install", audit: "bundle audit check --update" },
  { label: "unknown", files: { "README.md": "# x" }, pm: "unknown", test: null, lint: null, build: null, audit: null },
];

describe("repo-detect command matrix", () => {
  for (const c of MATRIX) {
    it(`${c.label}: pm, test, lint, build and audit commands`, () => {
      withRepo(c.files, (dir) => {
        assert.equal(detectPackageManager(dir), c.pm);
        assert.equal(detectTestCommand(dir), c.test);
        assert.equal(detectLintCommand(dir), c.lint);
        assert.equal(detectBuildCommand(dir), c.build);
        assert.equal(detectAuditCommand(dir), c.audit);
      });
    });
  }

  it("project.yml commands win over manifest detection", () => {
    const yml = 'commands:\n  test: "make test"\n  lint: make lint\n  build: \'make build\'\n  audit: make audit\nother: x\n';
    withRepo({ ".github/project.yml": yml, "package.json": ALL_SCRIPTS }, (dir) => {
      assert.equal(detectTestCommand(dir), "make test");
      assert.equal(detectLintCommand(dir), "make lint");
      assert.equal(detectBuildCommand(dir), "make build");
      assert.equal(detectAuditCommand(dir), "make audit");
      assert.deepEqual(readProjectCommands(readProjectYmlText(dir)), {
        test: "make test",
        lint: "make lint",
        build: "make build",
        audit: "make audit",
      });
    });
    assert.deepEqual(readProjectCommands(null), {});
    assert.deepEqual(readProjectCommands("ci:\n  policy: detect\n"), {});
  });

  it("stack summary lists every detected ecosystem", () => {
    const files = {
      "package.json": "{}",
      "requirements.txt": "",
      "go.mod": "",
      "Cargo.toml": "",
      "App.sln": "",
      "pom.xml": "",
      "settings.gradle.kts": "",
      "composer.json": "{}",
      Gemfile: "",
      "docker-compose.yml": "",
    };
    withRepo(files, (dir) => {
      assert.deepEqual(detectStackSummary(dir), [
        "node",
        "python",
        "go",
        "rust",
        "dotnet",
        "java-maven",
        "java-gradle",
        "php",
        "ruby",
        "docker",
      ]);
    });
    withRepo({ "bun.lock": "", Dockerfile: "FROM x" }, (dir) => assert.deepEqual(detectStackSummary(dir), ["node", "docker"]));
    withRepo({}, (dir) => assert.deepEqual(detectStackSummary(dir), ["unknown"]));
  });

  it("rootHasFile tolerates unreadable roots", () => {
    assert.equal(rootHasFile(join(tmpdir(), "hyperion-detect-does-not-exist-xyz"), () => true), false);
  });

  it("detectRepoAdaptation bundles everything", () => {
    withRepo({ "go.mod": "module x\n", ".github/project.yml": "commands:\n  test: make check\n" }, (dir) => {
      const a = detectRepoAdaptation(dir);
      assert.equal(a.hyperionInstalled, false);
      assert.equal(a.packageManager, "go");
      assert.deepEqual(a.stack, ["go"]);
      assert.equal(a.test, "make check");
      assert.equal(a.lint, "go vet ./...");
      assert.deepEqual(a.commands, { test: "make check" });
    });
  });
});

describe("repo-detect CLI", () => {
  const run = (cwd, args = []) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };

  it("--json prints the adaptation", () => {
    withRepo({ "Cargo.toml": "[package]\n" }, (dir) => {
      const out = JSON.parse(run(dir, ["--json"]));
      assert.equal(out.packageManager, "cargo");
      assert.equal(out.audit, "cargo audit");
    });
  });

  it("human output suggests a commands block, omitting undetected commands", () => {
    withRepo({ "package.json": ALL_SCRIPTS }, (dir) => {
      const out = run(dir);
      assert.match(out, /Hyperion repo adaptation/);
      assert.match(out, /stack: \["node"\]/);
      assert.match(out, /Suggested project\.yml block:\ncommands:\n {2}test: npm test\n {2}lint: npm run lint\n {2}build: npm run build\n {2}audit: npm audit/);
    });
    withRepo({}, (dir) => {
      const out = run(dir);
      assert.match(out, /Suggested project\.yml block:\r?\ncommands:\s*$/);
    });
  });
});
