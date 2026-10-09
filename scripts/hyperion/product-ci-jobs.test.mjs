import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installSteps, mobileJobs, setupSteps } from "./product-ci-jobs.mjs";

const render = (steps) => steps.join("\n");

describe("setupSteps", () => {
  it("node: bun, explicit version, version file, npm cache and corepack", () => {
    assert.match(render(setupSteps({ setup: { kind: "node", pm: "bun" } })), /oven-sh\/setup-bun@v2/);
    const versioned = render(setupSteps({ setup: { kind: "node", pm: "npm", lockfile: "package-lock.json" } }, { version: "20" }));
    assert.match(versioned, /node-version: "?20"?/);
    assert.match(versioned, /cache: "npm"/);
    assert.match(versioned, /cache-dependency-path: "package-lock.json"/);
    assert.match(render(setupSteps({ setup: { kind: "node", pm: "npm", nodeVersionFile: ".nvmrc" } })), /node-version-file: ".nvmrc"/);
    const pnpm = render(setupSteps({ setup: { kind: "node", pm: "pnpm" } }));
    assert.match(pnpm, /node-version: "?22"?/);
    assert.match(pnpm, /corepack enable/);
    assert.match(render(setupSteps({ setup: { kind: "node", pm: "yarn", nodeVersion: "18" } })), /corepack enable/);
  });

  it("python: version override, version file, default and package-manager installers", () => {
    assert.match(render(setupSteps({ setup: { kind: "python" } }, { version: "3.11" })), /python-version: "?3.11"?/);
    assert.match(render(setupSteps({ setup: { kind: "python", pythonVersionFile: ".python-version" } })), /python-version-file: ".python-version"/);
    assert.match(render(setupSteps({ setup: { kind: "python" } })), /python-version: "?3.12"?/);
    assert.match(render(setupSteps({ setup: { kind: "python", pm: "uv", pythonVersion: "3.13" } })), /pip install uv/);
    assert.match(render(setupSteps({ setup: { kind: "python", pm: "poetry" } })), /pipx install poetry/);
    assert.match(render(setupSteps({ setup: { kind: "python", pm: "pipenv" } })), /pip install pipenv/);
  });

  it("go: version override or go.mod", () => {
    assert.match(render(setupSteps({ setup: { kind: "go" } }, { version: "1.22" })), /go-version: "?1.22"?/);
    assert.match(render(setupSteps({ setup: { kind: "go" } })), /go-version-file: "go.mod"/);
    assert.match(render(setupSteps({ setup: { kind: "go", goVersionFile: "svc/go.mod" } })), /go-version-file: "svc\/go.mod"/);
  });

  it("rust: toolchain pin and cargo-llvm-cov only when coverage is on", () => {
    const pinned = render(setupSteps({ setup: { kind: "rust" } }, { version: "1.80", coverageOn: true }));
    assert.match(pinned, /rustup toolchain install 1.80/);
    assert.match(pinned, /cargo install cargo-llvm-cov/);
    const plain = render(setupSteps({ setup: { kind: "rust" } }));
    assert.doesNotMatch(plain, /rustup toolchain install/);
    assert.doesNotMatch(plain, /llvm-cov/);
    assert.match(plain, /rustup component add clippy rustfmt/);
  });

  it("flutter, dart, dotnet, java, php and ruby", () => {
    assert.match(render(setupSteps({ setup: { kind: "flutter", version: "3.24.0" } })), /flutter-version: "?3.24.0"?/);
    assert.doesNotMatch(render(setupSteps({ setup: { kind: "flutter" } })), /flutter-version/);
    assert.match(render(setupSteps({ setup: { kind: "dart" } }, { version: "3.5" })), /sdk: "?3.5"?/);
    assert.doesNotMatch(render(setupSteps({ setup: { kind: "dart" } })), /sdk:/);
    assert.match(render(setupSteps({ setup: { kind: "dotnet" } })), /dotnet-version: "?8.0.x"?/);
    assert.match(render(setupSteps({ setup: { kind: "dotnet", version: "9.0.x" } })), /dotnet-version: "?9.0.x"?/);
    assert.match(render(setupSteps({ setup: { kind: "java", build: "gradle", version: "17" } })), /cache: "gradle"/);
    const maven = render(setupSteps({ setup: { kind: "java", build: "maven" } }, { version: "11" }));
    assert.match(maven, /cache: "maven"/);
    assert.match(maven, /java-version: "?11"?/);
    assert.match(render(setupSteps({ setup: { kind: "java" } })), /java-version: "?21"?/);
    assert.match(render(setupSteps({ setup: { kind: "php" } }, { coverageOn: true })), /coverage: "pcov"/);
    assert.match(render(setupSteps({ setup: { kind: "php", version: "8.2" } })), /coverage: "none"/);
    const rubyRoot = render(setupSteps({ path: ".", setup: { kind: "ruby" } }));
    assert.match(rubyRoot, /working-directory: "\."/);
    assert.doesNotMatch(rubyRoot, /ruby-version/);
    const rubyNested = render(setupSteps({ path: "api", setup: { kind: "ruby", version: "3.3" } }));
    assert.match(rubyNested, /working-directory: "api"/);
    assert.match(rubyNested, /ruby-version: "?3.3"?/);
  });

  it("unknown or missing setup yields no steps", () => {
    assert.deepEqual(setupSteps({ setup: { kind: "custom" } }), []);
    assert.deepEqual(setupSteps({}), []);
  });
});

describe("installSteps", () => {
  it("skips ruby (bundler-cache installs), prefers the command override and adds CI tools", () => {
    assert.deepEqual(installSteps({ install: "bundle install", setup: { kind: "ruby" } }), []);
    const steps = render(installSteps({ install: "pip install -r requirements.txt", commands: { install: "make deps" }, setup: { kind: "python" } }, ["ruff", "mypy"]));
    assert.match(steps, /\n\s+make deps/);
    assert.match(steps, /pip install ruff mypy/);
    assert.deepEqual(installSteps({ setup: { kind: "go" } }), []);
  });
});

describe("mobileJobs", () => {
  const plan = (mobileBuild) => ({ mobileBuild, affected: { enabled: false }, apps: [] });
  const android = (gradle) => ({
    name: "droid",
    path: "android-app",
    mobile: { android: true, ios: false, kind: "android", gradle },
    setup: { kind: "java", build: "gradle", version: "17" },
    decisions: { version: null },
  });

  it("builds a native Android APK with the Gradle wrapper or plain gradle", () => {
    const [wrapper] = mobileJobs(plan({ mode: "warn", app: "droid", android: true, ios: false }), [android("./gradlew")]);
    assert.match(wrapper, /mobile-android-droid:/);
    assert.match(wrapper, /chmod \+x gradlew/);
    assert.match(wrapper, /\.\/gradlew assembleDebug/);
    assert.match(wrapper, /android-app\/\*\*\/build\/outputs\/apk\/debug\/\*\.apk/);
    const [plain] = mobileJobs(plan({ mode: "block", app: "droid", android: true, ios: true }), [android(null)]);
    assert.doesNotMatch(plain, /chmod/);
    assert.match(plain, /gradle assembleDebug/);
  });

  it("returns nothing when off, the app is unknown, or the app is not mobile", () => {
    assert.deepEqual(mobileJobs(plan({ mode: "off" }), [android("./gradlew")]), []);
    assert.deepEqual(mobileJobs(plan({ mode: "warn", app: "nope", android: true }), [android("./gradlew")]), []);
    assert.deepEqual(mobileJobs(plan({ mode: "warn", app: "web", android: true }), [{ name: "web" }]), []);
  });
});
