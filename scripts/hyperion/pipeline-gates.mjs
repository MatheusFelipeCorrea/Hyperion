/**
 * Repository-wide pipeline gate discovery for /pipeline (pipeline-architect).
 *
 * Walks the whole product repo (bounded depth), finds every app by manifest
 * (monorepos included), and detects which quality gates each one can support:
 * lint, format (styles fix), typecheck, test, coverage, build, audit (+ fix),
 * migrations — plus toolchain versions, test service containers, web/mobile
 * targets and repo-level gates: Docker build/scan/lint/publish, compose smoke,
 * e2e, IaC, commitlint, OpenAPI lint, CodeQL, dependency review, secrets,
 * PR hygiene, docs, Dependabot.
 *
 * Output feeds the gates interview (buildGateQuestions, presets, CI-minute
 * estimate) and the product CI renderer (product-ci-render.mjs). Never writes files.
 *
 * CLI: [--json | --yaml | --preview | --estimate] [--preset minimal|balanced|strict]
 *      [--gates-file draft.yml] [--pending] [--lang <tag> | --en] [--diagram (with --preview)]
 *      Human output follows `locale` in project.yml unless --lang/--en is given.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { normalizeTag, resolveLanguages, t } from "./i18n.mjs";

export const GATE_MODES = ["off", "warn", "block"];
export const COVERAGE_METRICS = ["lines", "statements", "branches", "functions"];
export const AUDIT_LEVELS = ["low", "moderate", "high", "critical"];
export const AUDIT_FIX_MODES = ["off", "check", "pr"];
export const APP_GATES = ["lint", "format", "typecheck", "test", "coverage", "build", "audit", "migrations"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".dart_tool",
  ".gradle",
  "bin",
  "obj",
  "Pods",
  ".idea",
  ".vscode",
  ".turbo",
  ".cache",
  "tmp",
  ".terraform",
  ".pytest_cache",
  ".mypy_cache",
  "fixtures",
  "__fixtures__",
  "testdata",
  "__snapshots__",
]);

const MANIFESTS = [
  { file: "package.json", stack: "node" },
  { file: "pubspec.yaml", stack: "dart" },
  { file: "pyproject.toml", stack: "python" },
  { file: "requirements.txt", stack: "python" },
  { file: "setup.py", stack: "python" },
  { file: "go.mod", stack: "go" },
  { file: "Cargo.toml", stack: "rust" },
  { file: "pom.xml", stack: "java-maven" },
  { file: "build.gradle", stack: "java-gradle" },
  { file: "build.gradle.kts", stack: "java-gradle" },
  { file: "composer.json", stack: "php" },
  { file: "Gemfile", stack: "ruby" },
];

/** Stacks whose nested manifests belong to the outer project (multi-module builds). */
const COLLAPSE_NESTED = new Set(["java-maven", "java-gradle", "dotnet", "rust"]);

const INFRA_IMAGES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "rabbitmq",
  "kafka",
  "zookeeper",
  "elasticsearch",
  "opensearch",
  "minio",
  "localstack",
  "mailhog",
  "mailpit",
  "keycloak",
  "nats",
  "memcached",
  "sqlserver",
  "mssql",
];

const CODEQL_LANGUAGE = {
  node: "javascript-typescript",
  python: "python",
  go: "go",
  "java-maven": "java-kotlin",
  "java-gradle": "java-kotlin",
  dotnet: "csharp",
  ruby: "ruby",
  rust: "rust",
};

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function readJson(abs) {
  const text = readText(abs);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isUnder(child, parent) {
  if (parent === "") return child !== "";
  return child.startsWith(`${parent}/`);
}

function joinRel(dir, file) {
  return dir ? `${dir}/${file}` : file;
}

/**
 * Bounded-depth walk returning repo-relative POSIX file paths.
 * @param {string} root
 * @param {{ maxDepth?: number, skipRel?: string[] }} [opts]
 */
export function walkRepo(root, { maxDepth = 5, skipRel = [] } = {}) {
  const files = [];
  const skip = new Set(skipRel.filter(Boolean).map(toPosix));
  (function visit(dirAbs, rel, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    // Ruby apps keep source binstubs (bin/rails, bin/rake) next to the Gemfile; elsewhere bin/ is build output.
    const rubyBinstubs = entries.some((e) => e.isFile() && e.name === "Gemfile");
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const skipped = SKIP_DIRS.has(e.name) && !(e.name === "bin" && rubyBinstubs);
        if (skipped || skip.has(childRel) || depth >= maxDepth) continue;
        visit(path.join(dirAbs, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
  })(root, "", 0);
  return files.sort();
}

function dirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

function baseOf(rel) {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

function makeIndex(files) {
  const set = new Set(files);
  return {
    files,
    has: (rel) => set.has(rel),
    inDir: (dir, re) => files.filter((f) => dirOf(f) === dir && re.test(baseOf(f))),
    anyIn: (dir, names) => names.find((n) => set.has(joinRel(dir, n))) || null,
  };
}

/**
 * Locate app roots by manifest. Collapses multi-module builds, npm/yarn/pnpm
 * workspaces and native sub-projects of Flutter apps (android/ ios/).
 */
export function findApps(files, root = process.cwd()) {
  const idx = makeIndex(files);
  const byDir = new Map();
  const add = (dir, stack, manifest) => {
    const key = `${stack}::${dir}`;
    if (!byDir.has(key)) byDir.set(key, { dir, stack, manifests: [] });
    byDir.get(key).manifests.push(manifest);
  };

  for (const f of files) {
    const name = baseOf(f);
    const m = MANIFESTS.find((x) => x.file === name);
    if (m) add(dirOf(f), m.stack, f);
    if (/\.(sln|csproj|fsproj)$/i.test(name)) add(dirOf(f), "dotnet", f);
  }

  let apps = [...byDir.values()];

  const dotnetSln = apps.filter((a) => a.stack === "dotnet" && a.manifests.some((m) => /\.sln$/i.test(m)));
  if (dotnetSln.length) {
    apps = apps.filter((a) => a.stack !== "dotnet" || dotnetSln.includes(a));
  }

  const dartDirs = apps.filter((a) => a.stack === "dart").map((a) => a.dir);
  const workspaceRoots = apps
    .filter((a) => a.stack === "node")
    .filter((a) => {
      const pkg = readJson(path.join(root, a.dir, "package.json"));
      return Boolean(pkg?.workspaces) || idx.has(joinRel(a.dir, "pnpm-workspace.yaml"));
    })
    .map((a) => a.dir);

  apps = apps.filter((a) => {
    if (dartDirs.some((d) => a.stack !== "dart" && isUnder(a.dir, d))) return false;
    if (a.stack === "node" && workspaceRoots.some((w) => isUnder(a.dir, w))) return false;
    if (COLLAPSE_NESTED.has(a.stack)) {
      return !apps.some((o) => o !== a && o.stack === a.stack && isUnder(a.dir, o.dir));
    }
    return true;
  });

  return { apps, idx };
}

function detectNodePm(root, dir, idx) {
  for (const d of dir ? [dir, ""] : [""]) {
    if (idx.has(joinRel(d, "pnpm-lock.yaml"))) return "pnpm";
    if (idx.has(joinRel(d, "yarn.lock"))) return "yarn";
    if (idx.has(joinRel(d, "bun.lockb")) || idx.has(joinRel(d, "bun.lock"))) return "bun";
    if (idx.has(joinRel(d, "package-lock.json"))) return "npm";
  }
  const pkg = readJson(path.join(root, dir, "package.json"));
  const field = String(pkg?.packageManager || "");
  if (field.startsWith("pnpm")) return "pnpm";
  if (field.startsWith("yarn")) return "yarn";
  if (field.startsWith("bun")) return "bun";
  return "npm";
}

function lockfileFor(pm, dir, idx) {
  const names = {
    npm: ["package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    bun: ["bun.lock", "bun.lockb"],
  }[pm];
  for (const d of dir ? [dir, ""] : [""]) {
    const hit = names.find((n) => idx.has(joinRel(d, n)));
    if (hit) return joinRel(d, hit);
  }
  return null;
}

function gate(command, extra = {}) {
  return command ? { command, ...extra } : null;
}

/** asdf/mise `.tool-versions` (repo root, then the app dir). */
function readToolVersions(root, dir) {
  const out = {};
  for (const d of dir ? ["", dir] : [""]) {
    const text = readText(path.join(root, d, ".tool-versions"));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^([\w-]+)\s+(\S+)/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
    }
  }
  return out;
}

const majorMinor = (v) => (String(v || "").match(/(\d+\.\d+)/) || [])[1] || null;

function javaMajor(v) {
  const s = String(v || "");
  const legacy = s.match(/\b1\.(\d+)\b/);
  if (legacy) return legacy[1];
  return (s.match(/(\d+)/) || [])[1] || null;
}

function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = String(text || "").match(re);
    if (m) return m[1];
  }
  return null;
}

function nodeAnalysis(root, app, idx) {
  const { dir } = app;
  const pkg = readJson(path.join(root, dir, "package.json")) || {};
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const pm = detectNodePm(root, dir, idx);
  const yarnBerry = pm === "yarn" && (idx.has(joinRel(dir, ".yarnrc.yml")) || idx.has(".yarnrc.yml"));
  const lockfile = lockfileFor(pm, dir, idx);

  const run = (s) => (pm === "npm" ? `npm run ${s}` : pm === "yarn" ? `yarn ${s}` : `${pm} run ${s}`);
  const runArgs = (s, args) => (pm === "npm" ? `npm run ${s} -- ${args}` : `${run(s)} ${args}`);
  const exec = (bin) =>
    pm === "pnpm" ? `pnpm exec ${bin}` : pm === "yarn" ? `yarn ${bin}` : pm === "bun" ? `bunx ${bin}` : `npx ${bin}`;
  const script = (...names) => names.find((n) => typeof scripts[n] === "string" && scripts[n].trim());
  const cfg = (re) => idx.inDir(dir, re).length > 0;

  const install = {
    npm: lockfile ? "npm ci" : "npm install",
    pnpm: "pnpm install --frozen-lockfile",
    yarn: yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile",
    bun: "bun install --frozen-lockfile",
  }[pm];

  const hasEslint = has("eslint") || cfg(/^(\.eslintrc(\..+)?|eslint\.config\.(js|mjs|cjs|ts))$/);
  const hasBiome = has("@biomejs/biome") || cfg(/^biome\.jsonc?$/);
  const hasPrettier = has("prettier") || cfg(/^\.prettierrc(\..+)?$|^prettier\.config\./) || Boolean(pkg.prettier);

  const lintScript = script("lint");
  const lintFixScript = script("lint:fix", "fix:lint");
  const lintFix = lintFixScript ? run(lintFixScript) : hasEslint ? exec("eslint . --fix") : hasBiome ? exec("biome lint --write .") : null;
  const formatFixScript = script("format", "format:fix", "prettier:write", "fmt");
  const formatFix = formatFixScript
    ? run(formatFixScript)
    : hasPrettier
      ? exec("prettier --write .")
      : hasBiome
        ? exec("biome format --write .")
        : null;
  const lint = lintScript
    ? gate(run(lintScript), { evidence: `scripts.${lintScript}`, fix: lintFix })
    : hasEslint
      ? gate(exec("eslint ."), { evidence: "eslint", fix: exec("eslint . --fix") })
      : hasBiome
        ? gate(exec("biome lint ."), { evidence: "biome", fix: exec("biome lint --write .") })
        : null;

  const fmtCheck = script("format:check", "prettier:check", "check:format", "fmt:check", "lint:format");
  const format = fmtCheck
    ? gate(run(fmtCheck), { evidence: `scripts.${fmtCheck}`, fix: formatFix })
    : hasPrettier
      ? gate(exec("prettier --check ."), { evidence: "prettier", fix: exec("prettier --write .") })
      : hasBiome
        ? gate(exec("biome format ."), { evidence: "biome", fix: exec("biome format --write .") })
        : has("dprint")
          ? gate(exec("dprint check"), { evidence: "dprint", fix: exec("dprint fmt") })
          : null;

  const tcScript = script("typecheck", "type-check", "check-types", "types", "tsc");
  const hasTsconfig = idx.has(joinRel(dir, "tsconfig.json"));
  const typecheck = tcScript
    ? gate(run(tcScript), { evidence: `scripts.${tcScript}` })
    : has("vue-tsc")
      ? gate(exec("vue-tsc --noEmit"), { evidence: "vue-tsc" })
      : hasTsconfig && has("typescript")
        ? gate(exec("tsc --noEmit"), { evidence: "tsconfig.json" })
        : null;

  const testScript = typeof scripts.test === "string" && !/no test specified/i.test(scripts.test) ? "test" : null;
  const test = testScript ? gate(pm === "npm" ? "npm test" : run("test"), { evidence: "scripts.test" }) : null;

  const testText = String(scripts.test || "");
  const istanbulArgs = "--coverage --coverageReporters=json-summary --coverageReporters=text --coverageReporters=lcov";
  const vitestArgs = "--coverage --coverage.reporter=json-summary --coverage.reporter=text --coverage.reporter=lcov";
  const vitestProvider = has("@vitest/coverage-v8") || has("@vitest/coverage-istanbul");
  let coverage = null;
  if (testScript && /\bjest\b/.test(testText)) {
    coverage = gate(runArgs("test", istanbulArgs), { tool: "jest", report: "coverage/coverage-summary.json" });
  } else if (testScript && /\bvitest\b/.test(testText)) {
    coverage = gate(runArgs("test", vitestArgs), {
      tool: "vitest",
      report: "coverage/coverage-summary.json",
      needs: vitestProvider ? null : "@vitest/coverage-v8",
    });
  } else if (has("vitest")) {
    coverage = gate(exec(`vitest run ${vitestArgs}`), {
      tool: "vitest",
      report: "coverage/coverage-summary.json",
      needs: vitestProvider ? null : "@vitest/coverage-v8",
    });
  } else if (has("jest") || cfg(/^jest\.config\./)) {
    coverage = gate(exec(`jest ${istanbulArgs}`), { tool: "jest", report: "coverage/coverage-summary.json" });
  } else {
    const covScript = script("test:coverage", "coverage", "test:cov", "cov");
    if (covScript) coverage = gate(run(covScript), { tool: `scripts.${covScript}`, report: null });
    else if (has("c8")) coverage = gate(`${exec("c8")} --reporter=json-summary --reporter=text ${pm === "npm" ? "npm test" : run("test")}`, { tool: "c8", report: "coverage/coverage-summary.json" });
  }

  const buildScript = script("build");
  const build = buildScript ? gate(run(buildScript), { evidence: "scripts.build" }) : null;

  const auditCmd = {
    npm: "npm audit --audit-level={level}",
    pnpm: "pnpm audit --audit-level {level}",
    yarn: yarnBerry ? "yarn npm audit --all --recursive --severity {level}" : "yarn audit --level {level}",
    bun: "bun audit --audit-level={level}",
  }[pm];
  const auditFix = { npm: "npm audit fix", pnpm: "pnpm audit --fix" }[pm] || null;
  const audit = gate(auditCmd, { fix: auditFix, manifests: [joinRel(dir, "package.json"), lockfile].filter(Boolean) });

  const prismaSchema = ["prisma/schema.prisma", "schema.prisma"].map((p) => joinRel(dir, p)).find((p) => idx.has(p));
  const migrations = prismaSchema && has("prisma")
    ? gate(exec("prisma validate"), { evidence: prismaSchema, tool: "prisma" })
    : null;

  const nodeVersionFile = [joinRel(dir, ".nvmrc"), joinRel(dir, ".node-version"), ".nvmrc", ".node-version"].find((p) =>
    idx.has(p)
  );
  const enginesMajor = String(pkg.engines?.node || "").match(/(\d{2,})/)?.[1] || null;
  const tv = readToolVersions(root, dir);
  const nodeVersion = nodeVersionFile ? null : tv.nodejs || enginesMajor || "22";

  const sizeLimit = Boolean(pkg["size-limit"]) || cfg(/^\.size-limit(\.(json|js|cjs|mjs|ts))?$/);
  const bundleSize = sizeLimit ? gate(exec("size-limit"), { evidence: "size-limit" }) : null;

  return {
    pm,
    install,
    setup: {
      kind: "node",
      pm,
      lockfile,
      nodeVersionFile: nodeVersionFile || null,
      nodeVersion,
      version: nodeVersionFile ? null : nodeVersion,
      versionSource: nodeVersionFile || (tv.nodejs ? ".tool-versions" : enginesMajor ? "engines.node" : "default"),
    },
    gates: { lint, format, typecheck, test, coverage, build, audit, migrations },
    migrate: migrations ? exec("prisma migrate deploy") : null,
    web: buildScript ? detectWebApp(deps, scripts, run, pkg) : null,
    bundleSize,
    library: pkg.private !== true && Boolean(pkg.main || pkg.exports || pkg.module) && !script("start", "dev"),
    deps: Object.keys(deps),
    tooling: !testScript && !buildScript && !lintScript && !fmtCheck && !tcScript && !script("start", "dev"),
    packageName: pkg.name || null,
  };
}

/** Front-end framework + where its static build lands (or how to serve it). */
function detectWebApp(deps, scripts, run, pkg) {
  const buildText = String(scripts.build || "");
  const BUILD_BIN = {
    next: /\bnext\s+build\b/,
    nuxt: /\bnuxt\s+(build|generate)\b/,
    astro: /\bastro\s+build\b/,
    gatsby: /\bgatsby\s+build\b/,
    "@angular/core": /\bng\s+build\b/,
    "react-scripts": /\breact-scripts\s+build\b/,
    "@vue/cli-service": /\bvue-cli-service\s+build\b/,
    vite: /\bvite\s+build\b/,
  };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n) || Boolean(BUILD_BIN[n]?.test(buildText));
  const start = typeof scripts.start === "string" ? run("start") : null;
  const preview = typeof scripts.preview === "string" ? run("preview") : null;
  if (has("next")) return { framework: "next", dist: null, start, url: "http://localhost:3000" };
  if (has("nuxt")) return { framework: "nuxt", dist: null, start: preview || start, url: "http://localhost:3000" };
  if (has("@remix-run/react")) return { framework: "remix", dist: null, start, url: "http://localhost:3000" };
  if (has("@sveltejs/kit")) return { framework: "sveltekit", dist: null, start: preview, url: "http://localhost:4173" };
  if (has("astro")) return { framework: "astro", dist: "dist", start: null, url: null };
  if (has("gatsby")) return { framework: "gatsby", dist: "public", start: null, url: null };
  if (has("@angular/core")) return { framework: "angular", dist: `dist/${pkg.name || "app"}/browser`, start: null, url: null };
  if (has("react-scripts")) return { framework: "cra", dist: "build", start: null, url: null };
  if (has("@vue/cli-service")) return { framework: "vue-cli", dist: "dist", start: null, url: null };
  if (has("vite")) {
    const ui = ["react", "vue", "svelte", "solid-js", "preact", "lit"].find(has);
    return { framework: ui ? `vite-${ui}` : "vite", dist: "dist", start: null, url: null };
  }
  return null;
}

function pythonAnalysis(root, app, idx) {
  const { dir } = app;
  const read = (f) => readText(path.join(root, dir, f)) || "";
  const pyproject = read("pyproject.toml");
  const reqFiles = idx.inDir(dir, /^requirements.*\.txt$/i).map((f) => baseOf(f));
  const reqText = reqFiles.map((f) => read(f)).join("\n");
  const setupCfg = read("setup.cfg");
  const all = `${pyproject}\n${reqText}\n${setupCfg}\n${read("Pipfile")}`;
  const mentions = (name) => new RegExp(`(^|[\\s"'\\[,=])${name.replace(/[-]/g, "[-_]")}([\\s"'\\]<>=~!,;]|$)`, "im").test(all);
  const cfg = (...names) => names.some((n) => idx.has(joinRel(dir, n)));

  const pm = idx.has(joinRel(dir, "uv.lock"))
    ? "uv"
    : idx.has(joinRel(dir, "poetry.lock")) || /\[tool\.poetry\]/.test(pyproject)
      ? "poetry"
      : idx.has(joinRel(dir, "Pipfile"))
        ? "pipenv"
        : "pip";
  const prefix = { uv: "uv run ", poetry: "poetry run ", pipenv: "pipenv run ", pip: "" }[pm];

  const install = {
    uv: "uv sync --all-extras --dev",
    poetry: "poetry install --no-interaction",
    pipenv: "pipenv install --dev --deploy",
    pip: reqFiles.length
      ? reqFiles
          .filter((f) => /^requirements(-dev|-test|_dev|_test)?\.txt$/i.test(f))
          .map((f) => `pip install -r ${f}`)
          .join(" && ") || `pip install -r ${reqFiles[0]}`
      : pyproject
        ? 'pip install -e ".[dev]" || pip install -e .'
        : "pip install -r requirements.txt",
  }[pm];

  const tools = [];
  const use = (tool, declared) => {
    if (!declared && !tools.includes(tool)) tools.push(tool);
    return declared ? `${prefix}${tool}` : tool;
  };

  const ruff = mentions("ruff") || /\[tool\.ruff/.test(pyproject) || cfg("ruff.toml", ".ruff.toml");
  const black = mentions("black") || /\[tool\.black\]/.test(pyproject);
  const flake8 = mentions("flake8") || cfg(".flake8") || /\[flake8\]/.test(setupCfg);
  const mypy = mentions("mypy") || /\[tool\.mypy\]/.test(pyproject) || cfg("mypy.ini", ".mypy.ini");
  const pytest = mentions("pytest") || /\[tool\.pytest/.test(pyproject) || cfg("pytest.ini", "conftest.py") ||
    idx.files.some((f) => isUnder(f, joinRel(dir, "tests")));
  const pytestCov = mentions("pytest-cov");
  const django = idx.has(joinRel(dir, "manage.py"));

  const lint = ruff
    ? gate(`${use("ruff", mentions("ruff"))} check .`, { evidence: "ruff", fix: "ruff check --fix ." })
    : flake8
      ? gate(`${use("flake8", mentions("flake8"))} .`, { evidence: "flake8" })
      : null;
  const format = black
    ? gate(`${use("black", mentions("black"))} --check .`, { evidence: "black", fix: "black ." })
    : ruff
      ? gate(`${use("ruff", mentions("ruff"))} format --check .`, { evidence: "ruff format", fix: "ruff format ." })
      : null;
  const typecheck = mypy ? gate(`${use("mypy", mentions("mypy"))} .`, { evidence: "mypy" }) : null;
  const test = pytest
    ? gate(`${prefix}pytest`, { evidence: "pytest" })
    : django
      ? gate(`${prefix}python manage.py test`, { evidence: "manage.py" })
      : null;
  if (pytest && !mentions("pytest") && pm === "pip") tools.push("pytest");
  const coverage = pytest
    ? gate(`${prefix}pytest --cov --cov-report=xml --cov-report=term`, {
        tool: "pytest-cov",
        report: "coverage.xml",
        needs: pytestCov ? null : "pytest-cov",
      })
    : null;
  if (coverage && !pytestCov && pm === "pip" && !tools.includes("pytest-cov")) tools.push("pytest-cov");

  const reqMain = reqFiles.find((f) => /^requirements\.txt$/i.test(f));
  const audit = gate(reqMain ? `pip-audit -r ${reqMain}` : "pip-audit", {
    fix: reqMain ? `pip-audit -r ${reqMain} --fix` : null,
    levelUnsupported: true,
    installTool: "pip-audit",
    manifests: [reqMain ? joinRel(dir, reqMain) : joinRel(dir, "pyproject.toml")],
  });
  const migrations = django
    ? gate(`${prefix}python manage.py makemigrations --check --dry-run`, { evidence: "manage.py", tool: "django" })
    : null;

  const pyVersionFile = [joinRel(dir, ".python-version"), ".python-version"].find((p) => idx.has(p));
  const tv = readToolVersions(root, dir);
  const requires = majorMinor(firstMatch(pyproject, [/requires-python\s*=\s*["'][^"'\d]*([\d.]+)/]));
  const pythonVersion = pyVersionFile ? null : tv.python || requires || "3.12";
  const alembic = idx.has(joinRel(dir, "alembic.ini"));
  return {
    pm,
    install,
    setup: {
      kind: "python",
      pm,
      pythonVersionFile: pyVersionFile || null,
      pythonVersion,
      version: pythonVersion,
      versionSource: pyVersionFile || (tv.python ? ".tool-versions" : requires ? "requires-python" : "default"),
      tools,
    },
    gates: { lint, format, typecheck, test, coverage, build: null, audit, migrations },
    migrate: django
      ? `${prefix}python manage.py migrate --noinput`
      : alembic
        ? `${prefix}alembic upgrade head`
        : null,
    manifestText: all,
  };
}

function goAnalysis(root, app, idx) {
  const { dir } = app;
  const golangci = idx.anyIn(dir, [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"]);
  const gomod = readText(path.join(root, dir, "go.mod")) || "";
  return {
    pm: "go",
    install: "go mod download",
    manifestText: gomod,
    setup: {
      kind: "go",
      goVersionFile: joinRel(dir, "go.mod"),
      golangci: Boolean(golangci),
      version: firstMatch(gomod, [/^go\s+([\d.]+)/m]),
      versionSource: "go.mod",
    },
    gates: {
      lint: golangci
        ? gate("golangci-lint run", { evidence: golangci })
        : gate("go vet ./...", { evidence: "go vet" }),
      format: gate('test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }', { evidence: "gofmt", fix: "gofmt -w ." }),
      typecheck: null,
      test: gate("go test ./...", { evidence: "go.mod" }),
      coverage: gate("go test -coverprofile=coverage.out ./...", { tool: "go cover", report: "coverage.out" }),
      build: gate("go build ./...", { evidence: "go.mod" }),
      audit: gate("go run golang.org/x/vuln/cmd/govulncheck@latest ./...", { levelUnsupported: true, fix: null }),
      migrations: null,
    },
  };
}

function rustAnalysis() {
  return {
    pm: "cargo",
    install: "cargo fetch",
    setup: { kind: "rust" },
    gates: {
      lint: gate("cargo clippy --all-targets -- -D warnings", { evidence: "clippy" }),
      format: gate("cargo fmt --all -- --check", { evidence: "rustfmt", fix: "cargo fmt --all" }),
      typecheck: null,
      test: gate("cargo test", { evidence: "Cargo.toml" }),
      coverage: gate("cargo llvm-cov --lcov --output-path lcov.info", {
        tool: "cargo-llvm-cov",
        report: "lcov.info",
        needs: "cargo-llvm-cov (installed in CI)",
      }),
      build: gate("cargo build --locked", { evidence: "Cargo.toml" }),
      audit: gate("cargo audit", { levelUnsupported: true, installTool: "cargo-audit", fix: null }),
      migrations: null,
    },
  };
}

function dartAnalysis(root, app, idx) {
  const { dir } = app;
  const pubspec = readText(path.join(root, dir, "pubspec.yaml")) || "";
  const flutter = /sdk:\s*flutter/.test(pubspec);
  const hasDir = (d) => idx.files.some((f) => isUnder(f, joinRel(dir, d)));
  const fmtTargets = ["lib", "test", "bin"].filter(hasDir).join(" ") || ".";
  const tool = flutter ? "flutter" : "dart";
  const tv = readToolVersions(root, dir);
  const fvmrc = readJson(path.join(root, dir, ".fvmrc")) || readJson(path.join(root, ".fvmrc"));
  const fvmLegacy = readJson(path.join(root, dir, ".fvm", "fvm_config.json"));
  const exactPubspec = firstMatch(pubspec, [/^\s+flutter:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m]);
  const flutterVersion = flutter
    ? fvmrc?.flutter || fvmLegacy?.flutterSdkVersion || (tv.flutter ? tv.flutter.replace(/-stable$/, "") : null) || exactPubspec
    : null;
  return {
    pm: tool,
    install: `${tool} pub get`,
    setup: {
      kind: flutter ? "flutter" : "dart",
      version: flutterVersion || null,
      versionSource: flutterVersion ? (fvmrc || fvmLegacy ? "fvm" : tv.flutter ? ".tool-versions" : "pubspec.yaml") : "stable channel",
    },
    flutter,
    mobile: flutter && (hasDir("android") || hasDir("ios")) ? { android: hasDir("android"), ios: hasDir("ios"), kind: "flutter" } : null,
    gates: {
      lint: gate(flutter ? "flutter analyze --no-fatal-infos" : "dart analyze", { evidence: "analysis_options.yaml" }),
      format: gate(`dart format --output=none --set-exit-if-changed ${fmtTargets}`, {
        evidence: "dart format",
        fix: `dart format ${fmtTargets}`,
      }),
      typecheck: null,
      test: hasDir("test") ? gate(`${tool} test`, { evidence: "test/" }) : null,
      coverage:
        flutter && hasDir("test")
          ? gate("flutter test --coverage", { tool: "flutter", report: "coverage/lcov.info" })
          : null,
      build: null,
      audit: null,
      migrations: null,
    },
  };
}

function dotnetAnalysis(root, app, idx) {
  const { dir } = app;
  const globalJson = readJson(path.join(root, dir, "global.json")) || readJson(path.join(root, "global.json"));
  const csproj = idx.files.find((f) => (dirOf(f) === dir || isUnder(f, dir)) && /\.(csproj|fsproj)$/i.test(f));
  const csprojText = csproj ? readText(path.join(root, csproj)) || "" : "";
  const fromGlobal = majorMinor(globalJson?.sdk?.version);
  const fromTfm = firstMatch(csprojText, [/<TargetFrameworks?>[^<]*?net(\d+\.\d+)/]);
  const version = `${fromGlobal || fromTfm || "8.0"}.x`;
  return {
    pm: "dotnet",
    install: "dotnet restore",
    manifestText: csprojText,
    setup: { kind: "dotnet", version, versionSource: fromGlobal ? "global.json" : fromTfm ? "TargetFramework" : "default" },
    gates: {
      lint: null,
      format: gate("dotnet format --verify-no-changes --no-restore", { evidence: "dotnet format", fix: "dotnet format" }),
      typecheck: null,
      test: gate("dotnet test --no-restore", { evidence: ".sln/.csproj" }),
      coverage: gate('dotnet test --no-restore --collect:"XPlat Code Coverage" --results-directory ./TestResults', {
        tool: "coverlet",
        report: "TestResults/**/coverage.cobertura.xml",
      }),
      build: gate("dotnet build --no-restore", { evidence: ".sln/.csproj" }),
      audit: gate(
        "dotnet list package --vulnerable --include-transitive 2>&1 | tee audit.txt; ! grep -qi 'has the following vulnerable packages' audit.txt",
        { levelUnsupported: true, fix: null }
      ),
      migrations: null,
    },
  };
}

function javaVersion(root, dir, buildText, regexes) {
  const file = readText(path.join(root, dir, ".java-version")) || readText(path.join(root, ".java-version"));
  const tv = readToolVersions(root, dir).java;
  const fromBuild = firstMatch(buildText, regexes);
  const raw = file?.trim() || tv || (fromBuild ? fromBuild.replace(/_/g, ".") : null);
  return {
    version: javaMajor(raw) || "21",
    versionSource: file ? ".java-version" : tv ? ".tool-versions" : fromBuild ? "build file" : "default",
  };
}

function mavenAnalysis(root, app, idx) {
  const { dir } = app;
  const pom = readText(path.join(root, dir, "pom.xml")) || "";
  const mvn = idx.has(joinRel(dir, "mvnw")) ? "./mvnw -B" : "mvn -B";
  const jacoco = /jacoco-maven-plugin/.test(pom);
  const java = javaVersion(root, dir, pom, [
    /<maven\.compiler\.release>\s*([\d.]+)/,
    /<java\.version>\s*([\d.]+)/,
    /<maven\.compiler\.source>\s*([\d.]+)/,
    /<release>\s*([\d.]+)\s*<\/release>/,
  ]);
  return {
    pm: "maven",
    install: `${mvn} -q dependency:go-offline`,
    manifestText: pom,
    setup: { kind: "java", build: "maven", ...java },
    gates: {
      lint: /maven-checkstyle-plugin/.test(pom) ? gate(`${mvn} checkstyle:check`, { evidence: "checkstyle" }) : null,
      format: /spotless-maven-plugin/.test(pom)
        ? gate(`${mvn} spotless:check`, { evidence: "spotless", fix: `${mvn} spotless:apply` })
        : null,
      typecheck: null,
      test: gate(`${mvn} test`, { evidence: "pom.xml" }),
      coverage: jacoco
        ? gate(`${mvn} verify`, { tool: "jacoco", report: "target/site/jacoco/jacoco.xml" })
        : null,
      build: gate(`${mvn} package -DskipTests`, { evidence: "pom.xml" }),
      audit: /dependency-check-maven/.test(pom)
        ? gate(`${mvn} org.owasp:dependency-check-maven:check`, { levelUnsupported: true, fix: null })
        : null,
      migrations: null,
    },
    hints: jacoco ? [] : ["coverage: add jacoco-maven-plugin to enable the coverage gate"],
  };
}

function gradleAnalysis(root, app, idx) {
  const { dir } = app;
  const moduleFiles = idx.files.filter((f) => isUnder(f, dir) && /(^|\/)build\.gradle(\.kts)?$/.test(f) && f.split("/").length - (dir ? dir.split("/").length : 0) <= 2);
  const text = [
    ...["build.gradle", "build.gradle.kts"].map((f) => readText(path.join(root, dir, f)) || ""),
    ...moduleFiles.map((f) => readText(path.join(root, f)) || ""),
  ].join("\n");
  const gw = idx.has(joinRel(dir, "gradlew")) ? "./gradlew" : "gradle";
  const plugin = (re) => re.test(text);
  const java = javaVersion(root, dir, text, [
    /jvmToolchain\(\s*(\d+)\s*\)/,
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
    /JavaVersion\.VERSION_([\d_]+)/,
    /sourceCompatibility\s*=\s*["']?([\d.]+)/,
  ]);
  const android = /com\.android\.application/.test(text);
  return {
    pm: "gradle",
    install: `${gw} --version`,
    manifestText: text,
    mobile: android ? { android: true, ios: false, kind: "android", gradle: gw } : null,
    setup: { kind: "java", build: "gradle", wrapper: gw === "./gradlew", ...java },
    gates: {
      lint: plugin(/detekt/)
        ? gate(`${gw} detekt`, { evidence: "detekt" })
        : plugin(/ktlint/)
          ? gate(`${gw} ktlintCheck`, { evidence: "ktlint" })
          : plugin(/checkstyle/)
            ? gate(`${gw} checkstyleMain`, { evidence: "checkstyle" })
            : null,
      format: plugin(/spotless/) ? gate(`${gw} spotlessCheck`, { evidence: "spotless", fix: `${gw} spotlessApply` }) : null,
      typecheck: null,
      test: gate(`${gw} test`, { evidence: "build.gradle" }),
      coverage: plugin(/kover/)
        ? gate(`${gw} koverXmlReport`, { tool: "kover", report: "build/reports/kover/report.xml" })
        : plugin(/jacoco/)
          ? gate(`${gw} test jacocoTestReport`, { tool: "jacoco", report: "build/reports/jacoco/test/jacocoTestReport.xml" })
          : null,
      build: gate(`${gw} build -x test`, { evidence: "build.gradle" }),
      audit: plugin(/dependencycheck|dependency-check/i)
        ? gate(`${gw} dependencyCheckAnalyze`, { levelUnsupported: true, fix: null })
        : null,
      migrations: null,
    },
  };
}

function phpAnalysis(root, app, idx) {
  const { dir } = app;
  const composer = readJson(path.join(root, dir, "composer.json")) || {};
  const deps = { ...(composer.require || {}), ...(composer["require-dev"] || {}) };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const cfg = (re) => idx.inDir(dir, re).length > 0;
  const phpunit = has("phpunit/phpunit") || cfg(/^phpunit\.xml(\.dist)?$/);
  const composerPhp = majorMinor(composer.require?.php);
  const toolVersionsPhp = readToolVersions(root, dir).php || null;
  const phpVersion = composerPhp || toolVersionsPhp;
  const phpVersionSource = composerPhp ? "composer.json" : toolVersionsPhp ? ".tool-versions" : "default";
  return {
    pm: "composer",
    install: "composer install --no-interaction --prefer-dist",
    manifestText: JSON.stringify(deps),
    migrate: idx.has(joinRel(dir, "artisan")) ? "php artisan migrate --force" : null,
    setup: { kind: "php", version: phpVersion || "8.3", versionSource: phpVersionSource },
    gates: {
      lint: has("phpstan/phpstan") || cfg(/^phpstan\.neon(\.dist)?$/)
        ? gate("vendor/bin/phpstan analyse", { evidence: "phpstan" })
        : null,
      format: has("friendsofphp/php-cs-fixer") || cfg(/^\.php-cs-fixer(\.dist)?\.php$/)
        ? gate("vendor/bin/php-cs-fixer fix --dry-run --diff", { evidence: "php-cs-fixer", fix: "vendor/bin/php-cs-fixer fix" })
        : has("laravel/pint")
          ? gate("vendor/bin/pint --test", { evidence: "pint", fix: "vendor/bin/pint" })
          : null,
      typecheck: null,
      test: has("pestphp/pest")
        ? gate("vendor/bin/pest", { evidence: "pest" })
        : phpunit
          ? gate("vendor/bin/phpunit", { evidence: "phpunit" })
          : null,
      coverage: phpunit
        ? gate("vendor/bin/phpunit --coverage-cobertura coverage.xml", { tool: "phpunit", report: "coverage.xml" })
        : null,
      build: null,
      audit: gate("composer audit", { levelUnsupported: true, fix: null }),
      migrations: null,
    },
  };
}

function rubyAnalysis(root, app, idx) {
  const { dir } = app;
  const gemfile = readText(path.join(root, dir, "Gemfile")) || "";
  const gem = (n) => new RegExp(`gem\\s+["']${n}["']`).test(gemfile);
  const rspec = gem("rspec") || gem("rspec-rails") || idx.files.some((f) => isUnder(f, joinRel(dir, "spec")));
  const testCmd = rspec ? "bundle exec rspec" : "bundle exec rake test";
  const rubyVersionFile = (readText(path.join(root, dir, ".ruby-version")) || readText(path.join(root, ".ruby-version")) || "").trim();
  const toolVersionsRuby = readToolVersions(root, dir).ruby || null;
  const rubyVersion = rubyVersionFile || toolVersionsRuby;
  const rubyVersionSource = rubyVersionFile ? ".ruby-version" : toolVersionsRuby ? ".tool-versions" : "setup-ruby default";
  const rails = idx.has(joinRel(dir, "bin/rails"));
  return {
    pm: "bundler",
    install: "bundle install",
    manifestText: gemfile,
    migrate: rails ? "bin/rails db:prepare" : null,
    setup: { kind: "ruby", version: rubyVersion, versionSource: rubyVersionSource },
    gates: {
      lint: gem("rubocop") || idx.has(joinRel(dir, ".rubocop.yml"))
        ? gate("bundle exec rubocop", { evidence: "rubocop", fix: "bundle exec rubocop -a" })
        : null,
      format: gem("standard") ? gate("bundle exec standardrb", { evidence: "standard", fix: "bundle exec standardrb --fix" }) : null,
      typecheck: gem("sorbet") ? gate("bundle exec srb tc", { evidence: "sorbet" }) : null,
      test: gate(testCmd, { evidence: rspec ? "rspec" : "rake" }),
      coverage: gem("simplecov") ? gate(testCmd, { tool: "simplecov", report: "coverage/.last_run.json" }) : null,
      build: null,
      audit: gate(gem("bundler-audit") ? "bundle exec bundle-audit check --update" : "gem install bundler-audit && bundle-audit check --update", {
        levelUnsupported: true,
        fix: null,
      }),
      migrations: idx.has(joinRel(dir, "bin/rails"))
        ? gate("bin/rails db:migrate:status", { evidence: "rails", tool: "rails" })
        : null,
    },
  };
}

const ANALYZERS = {
  node: nodeAnalysis,
  python: pythonAnalysis,
  go: goAnalysis,
  rust: rustAnalysis,
  dart: dartAnalysis,
  dotnet: dotnetAnalysis,
  "java-maven": mavenAnalysis,
  "java-gradle": gradleAnalysis,
  php: phpAnalysis,
  ruby: rubyAnalysis,
};

/**
 * Service containers for integration tests (job-level `services:`, Linux runners only).
 * `env` is exported to the job so apps find the service on localhost.
 */
export const SERVICE_CATALOG = Object.freeze({
  postgres: {
    image: "postgres:16",
    env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app_test" },
    ports: ["5432:5432"],
    options: '--health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 20',
    jobEnv: { DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app_test" },
  },
  mysql: {
    image: "mysql:8",
    env: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "app_test" },
    ports: ["3306:3306"],
    options: '--health-cmd "mysqladmin ping -h 127.0.0.1 -proot" --health-interval 5s --health-timeout 5s --health-retries 20',
    jobEnv: { DATABASE_URL: "mysql://root:root@127.0.0.1:3306/app_test" },
  },
  mariadb: {
    image: "mariadb:11",
    env: { MARIADB_ROOT_PASSWORD: "root", MARIADB_DATABASE: "app_test" },
    ports: ["3306:3306"],
    options: '--health-cmd "healthcheck.sh --connect --innodb_initialized" --health-interval 5s --health-timeout 5s --health-retries 20',
    jobEnv: { DATABASE_URL: "mysql://root:root@127.0.0.1:3306/app_test" },
  },
  mongo: {
    image: "mongo:7",
    ports: ["27017:27017"],
    options: "--health-cmd \"mongosh --quiet --eval 'db.runCommand({ping:1})'\" --health-interval 5s --health-timeout 5s --health-retries 20",
    jobEnv: { MONGODB_URI: "mongodb://localhost:27017/app_test", MONGO_URL: "mongodb://localhost:27017/app_test" },
  },
  redis: {
    image: "redis:7",
    ports: ["6379:6379"],
    options: '--health-cmd "redis-cli ping" --health-interval 5s --health-timeout 5s --health-retries 20',
    jobEnv: { REDIS_URL: "redis://localhost:6379" },
  },
  rabbitmq: {
    image: "rabbitmq:3",
    ports: ["5672:5672"],
    options: '--health-cmd "rabbitmq-diagnostics -q ping" --health-interval 10s --health-timeout 10s --health-retries 20',
    jobEnv: { RABBITMQ_URL: "amqp://guest:guest@localhost:5672", AMQP_URL: "amqp://guest:guest@localhost:5672" },
  },
});

const NODE_SERVICE_DEPS = {
  postgres: ["pg", "postgres", "pg-promise", "@neondatabase/serverless"],
  mysql: ["mysql2", "mysql"],
  mongo: ["mongodb", "mongoose"],
  redis: ["redis", "ioredis", "bullmq", "bull"],
  rabbitmq: ["amqplib", "amqp-connection-manager", "@golevelup/nestjs-rabbitmq"],
};

const TEXT_SERVICE_PATTERNS = {
  postgres: /psycopg|asyncpg|gem\s+["']pg["']|org\.postgresql|jackc\/pgx|lib\/pq|Npgsql/i,
  mysql: /mysqlclient|pymysql|aiomysql|gem\s+["']mysql2["']|mysql-connector|go-sql-driver\/mysql|MySqlConnector|Pomelo\.EntityFrameworkCore\.MySql/i,
  mongo: /pymongo|motor\b|gem\s+["']mongoid["']|mongodb-driver|mongo-driver|MongoDB\.Driver/i,
  redis: /(^|[\s"'[,])redis([\s"'\],<>=~]|$)|celery\[redis\]|spring-boot-starter-data-redis|go-redis|StackExchange\.Redis/im,
  rabbitmq: /\bpika\b|aio-pika|kombu|gem\s+["']bunny["']|spring-boot-starter-amqp|amqp091-go|streadway\/amqp|RabbitMQ\.Client/i,
};

const PRISMA_PROVIDER = { postgresql: "postgres", cockroachdb: "postgres", mysql: "mysql", mongodb: "mongo" };

/** Infra the app's tests likely need: Prisma provider, driver deps, compose next to the app. */
function detectServices(root, app, info, compose) {
  const found = new Map();
  const add = (kind, source, image = null) => {
    if (!SERVICE_CATALOG[kind] || found.has(kind)) return;
    found.set(kind, { kind, source, image: image || SERVICE_CATALOG[kind].image });
  };
  const prismaPath = ["prisma/schema.prisma", "schema.prisma"].map((p) => path.join(root, app.dir, p)).find((p) => fs.existsSync(p));
  if (prismaPath) {
    const provider = (readText(prismaPath) || "").match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*["'](\w+)["']/)?.[1];
    if (PRISMA_PROVIDER[provider]) add(PRISMA_PROVIDER[provider], "prisma");
  }
  if (Array.isArray(info.deps)) {
    for (const [kind, names] of Object.entries(NODE_SERVICE_DEPS)) {
      const hit = names.find((n) => info.deps.includes(n));
      if (hit) add(kind, `package.json: ${hit}`);
    }
  }
  if (info.manifestText) {
    for (const [kind, re] of Object.entries(TEXT_SERVICE_PATTERNS)) if (re.test(info.manifestText)) add(kind, "manifest");
  }
  for (const c of compose) {
    const cdir = dirOf(c.path);
    if (cdir !== app.dir && cdir !== "") continue;
    for (const s of c.services) {
      if (!s.infra) continue;
      const kind = s.infra === "mssql" || s.infra === "sqlserver" ? null : s.infra;
      if (kind && found.has(kind)) found.get(kind).image = s.image;
      else if (kind && cdir === app.dir) add(kind, c.path, s.image);
    }
  }
  return [...found.values()];
}

function slug(s) {
  return String(s || "root")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

function parseComposeServices(text) {
  const services = [];
  const lines = String(text || "").split(/\r?\n/);
  let inServices = false;
  let svcIndent = -1;
  let current = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      svcIndent = -1;
      continue;
    }
    if (!inServices || !line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    const key = line.match(/^\s*([A-Za-z0-9._-]+):\s*$/);
    if (key && (svcIndent === -1 || indent === svcIndent)) {
      svcIndent = indent;
      current = { name: key[1], image: null, build: false, healthcheck: false };
      services.push(current);
      continue;
    }
    if (!current) continue;
    const img = line.match(/^\s*image:\s*["']?([^"'\s#]+)/);
    if (img) current.image = img[1];
    if (/^\s*build:/.test(line)) current.build = true;
    if (/^\s*healthcheck:/.test(line)) current.healthcheck = true;
  }
  return services.map((s) => ({
    ...s,
    infra: s.image ? INFRA_IMAGES.find((i) => s.image.split("/").pop().startsWith(i)) || null : null,
  }));
}

function detectRepoLevel(root, files, apps) {
  const idx = makeIndex(files);
  const dockerfiles = files
    .filter((f) => /^(Dockerfile|Containerfile)(\..+)?$/.test(baseOf(f)) || /\.Dockerfile$/i.test(baseOf(f)))
    .map((f) => ({ path: f, context: dirOf(f) || "." }));

  const compose = files
    .filter((f) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(baseOf(f)))
    .map((f) => ({ path: f, services: parseComposeServices(readText(path.join(root, f))) }));

  const e2e = [];
  for (const f of files) {
    const b = baseOf(f);
    if (/^playwright\.config\.(ts|js|mjs|cjs)$/.test(b)) e2e.push({ tool: "playwright", dir: dirOf(f), config: f });
    if (/^cypress\.config\.(ts|js|mjs|cjs)$/.test(b) || b === "cypress.json") e2e.push({ tool: "cypress", dir: dirOf(f), config: f });
  }

  const tfDirs = [...new Set(files.filter((f) => f.endsWith(".tf")).map(dirOf))];
  const helmCharts = files.filter((f) => baseOf(f) === "Chart.yaml").map(dirOf);
  const k8s = files.some((f) => /(^|\/)(k8s|kubernetes|manifests)\//.test(f) && /\.ya?ml$/.test(f));

  const commitlint = files.find((f) => /^(\.commitlintrc(\..+)?|commitlint\.config\.(js|cjs|mjs|ts))$/.test(baseOf(f))) || null;
  const openapi = files.filter((f) => /^(openapi|swagger)(\.[\w-]+)?\.(ya?ml|json)$/i.test(baseOf(f)));
  const alembic = files.filter((f) => baseOf(f) === "alembic.ini");

  const codeqlLanguages = [...new Set(apps.map((a) => CODEQL_LANGUAGE[a.stack]).filter(Boolean))];

  const githubFiles = (() => {
    const dir = path.join(root, ".github");
    const out = { dependabot: false, renovate: false, codeowners: false, workflows: [] };
    out.dependabot = fs.existsSync(path.join(dir, "dependabot.yml")) || fs.existsSync(path.join(dir, "dependabot.yaml"));
    out.renovate = ["renovate.json", ".renovaterc", ".renovaterc.json", ".github/renovate.json"].some((f) =>
      fs.existsSync(path.join(root, f))
    );
    out.codeowners = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].some((f) => fs.existsSync(path.join(root, f)));
    try {
      out.workflows = fs.readdirSync(path.join(dir, "workflows")).filter((n) => /\.ya?ml$/.test(n));
    } catch {
      /* none */
    }
    return out;
  })();

  const preCommit = {
    husky: fs.existsSync(path.join(root, ".husky")),
    lefthook: idx.has("lefthook.yml") || idx.has(".lefthook.yml"),
    preCommit: idx.has(".pre-commit-config.yaml"),
  };

  const markdown = files.filter((f) => /\.mdx?$/i.test(f));
  const docs = {
    markdownFiles: markdown.length,
    docsDir: files.some((f) => f.startsWith("docs/")),
    markdownlint: files.some((f) => /^\.markdownlint(-cli2)?(\.(jsonc?|ya?ml|cjs|mjs))?$/.test(baseOf(f))),
    site: files.find((f) => /^(mkdocs\.ya?ml|docusaurus\.config\.(js|ts|mjs)|astro\.config\.(mjs|ts))$/.test(f)) || null,
  };

  const release = [
    files.some((f) => /^\.releaserc(\..+)?$|^release\.config\.(js|cjs|mjs)$/.test(baseOf(f))) && "semantic-release",
    idx.has("release-please-config.json") && "release-please",
    idx.has(".changeset/config.json") && "changesets",
    idx.has(".goreleaser.yml") || idx.has(".goreleaser.yaml") ? "goreleaser" : null,
  ].filter(Boolean);

  const deploy = [
    ["vercel.json", "vercel"],
    ["netlify.toml", "netlify"],
    ["fly.toml", "fly.io"],
    ["render.yaml", "render"],
    ["app.yaml", "app-engine"],
    ["Procfile", "heroku-style Procfile"],
    ["serverless.yml", "serverless"],
    ["firebase.json", "firebase"],
    ["amplify.yml", "amplify"],
    ["wrangler.toml", "cloudflare"],
  ]
    .filter(([f]) => files.some((x) => baseOf(x) === f))
    .map(([, name]) => name);
  if (helmCharts.length) deploy.push("helm");
  if (k8s) deploy.push("kubernetes");

  return {
    dockerfiles,
    compose,
    e2e,
    iac: { terraform: tfDirs, helm: helmCharts, kubernetes: k8s },
    commitlint,
    openapi,
    alembic,
    codeqlLanguages,
    github: githubFiles,
    preCommit,
    editorconfig: idx.has(".editorconfig"),
    hadolint: idx.has(".hadolint.yaml") || idx.has(".hadolint.yml"),
    docs,
    release,
    deploy,
  };
}

/**
 * Full repository scan.
 * @param {string} root product repo root (cwd)
 * @param {{ kitRootRel?: string, maxDepth?: number }} [opts]
 */
export function scanRepoForGates(root = process.cwd(), { kitRootRel = "", maxDepth = 5 } = {}) {
  const files = walkRepo(root, { maxDepth, skipRel: [kitRootRel] });
  const { apps: found, idx } = findApps(files, root);
  const repo = detectRepoLevel(root, files, found);
  const usedNames = new Set();
  const apps = [];
  for (const a of found) {
    const analyze = ANALYZERS[a.stack];
    if (!analyze) continue;
    const info = analyze(root, a, idx);
    if (info.tooling && a.stack === "node" && found.length > 1) continue;
    let name = a.dir ? slug(baseOf(a.dir)) : "root";
    if (usedNames.has(name)) name = slug(a.dir || "root");
    usedNames.add(name);
    const services = detectServices(root, a, info, repo.compose);
    const { deps: _deps, manifestText: _text, ...rest } = info;
    apps.push({
      name,
      path: a.dir || ".",
      stack: a.stack === "dart" && info.flutter ? "flutter" : a.stack,
      manifests: a.manifests,
      ...rest,
      services,
    });
  }
  return { root: toPosix(root), kitRootRel: toPosix(kitRootRel), apps, repo, scannedFiles: files.length };
}

// ---------------------------------------------------------------------------
// Gate configuration (project.yml ci.gates)
// ---------------------------------------------------------------------------

export function normalizeMode(value, fallback = "off") {
  if (value === true) return "block";
  if (value === false || value === null) return "off";
  const v = String(value ?? "").trim().toLowerCase();
  if (GATE_MODES.includes(v)) return v;
  if (v === "on" || v === "true" || v === "required" || v === "error") return "block";
  if (v === "false" || v === "no" || v === "disabled") return "off";
  if (v === "report" || v === "advisory") return "warn";
  return fallback;
}

function asObject(value, key = "mode") {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return { [key]: value };
}

export const FIX_MODES = ["off", "suggest", "commit"];
export const PRESET_NAMES = ["minimal", "balanced", "strict"];
export const NOTIFY_ON = ["off", "failure", "always"];
export const DEFAULT_BRANCH_PATTERN = "^(feat|fix|chore|docs|refactor|test|ci|perf|build|style|hotfix|release|revert)/[A-Za-z0-9._/-]+$";
export const DEFAULT_TITLE_PATTERN = "^(feat|fix|chore|docs|refactor|test|ci|perf|build|style|revert)(\\([^)]+\\))?!?: .+";
export const DEFAULT_CARD_PATTERN = "[A-Z][A-Z0-9]+-(EPIC|FEAT|FEATURE|STORY|TASK|SUBTASK|BUG|SPIKE)-[0-9]+";

/** Defaults applied to every detected app when ci.gates.defaults omits a gate (no preset). */
export const DEFAULT_GATES = Object.freeze({
  lint: "block",
  format: "block",
  typecheck: "block",
  test: "block",
  build: "block",
  migrations: "off",
  coverage: { mode: "off", metric: "lines", min: 80, ignore: [] },
  audit: { mode: "warn", level: "high", fix: "off" },
});

/**
 * Starting points for the interview. Explicit ci.gates keys always win; repo-level
 * gates only render when the repo has the thing (Dockerfile, compose, web app…).
 */
export const PRESETS = Object.freeze({
  minimal: {
    affected: true,
    defaults: {
      lint: "block",
      format: "warn",
      typecheck: "block",
      test: "block",
      build: "block",
      migrations: "off",
      services: "auto",
      coverage: { mode: "off" },
      audit: { mode: "off" },
    },
  },
  balanced: {
    affected: true,
    artifacts: true,
    defaults: {
      lint: "block",
      format: { mode: "block", fix: "suggest" },
      typecheck: "block",
      test: "block",
      build: "block",
      migrations: "block",
      services: "auto",
      coverage: { mode: "warn", metric: "lines", min: 70, comment: true },
      audit: { mode: "warn", level: "high", fix: "check" },
    },
    docker: { build: "block", scan: "warn", lint: "warn", cache: true },
    compose_smoke: "warn",
    e2e: "warn",
    iac: "block",
    openapi: "warn",
    dependency_review: "warn",
    secrets_scan: "block",
    pr_checks: { branch_name: "warn", title: "warn", card_link: "warn" },
    docs: { links: "warn" },
    bundle_size: "warn",
  },
  strict: {
    affected: true,
    artifacts: true,
    defaults: {
      lint: "block",
      format: { mode: "block", fix: "suggest" },
      typecheck: "block",
      test: "block",
      build: "block",
      migrations: "block",
      services: "auto",
      coverage: { mode: "block", metric: "lines", min: 80, comment: true, diff: { mode: "block", min: 80 } },
      audit: { mode: "block", level: "high", fix: "pr" },
    },
    docker: { build: "block", scan: "block", lint: "block", cache: true },
    compose_smoke: "block",
    e2e: "block",
    iac: "block",
    openapi: "block",
    commitlint: "block",
    codeql: "block",
    dependency_review: "block",
    secrets_scan: "block",
    pr_checks: { branch_name: "block", title: "block", card_link: "block", size: { mode: "warn", max: 800 } },
    docs: { links: "block", markdown: "warn" },
    bundle_size: "block",
    lighthouse: "warn",
    a11y: "warn",
    mobile_build: "warn",
    notify: { on: "failure" },
  },
});

function isPlain(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function scalarField(key, value) {
  if (key === "docker") return "build";
  if (key === "notify") return "on";
  if ((key === "diff" || key === "size") && typeof value === "number") return key === "diff" ? "min" : "max";
  return "mode";
}

/** Deep merge where `over` wins; a scalar over an object sets that object's mode (docker: build). */
export function mergeGateConfig(base, over, key = null) {
  if (over === undefined) return base;
  if (isPlain(base) && over !== null && !isPlain(over) && !Array.isArray(over)) {
    return { ...base, [scalarField(key, over)]: over };
  }
  if (!isPlain(base) || !isPlain(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeGateConfig(base[k], v, k);
  return out;
}

const list = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === "" ? [] : [String(v)]);

function positiveInt(v, fallback, max = 360) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function resolveDiff(raw, coverageMode) {
  if (raw === undefined || raw === null || raw === false || raw === "off") return null;
  if (raw === true) return { mode: coverageMode === "off" ? "warn" : coverageMode, min: 80 };
  const o = typeof raw === "number" ? { min: raw } : asObject(raw);
  const mode = normalizeMode(o.mode, coverageMode === "off" ? "warn" : coverageMode);
  if (mode === "off") return null;
  const min = Number(o.min);
  return { mode, min: Number.isFinite(min) ? Math.max(0, Math.min(100, min)) : 80 };
}

function resolveCoverage(raw) {
  const base = DEFAULT_GATES.coverage;
  const o = { ...base, ...asObject(raw) };
  const min = Number(o.min);
  const mode = normalizeMode(o.mode, base.mode);
  return {
    mode,
    metric: COVERAGE_METRICS.includes(o.metric) ? o.metric : "lines",
    min: Number.isFinite(min) ? Math.max(0, Math.min(100, min)) : base.min,
    ignore: Array.isArray(o.ignore) ? o.ignore.map(String) : [],
    report: o.report ? String(o.report) : null,
    comment: o.comment === true,
    diff: mode === "off" ? null : resolveDiff(o.diff, mode),
  };
}

function resolveAudit(raw) {
  const base = DEFAULT_GATES.audit;
  const o = { ...base, ...asObject(raw) };
  return {
    mode: normalizeMode(o.mode, base.mode),
    level: AUDIT_LEVELS.includes(o.level) ? o.level : "high",
    fix: AUDIT_FIX_MODES.includes(String(o.fix)) ? String(o.fix) : o.fix === true ? "check" : "off",
  };
}

const fixMode = (v) => (FIX_MODES.includes(String(v)) ? String(v) : v === true ? "suggest" : "off");

function resolveAppGates(defaults, overrides) {
  const merged = mergeGateConfig(mergeGateConfig({ ...DEFAULT_GATES }, defaults || {}), overrides || {});
  const out = {};
  for (const g of ["lint", "format", "typecheck", "test", "build", "migrations"]) {
    out[g] = normalizeMode(asObject(merged[g]).mode, normalizeMode(DEFAULT_GATES[g]));
  }
  out.fix = { lint: fixMode(asObject(merged.lint).fix), format: fixMode(asObject(merged.format).fix) };
  out.coverage = resolveCoverage(merged.coverage);
  out.audit = resolveAudit(merged.audit);
  out.services = merged.services === undefined ? "off" : merged.services;
  out.migrate = merged.migrate === undefined ? null : merged.migrate;
  out.retry = Math.max(0, Math.min(3, Math.floor(Number(merged.retry) || 0)));
  out.matrix = { versions: list(merged.matrix?.versions), os: list(merged.matrix?.os) };
  out.version = merged.version ? String(merged.version) : null;
  out.runner = merged.runner ? String(merged.runner) : null;
  out.timeout = merged.timeout_minutes ? positiveInt(merged.timeout_minutes, null) : null;
  out.affectedPaths = list(merged.affected_paths);
  return out;
}

/** Concrete service containers for an app: "auto" → detected, list/map → catalog (+ detected image). */
export function resolveServices(choice, detected = []) {
  if (!choice || choice === "off" || choice === false) return [];
  const byKind = new Map(detected.map((s) => [s.kind, s]));
  const pick = (kind, image = null) =>
    SERVICE_CATALOG[kind] ? { kind, image: image || byKind.get(kind)?.image || SERVICE_CATALOG[kind].image } : null;
  if (choice === "auto" || choice === true) return detected.map((s) => pick(s.kind, s.image)).filter(Boolean);
  if (Array.isArray(choice)) return choice.map((k) => pick(String(k))).filter(Boolean);
  if (isPlain(choice)) return Object.entries(choice).map(([k, img]) => pick(k, typeof img === "string" ? img : null)).filter(Boolean);
  return [];
}

function resolveTargetApp(raw, apps, predicate) {
  const name = raw?.app ? String(raw.app) : null;
  const app = name ? apps.find((a) => a.name === name) : apps.find(predicate);
  return app || null;
}

/**
 * Merge scan + ci.gates into concrete per-app decisions used by the renderer.
 * Apps in config but not in the scan are kept when they declare path + commands.
 */
export function resolveGatePlan(scan, gatesCfg) {
  const raw = isPlain(gatesCfg) ? gatesCfg : {};
  const preset = PRESET_NAMES.includes(raw.preset) ? raw.preset : null;
  const cfg = preset ? mergeGateConfig(PRESETS[preset], raw) : raw;
  const appCfg = cfg.apps && typeof cfg.apps === "object" ? cfg.apps : {};
  const matched = new Set();
  const apps = [];

  const findCfg = (app) => {
    for (const [name, value] of Object.entries(appCfg)) {
      const v = value && typeof value === "object" ? value : { enabled: value };
      const p = v.path ? toPosix(v.path).replace(/\/+$/, "") || "." : null;
      if (name === app.name || (p && p === app.path)) return [name, v];
    }
    return [null, null];
  };

  for (const app of scan.apps) {
    const [name, overrides] = findCfg(app);
    if (name) matched.add(name);
    if (overrides && normalizeMode(overrides.enabled ?? true, "block") === "off") continue;
    const decisions = resolveAppGates(cfg.defaults, overrides);
    const commands = { ...(overrides?.commands || {}) };
    const explicit = Object.keys(overrides || {}).filter((k) => APP_GATES.includes(k));
    apps.push({ ...app, name: name || app.name, decisions, commands, explicit });
  }

  for (const [name, value] of Object.entries(appCfg)) {
    if (matched.has(name) || !value || typeof value !== "object" || !value.path || !value.commands) continue;
    if (normalizeMode(value.enabled ?? true, "block") === "off") continue;
    apps.push({
      name,
      path: toPosix(value.path),
      stack: value.stack || "custom",
      install: value.commands.install || null,
      setup: { kind: value.stack || "custom" },
      gates: {},
      decisions: resolveAppGates(cfg.defaults, value),
      commands: { ...value.commands },
      explicit: Object.keys(value).filter((k) => APP_GATES.includes(k)),
      custom: true,
    });
  }

  for (const app of apps) app.resolvedServices = resolveServices(app.decisions.services, app.services || []);

  const docker = asObject(cfg.docker, "build");
  const compose = asObject(cfg.compose_smoke);
  const branches = Array.isArray(cfg.branches) && cfg.branches.length ? cfg.branches.map(String) : null;
  const affected = isPlain(cfg.affected) ? cfg.affected : { enabled: cfg.affected === true };
  const publish = docker.publish;
  const pr = asObject(cfg.pr_checks);
  const prDefault = normalizeMode(pr.mode, "off");
  const prCheck = (key, pattern) => {
    const c = asObject(pr[key]);
    return { mode: normalizeMode(c.mode, prDefault), pattern: c.pattern ? String(c.pattern) : pattern };
  };
  const size = asObject(pr.size, typeof pr.size === "number" ? "max" : "mode");
  const docs = asObject(cfg.docs);
  const docsDefault = normalizeMode(docs.mode, "off");
  const lighthouse = asObject(cfg.lighthouse);
  const a11y = asObject(cfg.a11y);
  const bundle = asObject(cfg.bundle_size);
  const mobile = asObject(cfg.mobile_build);
  const notify = asObject(cfg.notify, "on");
  const depReview = asObject(cfg.dependency_review);
  const lighthouseApp = resolveTargetApp(lighthouse, apps, (a) => a.web);
  const a11yApp = resolveTargetApp(a11y, apps, (a) => a.web);
  const bundleApp = resolveTargetApp(bundle, apps, (a) => a.bundleSize || a.commands?.bundle_size);
  const mobileApp = resolveTargetApp(mobile, apps, (a) => a.mobile);

  return {
    preset,
    branches,
    pullRequest: cfg.pull_request !== false,
    pathsIgnore: Array.isArray(cfg.paths_ignore) ? cfg.paths_ignore.map(String) : [],
    mergeGroup: cfg.merge_group !== false,
    runner: cfg.runner ? String(cfg.runner) : "ubuntu-latest",
    timeout: positiveInt(cfg.timeout_minutes, 30),
    affected: { enabled: affected.enabled !== false && (affected.enabled === true || Boolean(affected.paths)), paths: list(affected.paths) },
    artifacts: cfg.artifacts === true,
    apps,
    docker: {
      build: normalizeMode(docker.build, "off"),
      scan: normalizeMode(docker.scan, "off"),
      severity: String(docker.severity || "HIGH,CRITICAL"),
      files: Array.isArray(docker.files) ? docker.files.map(String) : null,
      lint: normalizeMode(docker.lint, "off"),
      cache: docker.cache === true,
      publish:
        publish === true || isPlain(publish)
          ? {
              branches: isPlain(publish) && publish.branches ? list(publish.branches) : branches ? [branches[0]] : null,
              tags: !(isPlain(publish) && publish.tags === false),
              platforms: isPlain(publish) && publish.platforms ? list(publish.platforms) : ["linux/amd64"],
            }
          : null,
    },
    composeSmoke: {
      mode: normalizeMode(compose.mode, "off"),
      file: compose.file ? String(compose.file) : scan.repo.compose[0]?.path || null,
      services: Array.isArray(compose.services) ? compose.services.map(String) : null,
      check: compose.check ? String(compose.check) : null,
    },
    e2e: normalizeMode(asObject(cfg.e2e).mode, "off"),
    iac: normalizeMode(asObject(cfg.iac).mode, "off"),
    commitlint: normalizeMode(asObject(cfg.commitlint).mode, "off"),
    openapi: normalizeMode(asObject(cfg.openapi).mode, "off"),
    codeql: normalizeMode(asObject(cfg.codeql).mode, "off"),
    dependencyReview: {
      mode: normalizeMode(depReview.mode, "off"),
      severity: AUDIT_LEVELS.includes(depReview.severity) ? depReview.severity : "high",
    },
    secretsScan: normalizeMode(asObject(cfg.secrets_scan).mode, "off"),
    prChecks: {
      branchName: prCheck("branch_name", DEFAULT_BRANCH_PATTERN),
      title: prCheck("title", DEFAULT_TITLE_PATTERN),
      cardLink: prCheck("card_link", DEFAULT_CARD_PATTERN),
      size: { mode: normalizeMode(size.mode, typeof pr.size === "number" ? "warn" : "off"), max: positiveInt(size.max, 800, 100000) },
    },
    lighthouse: {
      mode: lighthouseApp ? normalizeMode(lighthouse.mode, "off") : "off",
      app: lighthouseApp?.name || null,
      dist: lighthouse.dist ? String(lighthouse.dist) : lighthouseApp?.web?.dist || null,
      start: lighthouse.start ? String(lighthouse.start) : lighthouseApp?.web?.start || null,
      url: lighthouse.url ? String(lighthouse.url) : lighthouseApp?.web?.url || null,
      urls: list(lighthouse.urls).length ? list(lighthouse.urls) : ["/"],
      min: { performance: 0.8, accessibility: 0.9, "best-practices": 0.9, seo: 0.8, ...(isPlain(lighthouse.min) ? lighthouse.min : {}) },
    },
    a11y: {
      mode: a11yApp ? normalizeMode(a11y.mode, "off") : "off",
      app: a11yApp?.name || null,
      dist: a11y.dist ? String(a11y.dist) : a11yApp?.web?.dist || null,
      start: a11y.start ? String(a11y.start) : a11yApp?.web?.start || null,
      url: a11y.url ? String(a11y.url) : a11yApp?.web?.url || null,
      urls: list(a11y.urls).length ? list(a11y.urls) : ["/"],
    },
    bundleSize: { mode: bundleApp ? normalizeMode(bundle.mode, "off") : "off", app: bundleApp?.name || null },
    mobileBuild: {
      mode: mobileApp ? normalizeMode(mobile.mode, "off") : "off",
      app: mobileApp?.name || null,
      android: mobile.android !== undefined ? mobile.android !== false : Boolean(mobileApp?.mobile?.android),
      ios: mobile.ios === true && Boolean(mobileApp?.mobile?.ios),
    },
    notify: {
      on: NOTIFY_ON.includes(String(notify.on)) ? String(notify.on) : notify.on === true ? "failure" : "off",
      slack: notify.slack !== false,
      discord: notify.discord !== false,
    },
    docs: {
      links: normalizeMode(docs.links, docsDefault),
      external: docs.external === true,
      markdown: normalizeMode(docs.markdown, docsDefault),
    },
    declined: list(cfg.declined),
  };
}

/** Command a gate will run for an app (override > detected). Audit level substituted. */
export function gateCommand(app, gateName, decisions = app.decisions) {
  const override = app.commands?.[gateName];
  if (override) return String(override);
  const g = app.gates?.[gateName];
  if (!g?.command) return null;
  if (gateName === "audit") return g.command.replace(/\{level\}/g, decisions?.audit?.level || "high");
  return g.command;
}

// ---------------------------------------------------------------------------
// Gates interview — every question the pipeline-architect skill must ask
// ---------------------------------------------------------------------------

/** Spanish for the static question texts, keyed by the English text (templated ones carry `es` inline). */
const ES = {
  "Starting point: minimal (lint/test/build), balanced (+ coverage warn, audit, secrets, PR hygiene) or strict (all block, diff coverage, Lighthouse)? Every question below can still override.":
    "Punto de partida: minimal (lint/test/build), balanced (+ cobertura warn, audit, secretos, higiene de PR) o strict (todo block, diff coverage, Lighthouse)? Cada pregunta de abajo aún puede sobrescribir.",
  "Which branches should run the pipeline on push (e.g. main, dev)?": "¿En qué ramas debe correr el pipeline en push (ej.: main, dev)?",
  "Run the gates on every pull request?": "¿Correr los gates en cada pull request?",
  "Skip docs-only changes (**/*.md, docs/**) to save CI minutes?": "¿Ignorar cambios solo de docs (**/*.md, docs/**) para ahorrar minutos de CI?",
  "Also run on the GitHub merge queue (merge_group)? Required if the branch uses a merge queue; harmless otherwise.":
    "¿Correr también en la merge queue de GitHub (merge_group)? Necesario si la rama usa merge queue; inofensivo si no.",
  "Default job runner (ubuntu-latest, or self-hosted/larger runner) and timeout in minutes (default 30)?":
    "Runner por defecto de los jobs (ubuntu-latest, o self-hosted/larger runner) y timeout en minutos (por defecto 30)?",
  "Per-job timeout (min)?": "¿Timeout por job (min)?",
  "Keep test/coverage reports as Actions artifacts (7 days)?": "¿Guardar los reportes de pruebas/cobertura como artifacts de Actions (7 días)?",
  "Shared paths that trigger every app?": "¿Archivos compartidos que disparan todas las apps (ej.: packages/shared/**, package-lock.json)?",
  "lint gate?": "¿gate de lint?",
  "no linter detected — set one up?": "no se detectó linter — ¿configurar uno?",
  "styles/format gate (fails when code is not formatted)?": "¿gate de estilos/format (falla si el código no está formateado)?",
  "no formatter detected — adopt one for a styles gate?": "no se detectó formatter — ¿adoptar uno para un gate de estilos?",
  "typecheck gate?": "¿gate de typecheck?",
  "no typecheck — adopt one?": "sin typecheck — ¿adoptar uno?",
  "run tests as a gate?": "¿correr las pruebas como gate?",
  "no test runner detected — set one up?": "no se detectó runner de pruebas — ¿configurar uno?",
  "test coverage gate?": "¿gate de cobertura de pruebas?",
  "Which metric?": "¿Qué métrica? (lines, statements, branches, functions)",
  "Minimum %?": "¿Mínimo en % (ej.: 80)?",
  "Paths excluded from the metric?": "¿Carpetas/archivos fuera de la métrica (ej.: generated, *.g.dart, screens)?",
  "Start as warn and promote to block later?": "¿Empezar en warn y subir a block cuando se estabilice?",
  "Post the coverage summary as a sticky PR comment?": "¿Comentar el resumen de cobertura en el PR (comentario fijo, actualizado en cada push)?",
  "Diff coverage: minimum % on lines changed by the PR (e.g. 80)? Great for legacy code.":
    "Diff coverage: ¿% mínimo solo en las líneas nuevas/modificadas del PR (ej.: 80)? Bueno para legado con poca cobertura.",
  "tests without coverage — enable a report for a gate?": "pruebas sin cobertura — ¿habilitar un reporte para el gate?",
  "build as a gate?": "¿build como gate?",
  "dependency audit gate?": "¿gate de audit de dependencias?",
  "Minimum severity?": "¿Severidad mínima?",
  "Scan images with Trivy (HIGH/CRITICAL vulnerabilities)?": "¿Escanear las imágenes con Trivy (vulnerabilidades HIGH/CRITICAL)?",
  "Use buildx with the GitHub Actions cache (type=gha) for much faster builds?": "¿Usar buildx con el cache de GitHub Actions (type=gha) para builds mucho más rápidos?",
  "Publish images to GHCR (ghcr.io/<owner>/<repo>-<name>) on pushes to the main branch and v* tags? Uses only GITHUB_TOKEN.":
    "¿Publicar las imágenes en GHCR (ghcr.io/<owner>/<repo>-<nombre>) en push a la rama principal y en tags v*? Usa solo GITHUB_TOKEN.",
  "Platforms?": "¿Plataformas (linux/amd64; linux/arm64 duplica el tiempo)?",
  "Which services (empty = all)?": "¿Qué servicios levantar (vacío = todos)?",
  "Post-up check command?": "¿Comando de verificación después de levantar (ej.: npm run rabbit:check)?",
  "Compose credentials stay local/.env.example only?": "¿Las credenciales del compose quedan solo locales/.env.example? (nunca en el workflow)",
  "Validate commit messages (Conventional Commits) on PRs?": "¿Validar los mensajes de commit (Conventional Commits) en los PRs?",
  "Dependency review on PRs: block newly added dependencies with known vulnerabilities? Private repos need GHAS.":
    "Dependency review en los PRs: ¿bloquear dependencias nuevas con vulnerabilidades conocidas (solo mira lo que el PR agrega)? Repo privado requiere GitHub Advanced Security.",
  "Scan PR/push commits for leaked secrets (gitleaks)?": "¿Buscar secretos filtrados (gitleaks) en los commits del PR/push?",
  "PR hygiene: branch name (feat/…, fix/…), Conventional Commits title, card link (CARD_ID in body/branch) and max diff size?":
    "Higiene de PR: nombre de la rama (feat/…, fix/…), título en Conventional Commits, enlace a la tarjeta (CARD_ID en cuerpo/rama) y tamaño máximo del diff?",
  "Branch name gate?": "¿Gate del nombre de la rama?",
  "PR title gate?": "¿Gate del título del PR?",
  "Require a CARD_ID in the PR?": "¿Exigir CARD_ID (ej.: PROJ-FEAT-12) en el PR?",
  "Warn above N changed lines?": "¿Avisar cuando el PR pase de N líneas modificadas (ej.: 800)?",
  "Which routes?": "¿Qué rutas probar?",
  "No size-limit. Adopt a bundle size budget (size-limit)?": "Sin size-limit. ¿Adoptar un presupuesto de tamaño de bundle (size-limit + .size-limit.json)?",
  "Include iOS build (macOS)?": "¿Incluir build iOS (macOS)?",
  "Links gate?": "¿Gate de enlaces?",
  "Also check external links? Can be flaky.": "¿Revisar también enlaces externos (http)? Puede ser inestable.",
  "markdownlint gate?": "¿Gate de markdownlint?",
  "Notify Slack/Discord when CI fails on push (never on PRs)? Uses SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL secrets; skipped when unset.":
    "¿Notificar a Slack/Discord cuando el CI falle en push (nunca en PR)? Usa los secrets SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL; sin secret el paso se omite.",
  "No Dependabot/Renovate. Create .github/dependabot.yml (weekly; target-branch = integration branch, e.g. dev)?":
    "Sin Dependabot/Renovate. ¿Crear .github/dependabot.yml (updates semanales; target-branch = rama de integración, ej.: dev)?",
  "No CODEOWNERS. Create one to require reviews per area?": "Sin CODEOWNERS. ¿Crear uno para exigir review por área (api/, web/, mobile/)?",
  "Local pre-commit hook running format/lint so the styles gate rarely fails in CI?":
    "¿Hook local (pre-commit) con format/lint antes del commit, para que el gate de estilos casi nunca falle en el CI?",
  "Mark block-mode jobs as required checks in branch protection/rulesets?": "¿Marcar los jobs en modo block como required checks en la branch protection/ruleset?",
  "Publish coverage/audit summary to the Actions Job Summary? (default: yes)": "¿Publicar el resumen (cobertura, audit) en el Job Summary de Actions? (por defecto: sí)",
};

const withEs = (text) => (text && !text.es && ES[text.en] ? { ...text, es: ES[text.en] } : text);

function q(id, category, text, extra = {}) {
  const followUps = extra.followUps?.map(withEs);
  return { id, category, question: withEs(text), ...extra, ...(followUps ? { followUps } : {}) };
}

/** Question text for a language: exact base (pt/en/es), else English. */
export function questionText(question, lang = "en") {
  const base = String(lang || "en").split("-")[0].toLowerCase();
  return question?.[base] || question?.en || "";
}

/**
 * Build the full question catalog from a scan. Each question has a
 * `recommended` answer the agent proposes, and the `yaml` path it writes to.
 */
export function buildGateQuestions(scan, { gates = null } = {}) {
  const questions = [];
  const { repo } = scan;
  const webApps = scan.apps.filter((a) => a.web);
  const mobileApps = scan.apps.filter((a) => a.mobile);

  questions.push(
    q("preset", "settings", {
      pt: "Ponto de partida: minimal (lint/test/build), balanced (+ cobertura warn, audit, segredos, higiene de PR) ou strict (tudo block, diff coverage, Lighthouse)? Cada pergunta abaixo ainda pode sobrescrever.",
      en: "Starting point: minimal (lint/test/build), balanced (+ coverage warn, audit, secrets, PR hygiene) or strict (all block, diff coverage, Lighthouse)? Every question below can still override.",
    }, { yaml: "ci.gates.preset", options: [...PRESET_NAMES, "custom"], recommended: "balanced" }),
    q("triggers.branches", "triggers", {
      pt: "Em quais branches o pipeline deve rodar em push (ex.: main, dev)?",
      en: "Which branches should run the pipeline on push (e.g. main, dev)?",
    }, { yaml: "ci.gates.branches", options: ["default branch", "default + dev/develop", "custom list"], recommended: "default branch" }),
    q("triggers.pull_request", "triggers", {
      pt: "Rodar os gates em todo pull request?",
      en: "Run the gates on every pull request?",
    }, { yaml: "ci.gates.pull_request", options: ["yes", "no"], recommended: "yes" }),
    q("triggers.paths_ignore", "triggers", {
      pt: "Ignorar mudanças só de docs (**/*.md, docs/**) para economizar minutos de CI?",
      en: "Skip docs-only changes (**/*.md, docs/**) to save CI minutes?",
    }, { yaml: "ci.gates.paths_ignore", options: ["yes", "no"], recommended: "no" }),
    q("triggers.merge_group", "triggers", {
      pt: "Rodar também na merge queue do GitHub (merge_group)? Necessário se a branch usar merge queue; inofensivo se não usar.",
      en: "Also run on the GitHub merge queue (merge_group)? Required if the branch uses a merge queue; harmless otherwise.",
    }, { yaml: "ci.gates.merge_group", options: ["yes", "no"], recommended: "yes" }),
    q("settings.runner", "settings", {
      pt: "Runner padrão dos jobs (ubuntu-latest, ou self-hosted/larger runner) e timeout em minutos (padrão 30)?",
      en: "Default job runner (ubuntu-latest, or self-hosted/larger runner) and timeout in minutes (default 30)?",
    }, { yaml: "ci.gates.runner", options: ["ubuntu-latest", "self-hosted", "custom label"], recommended: "ubuntu-latest", followUps: [
      { id: "timeout_minutes", pt: "Timeout por job (min)?", en: "Per-job timeout (min)?", recommended: 30 },
    ] }),
    q("settings.artifacts", "reporting", {
      pt: "Guardar relatórios de teste/cobertura como artifacts do Actions (7 dias)?",
      en: "Keep test/coverage reports as Actions artifacts (7 days)?",
    }, { yaml: "ci.gates.artifacts", options: ["yes", "no"], recommended: "yes" })
  );

  if (scan.apps.length > 1) {
    questions.push(
      q("settings.affected", "settings", {
        pt: `Monorepo com ${scan.apps.length} apps. Em PR, rodar só os apps cujos arquivos mudaram (push na branch principal roda todos)?`,
        en: `Monorepo with ${scan.apps.length} apps. On PRs, run only apps whose files changed (pushes still run everything)?`,
        es: `Monorepo con ${scan.apps.length} apps. En PR, ¿correr solo las apps cuyos archivos cambiaron (el push a la rama principal corre todas)?`,
      }, { yaml: "ci.gates.affected", options: ["yes", "no"], recommended: "yes", followUps: [
        { id: "paths", pt: "Arquivos compartilhados que disparam todos os apps (ex.: packages/shared/**, package-lock.json)?", en: "Shared paths that trigger every app?", recommended: [] },
      ] })
    );
  }

  for (const app of scan.apps) {
    const label = `${app.name} (${app.stack}, ${app.path})`;
    const ask = (gateName, pt, en, extra = {}, es = ES[en] || en) => {
      const g = app.gates[gateName];
      questions.push(
        q(`apps.${app.name}.${gateName}`, gateName, { pt: `${label}: ${pt}`, en: `${label}: ${en}`, es: `${label}: ${es}` }, {
          app: app.name,
          detected: Boolean(g),
          command: g?.command || null,
          evidence: g?.evidence || g?.tool || null,
          yaml: `ci.gates.apps.${app.name}.${gateName}`,
          options: GATE_MODES,
          ...extra,
        })
      );
    };
    const missing = (gateName, pt, en, suggestion) =>
      questions.push(
        q(`apps.${app.name}.${gateName}.adopt`, gateName, { pt: `${label}: ${pt}`, en: `${label}: ${en}`, es: `${label}: ${ES[en] || en}` }, {
          app: app.name,
          detected: false,
          suggestion,
          yaml: `ci.gates.apps.${app.name}.commands.${gateName}`,
          options: ["configure tool now", "provide my own command", "skip"],
          recommended: "skip",
        })
      );

    const suggestions = {
      node: { lint: "eslint", format: "prettier", coverage: "vitest/jest --coverage", test: "vitest or jest" },
      python: { lint: "ruff", format: "ruff format", coverage: "pytest-cov", test: "pytest", typecheck: "mypy" },
      "java-maven": { format: "spotless", coverage: "jacoco-maven-plugin", lint: "checkstyle" },
      "java-gradle": { format: "spotless", coverage: "jacoco/kover", lint: "detekt/ktlint" },
      php: { lint: "phpstan", format: "php-cs-fixer or pint", test: "phpunit/pest" },
      ruby: { lint: "rubocop", format: "standard", coverage: "simplecov" },
      dotnet: { lint: "Roslyn analyzers (TreatWarningsAsErrors)" },
      flutter: { coverage: "flutter test --coverage" },
    }[app.stack] || {};

    const fixQuestion = (gateName, recommended) =>
      questions.push(
        q(`apps.${app.name}.${gateName}.fix`, gateName, {
          pt: `${label}: auto-fix de ${gateName} (${app.gates[gateName].fix}) — off, suggest (comenta sugestões no PR) ou commit (commita a correção na branch do PR)?`,
          en: `${label}: ${gateName} auto-fix (${app.gates[gateName].fix}) — off, suggest (PR review suggestions) or commit (push the fix to the PR branch)?`,
          es: `${label}: auto-fix de ${gateName} (${app.gates[gateName].fix}) — off, suggest (comenta sugerencias en el PR) o commit (commitea la corrección en la rama del PR)?`,
        }, {
          app: app.name,
          yaml: `ci.gates.apps.${app.name}.${gateName}.fix`,
          options: FIX_MODES,
          recommended,
          note: "commit mode needs secrets.HYPERION_PR_TOKEN to re-trigger CI; fork PRs are skipped",
        })
      );

    if (app.gates.lint) ask("lint", "gate de lint?", "lint gate?", { recommended: "block" });
    else if (suggestions.lint) missing("lint", "nenhum linter detectado — configurar um?", "no linter detected — set one up?", suggestions.lint);

    if (app.gates.format) {
      ask("format", "gate de styles/format (falha se o código não estiver formatado)?", "styles/format gate (fails when code is not formatted)?", {
        recommended: "block",
        fixHint: app.gates.format.fix || null,
      });
      if (app.gates.format.fix) fixQuestion("format", "suggest");
      if (app.gates.lint?.fix) fixQuestion("lint", "off");
    } else if (suggestions.format) {
      missing("format", "nenhum formatter detectado — adotar um para o gate de styles?", "no formatter detected — adopt one for a styles gate?", suggestions.format);
    }

    if (app.gates.typecheck) ask("typecheck", "gate de typecheck?", "typecheck gate?", { recommended: "block" });
    else if (suggestions.typecheck) missing("typecheck", "sem typecheck — adotar?", "no typecheck — adopt one?", suggestions.typecheck);

    if (app.gates.test) ask("test", "rodar testes como gate?", "run tests as a gate?", { recommended: "block" });
    else if (suggestions.test) missing("test", "nenhum runner de testes detectado — configurar?", "no test runner detected — set one up?", suggestions.test);

    if (app.gates.coverage) {
      const cov = app.gates.coverage;
      ask("coverage", "gate de cobertura de testes?", "test coverage gate?", {
        recommended: "warn",
        tool: cov.tool,
        report: cov.report,
        needs: cov.needs || null,
        followUps: [
          { id: "metric", pt: "Qual métrica? (lines, statements, branches, functions)", en: "Which metric?", options: COVERAGE_METRICS, recommended: "lines" },
          { id: "min", pt: "Mínimo em % (ex.: 80)?", en: "Minimum %?", recommended: 80 },
          { id: "ignore", pt: "Pastas/arquivos fora da conta (ex.: generated, *.g.dart, screens)?", en: "Paths excluded from the metric?", recommended: [] },
          { id: "ratchet", pt: "Começar em warn e subir para block quando estabilizar?", en: "Start as warn and promote to block later?", recommended: "yes" },
          { id: "comment", pt: "Comentar o resumo de cobertura no PR (comentário fixo, atualizado a cada push)?", en: "Post the coverage summary as a sticky PR comment?", options: ["yes", "no"], recommended: "yes" },
          { id: "diff", pt: "Diff coverage: exigir % mínima só nas linhas novas/alteradas do PR (ex.: 80)? Bom para legado com cobertura baixa.", en: "Diff coverage: minimum % on lines changed by the PR (e.g. 80)? Great for legacy code.", recommended: { mode: "warn", min: 80 } },
        ],
      });
    } else if (app.gates.test && suggestions.coverage) {
      missing("coverage", "testes sem cobertura configurada — habilitar relatório para gate?", "tests without coverage — enable a report for a gate?", suggestions.coverage);
    }

    if (app.gates.build) ask("build", "build como gate?", "build as a gate?", { recommended: "block" });

    if (app.gates.audit) {
      ask("audit", "gate de audit de dependências?", "dependency audit gate?", {
        recommended: "warn",
        followUps: [
          ...(app.gates.audit.levelUnsupported
            ? []
            : [{ id: "level", pt: "Severidade mínima que conta?", en: "Minimum severity?", options: AUDIT_LEVELS, recommended: "high" }]),
          ...(app.gates.audit.fix
            ? [{
                id: "fix",
                pt: `Audit fix (${app.gates.audit.fix}): off, check (testa o fix no CI e reverte se quebrar, só avisa) ou pr (abre PR semanal com o fix)?`,
                en: `Audit fix (${app.gates.audit.fix}): off, check (try fix in CI, revert if tests break, warn only) or pr (weekly PR with the fix)?`,
                es: `Audit fix (${app.gates.audit.fix}): off, check (prueba el fix en el CI y revierte si rompe, solo avisa) o pr (abre un PR semanal con el fix)?`,
                options: AUDIT_FIX_MODES,
                recommended: "check",
              }]
            : []),
        ],
      });
    }

    if (app.gates.migrations) {
      ask("migrations", `checar migrations (${app.gates.migrations.tool})?`, `check migrations (${app.gates.migrations.tool})?`, { recommended: "block" }, `¿revisar migrations (${app.gates.migrations.tool})?`);
    }

    if (app.setup?.version) {
      questions.push(
        q(`apps.${app.name}.matrix`, "toolchain", {
          pt: `${label}: versão detectada ${app.setup.version} (${app.setup.versionSource || "padrão"}). Rodar só nela, ou matriz de versões/sistemas (ex.: versions: [20, 22], os: [ubuntu-latest, windows-latest])? Cobertura/audit rodam só na primeira combinação.`,
          en: `${label}: detected version ${app.setup.version} (${app.setup.versionSource || "default"}). Single version, or a versions/OS matrix? Coverage/audit run on the first combination only.`,
          es: `${label}: versión detectada ${app.setup.version} (${app.setup.versionSource || "por defecto"}). ¿Correr solo en ella, o matriz de versiones/sistemas (ej.: versions: [20, 22], os: [ubuntu-latest, windows-latest])? Cobertura/audit corren solo en la primera combinación.`,
        }, {
          app: app.name,
          yaml: `ci.gates.apps.${app.name}.matrix`,
          detected: app.setup.version,
          options: ["single (detected)", "versions matrix", "os matrix", "both"],
          recommended: app.library ? "versions matrix" : "single (detected)",
        })
      );
    }

    if (app.services?.length) {
      questions.push(
        q(`apps.${app.name}.services`, "services", {
          pt: `${label}: testes parecem usar ${app.services.map((s) => `${s.kind} (${s.source})`).join(", ")}. Subir como service containers no job de teste (Linux) e exportar ${[...new Set(app.services.flatMap((s) => Object.keys(SERVICE_CATALOG[s.kind].jobEnv)))].join(", ")}?`,
          en: `${label}: tests seem to use ${app.services.map((s) => `${s.kind} (${s.source})`).join(", ")}. Start them as service containers in the test job (Linux) and export connection env?`,
          es: `${label}: las pruebas parecen usar ${app.services.map((s) => `${s.kind} (${s.source})`).join(", ")}. ¿Levantarlos como service containers en el job de pruebas (Linux) y exportar las variables de conexión?`,
        }, {
          app: app.name,
          yaml: `ci.gates.apps.${app.name}.services`,
          evidence: app.services,
          options: ["auto", "pick list", "off"],
          recommended: "auto",
        })
      );
    }

    if (app.migrate) {
      questions.push(
        q(`apps.${app.name}.migrate`, "services", {
          pt: `${label}: aplicar migrations no banco de teste antes dos testes (\`${app.migrate}\`)?`,
          en: `${label}: apply migrations to the test database before tests (\`${app.migrate}\`)?`,
          es: `${label}: ¿aplicar las migrations en la base de pruebas antes de los tests (\`${app.migrate}\`)?`,
        }, {
          app: app.name,
          yaml: `ci.gates.apps.${app.name}.migrate`,
          command: app.migrate,
          options: ["yes", "no", "custom command"],
          recommended: app.services?.length ? "yes" : "no",
        })
      );
    }

    if (app.gates.test) {
      questions.push(
        q(`apps.${app.name}.retry`, "test", {
          pt: `${label}: testes instáveis? Repetir o passo de teste até N vezes antes de falhar (0 = não; máx. 3)? Prefira corrigir o flaky.`,
          en: `${label}: flaky tests? Retry the test step up to N times before failing (0 = no; max 3)? Prefer fixing the flake.`,
          es: `${label}: ¿pruebas inestables? ¿Repetir el paso de pruebas hasta N veces antes de fallar (0 = no; máx. 3)? Mejor corregir el flaky.`,
        }, { app: app.name, yaml: `ci.gates.apps.${app.name}.retry`, options: [0, 1, 2, 3], recommended: 0 })
      );
    }
  }

  if (repo.dockerfiles.length) {
    questions.push(
      q("docker.build", "docker", {
        pt: `Dockerfiles encontrados (${repo.dockerfiles.map((d) => d.path).join(", ")}). Buildar as imagens como gate?`,
        en: `Dockerfiles found (${repo.dockerfiles.map((d) => d.path).join(", ")}). Build images as a gate?`,
        es: `Dockerfiles encontrados (${repo.dockerfiles.map((d) => d.path).join(", ")}). ¿Construir las imágenes como gate?`,
      }, { yaml: "ci.gates.docker.build", options: GATE_MODES, recommended: "block", evidence: repo.dockerfiles.map((d) => d.path) }),
      q("docker.scan", "docker", {
        pt: "Escanear as imagens com Trivy (vulnerabilidades HIGH/CRITICAL)?",
        en: "Scan images with Trivy (HIGH/CRITICAL vulnerabilities)?",
      }, { yaml: "ci.gates.docker.scan", options: GATE_MODES, recommended: "warn" }),
      q("docker.lint", "docker", {
        pt: `Lint dos Dockerfiles com hadolint${repo.hadolint ? " (.hadolint.yaml encontrado)" : ""}?`,
        en: `Lint Dockerfiles with hadolint${repo.hadolint ? " (.hadolint.yaml found)" : ""}?`,
        es: `¿Lint de los Dockerfiles con hadolint${repo.hadolint ? " (.hadolint.yaml encontrado)" : ""}?`,
      }, { yaml: "ci.gates.docker.lint", options: GATE_MODES, recommended: repo.hadolint ? "block" : "warn" }),
      q("docker.cache", "docker", {
        pt: "Usar buildx com cache do GitHub Actions (type=gha) para builds bem mais rápidos?",
        en: "Use buildx with the GitHub Actions cache (type=gha) for much faster builds?",
      }, { yaml: "ci.gates.docker.cache", options: ["yes", "no"], recommended: "yes" }),
      q("docker.publish", "docker", {
        pt: "Publicar as imagens no GHCR (ghcr.io/<owner>/<repo>-<nome>) em push na branch principal e em tags v*? Usa só o GITHUB_TOKEN.",
        en: "Publish images to GHCR (ghcr.io/<owner>/<repo>-<name>) on pushes to the main branch and v* tags? Uses only GITHUB_TOKEN.",
      }, { yaml: "ci.gates.docker.publish", options: ["yes", "no"], recommended: "no", followUps: [
        { id: "platforms", pt: "Plataformas (linux/amd64; linux/arm64 dobra o tempo)?", en: "Platforms?", recommended: ["linux/amd64"] },
      ] })
    );
  }

  for (const c of repo.compose) {
    const infra = c.services.filter((s) => s.infra);
    questions.push(
      q(`compose.${c.path}`, "docker", {
        pt: `Compose ${c.path} (${c.services.map((s) => s.image || s.name).join(", ")}). Smoke test: subir com --wait e derrubar no fim?`,
        en: `Compose ${c.path} (${c.services.map((s) => s.image || s.name).join(", ")}). Smoke test: up --wait then down?`,
        es: `Compose ${c.path} (${c.services.map((s) => s.image || s.name).join(", ")}). Smoke test: ¿levantar con --wait y bajar al final?`,
      }, {
        yaml: "ci.gates.compose_smoke",
        options: GATE_MODES,
        recommended: infra.length ? "warn" : "off",
        evidence: c.services,
        followUps: [
          { id: "services", pt: "Quais serviços subir (vazio = todos)?", en: "Which services (empty = all)?", recommended: infra.map((s) => s.name) },
          { id: "check", pt: "Comando de verificação depois de subir (ex.: npm run rabbit:check)?", en: "Post-up check command?", recommended: null },
          { id: "secrets", pt: "Credenciais do compose ficam só locais/.env.example? (nunca no workflow)", en: "Compose credentials stay local/.env.example only?", recommended: "yes" },
        ],
      })
    );
  }

  for (const e of repo.e2e) {
    questions.push(
      q(`e2e.${e.tool}.${e.dir || "root"}`, "e2e", {
        pt: `${e.tool} encontrado em ${e.config}. Rodar e2e no CI (mais lento; pode ficar só em PR para main)?`,
        en: `${e.tool} found at ${e.config}. Run e2e in CI (slower; maybe PRs to main only)?`,
        es: `${e.tool} encontrado en ${e.config}. ¿Correr e2e en el CI (más lento; puede quedar solo en PR a main)?`,
      }, { yaml: "ci.gates.e2e", options: GATE_MODES, recommended: "warn" })
    );
  }

  if (repo.iac.terraform.length) {
    questions.push(
      q("iac.terraform", "iac", {
        pt: `Terraform em ${repo.iac.terraform.join(", ")}. Gate de fmt -check + validate (sem backend)?`,
        en: `Terraform in ${repo.iac.terraform.join(", ")}. Gate on fmt -check + validate (no backend)?`,
        es: `Terraform en ${repo.iac.terraform.join(", ")}. ¿Gate de fmt -check + validate (sin backend)?`,
      }, { yaml: "ci.gates.iac", options: GATE_MODES, recommended: "block" })
    );
  }

  if (repo.openapi.length) {
    questions.push(
      q("openapi", "contract", {
        pt: `Specs OpenAPI (${repo.openapi.join(", ")}). Lint do contrato com Redocly?`,
        en: `OpenAPI specs (${repo.openapi.join(", ")}). Lint the contract with Redocly?`,
        es: `Specs OpenAPI (${repo.openapi.join(", ")}). ¿Lint del contrato con Redocly?`,
      }, { yaml: "ci.gates.openapi", options: GATE_MODES, recommended: "warn" })
    );
  }

  questions.push(
    q("commitlint", "process", {
      pt: repo.commitlint
        ? `commitlint configurado (${repo.commitlint}). Validar mensagens de commit do PR?`
        : "Validar mensagens de commit (Conventional Commits) nos PRs?",
      en: repo.commitlint
        ? `commitlint configured (${repo.commitlint}). Validate PR commit messages?`
        : "Validate commit messages (Conventional Commits) on PRs?",
      es: repo.commitlint
        ? `commitlint configurado (${repo.commitlint}). ¿Validar los mensajes de commit del PR?`
        : ES["Validate commit messages (Conventional Commits) on PRs?"],
    }, { yaml: "ci.gates.commitlint", options: GATE_MODES, recommended: repo.commitlint ? "block" : "off" })
  );

  if (repo.codeqlLanguages.length) {
    questions.push(
      q("codeql", "security", {
        pt: `Análise estática de segurança com CodeQL (${repo.codeqlLanguages.join(", ")})? Grátis em repo público; privado exige GitHub Advanced Security.`,
        en: `CodeQL security analysis (${repo.codeqlLanguages.join(", ")})? Free for public repos; private needs GHAS.`,
        es: `¿Análisis estático de seguridad con CodeQL (${repo.codeqlLanguages.join(", ")})? Gratis en repo público; privado requiere GitHub Advanced Security.`,
      }, { yaml: "ci.gates.codeql", options: GATE_MODES, recommended: "off" })
    );
  }

  questions.push(
    q("dependency_review", "security", {
      pt: "Dependency review nos PRs: bloquear dependências novas com vulnerabilidade conhecida (só olha o que o PR adiciona)? Repo privado exige GitHub Advanced Security.",
      en: "Dependency review on PRs: block newly added dependencies with known vulnerabilities? Private repos need GHAS.",
    }, { yaml: "ci.gates.dependency_review", options: GATE_MODES, recommended: "warn", followUps: [
      { id: "severity", pt: "Severidade mínima?", en: "Minimum severity?", options: AUDIT_LEVELS, recommended: "high" },
    ] }),
    q("secrets_scan", "security", {
      pt: "Varredura de segredos vazados (gitleaks) nos commits do PR/push?",
      en: "Scan PR/push commits for leaked secrets (gitleaks)?",
    }, { yaml: "ci.gates.secrets_scan", options: GATE_MODES, recommended: "block" }),
    q("pr_checks", "process", {
      pt: "Higiene de PR: nome da branch (feat/…, fix/…), título em Conventional Commits, link de card (CARD_ID no corpo/branch) e tamanho máximo do diff?",
      en: "PR hygiene: branch name (feat/…, fix/…), Conventional Commits title, card link (CARD_ID in body/branch) and max diff size?",
    }, { yaml: "ci.gates.pr_checks", options: GATE_MODES, recommended: "warn", followUps: [
      { id: "branch_name", pt: "Gate do nome da branch?", en: "Branch name gate?", options: GATE_MODES, recommended: "warn" },
      { id: "title", pt: "Gate do título do PR?", en: "PR title gate?", options: GATE_MODES, recommended: "warn" },
      { id: "card_link", pt: "Exigir CARD_ID (ex.: PROJ-FEAT-12) no PR?", en: "Require a CARD_ID in the PR?", options: GATE_MODES, recommended: "warn" },
      { id: "size", pt: "Avisar quando o PR passar de N linhas alteradas (ex.: 800)?", en: "Warn above N changed lines?", recommended: { mode: "warn", max: 800 } },
    ] })
  );

  if (webApps.length) {
    const names = webApps.map((a) => `${a.name} (${a.web.framework})`).join(", ");
    questions.push(
      q("lighthouse", "web", {
        pt: `App web detectado: ${names}. Lighthouse CI no PR com notas mínimas (performance 0.8, acessibilidade 0.9, best-practices 0.9, SEO 0.8)?`,
        en: `Web app detected: ${names}. Lighthouse CI on PRs with minimum scores (performance 0.8, accessibility 0.9, best-practices 0.9, SEO 0.8)?`,
        es: `App web detectada: ${names}. ¿Lighthouse CI en el PR con notas mínimas (performance 0.8, accesibilidad 0.9, best-practices 0.9, SEO 0.8)?`,
      }, { yaml: "ci.gates.lighthouse", options: GATE_MODES, recommended: "warn", evidence: webApps.map((a) => a.web) }),
      q("a11y", "web", {
        pt: `Acessibilidade com axe-core nas páginas de ${webApps[0].name} (falha em violações WCAG)?`,
        en: `Accessibility with axe-core on ${webApps[0].name} pages (fails on WCAG violations)?`,
        es: `¿Accesibilidad con axe-core en las páginas de ${webApps[0].name} (falla con violaciones WCAG)?`,
      }, { yaml: "ci.gates.a11y", options: GATE_MODES, recommended: "warn", followUps: [
        { id: "urls", pt: "Quais rotas testar?", en: "Which routes?", recommended: ["/"] },
      ] })
    );
    const bundleApps = scan.apps.filter((a) => a.bundleSize);
    questions.push(
      q("bundle_size", "web", bundleApps.length
        ? {
            pt: `size-limit configurado em ${bundleApps.map((a) => a.name).join(", ")}. Gate de tamanho de bundle?`,
            en: `size-limit configured in ${bundleApps.map((a) => a.name).join(", ")}. Bundle size gate?`,
            es: `size-limit configurado en ${bundleApps.map((a) => a.name).join(", ")}. ¿Gate de tamaño de bundle?`,
          }
        : { pt: "Sem size-limit. Adotar orçamento de tamanho de bundle (size-limit + .size-limit.json)?", en: "No size-limit. Adopt a bundle size budget (size-limit)?" },
      { yaml: bundleApps.length ? "ci.gates.bundle_size" : `ci.gates.apps.${webApps[0].name}.commands.bundle_size`, options: bundleApps.length ? GATE_MODES : ["configure tool now", "provide my own command", "skip"], recommended: bundleApps.length ? "warn" : "skip" })
    );
  }

  if (mobileApps.length) {
    const m = mobileApps[0];
    questions.push(
      q("mobile_build", "mobile", {
        pt: `App mobile ${m.name} (${m.mobile.kind}). Buildar ${m.mobile.android ? "APK debug" : ""}${m.mobile.android && m.mobile.ios ? " e " : ""}${m.mobile.ios ? "iOS sem assinatura (runner macOS custa 10x)" : ""} no CI e anexar como artifact?`,
        en: `Mobile app ${m.name} (${m.mobile.kind}). Build ${m.mobile.android ? "a debug APK" : ""}${m.mobile.android && m.mobile.ios ? " and " : ""}${m.mobile.ios ? "unsigned iOS (macOS runner is 10x minutes)" : ""} in CI and attach as artifact?`,
        es: `App mobile ${m.name} (${m.mobile.kind}). ¿Construir ${m.mobile.android ? "APK debug" : ""}${m.mobile.android && m.mobile.ios ? " e " : ""}${m.mobile.ios ? "iOS sin firma (el runner macOS cuesta 10x)" : ""} en el CI y adjuntarlo como artifact?`,
      }, { yaml: "ci.gates.mobile_build", options: GATE_MODES, recommended: "warn", followUps: [
        ...(m.mobile.ios ? [{ id: "ios", pt: "Incluir build iOS (macOS)?", en: "Include iOS build (macOS)?", options: ["yes", "no"], recommended: "no" }] : []),
      ] })
    );
  }

  if (repo.docs?.markdownFiles) {
    questions.push(
      q("docs", "docs", {
        pt: `${repo.docs.markdownFiles} arquivo(s) Markdown. Checar links quebrados (lychee, offline por padrão)${repo.docs.markdownlint ? " e markdownlint (config encontrada)" : " e estilo com markdownlint"}?`,
        en: `${repo.docs.markdownFiles} Markdown file(s). Check broken links (lychee, offline by default)${repo.docs.markdownlint ? " and markdownlint (config found)" : " and markdownlint style"}?`,
        es: `${repo.docs.markdownFiles} archivo(s) Markdown. ¿Revisar enlaces rotos (lychee, offline por defecto)${repo.docs.markdownlint ? " y markdownlint (config encontrada)" : " y estilo con markdownlint"}?`,
      }, { yaml: "ci.gates.docs", options: GATE_MODES, recommended: "warn", followUps: [
        { id: "links", pt: "Gate de links?", en: "Links gate?", options: GATE_MODES, recommended: "warn" },
        { id: "external", pt: "Checar também links externos (http)? Pode ser instável.", en: "Also check external links? Can be flaky.", options: ["yes", "no"], recommended: "no" },
        { id: "markdown", pt: "Gate de markdownlint?", en: "markdownlint gate?", options: GATE_MODES, recommended: repo.docs.markdownlint ? "warn" : "off" },
      ] })
    );
  }

  questions.push(
    q("notify", "reporting", {
      pt: "Notificar Slack/Discord quando o CI falhar em push (nunca em PR)? Usa os secrets SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL; sem secret o passo é pulado.",
      en: "Notify Slack/Discord when CI fails on push (never on PRs)? Uses SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL secrets; skipped when unset.",
    }, { yaml: "ci.gates.notify", options: NOTIFY_ON, recommended: "off" })
  );

  if (!repo.github.dependabot && !repo.github.renovate) {
    questions.push(
      q("dependabot", "maintenance", {
        pt: "Sem Dependabot/Renovate. Criar .github/dependabot.yml (updates semanais; target-branch = branch de integração, ex.: dev)?",
        en: "No Dependabot/Renovate. Create .github/dependabot.yml (weekly; target-branch = integration branch, e.g. dev)?",
      }, { action: "create .github/dependabot.yml", options: ["yes", "no"], recommended: "yes" })
    );
  }

  if (!repo.github.codeowners) {
    questions.push(
      q("codeowners", "process", {
        pt: "Sem CODEOWNERS. Criar para exigir review por área (api/, web/, mobile/)?",
        en: "No CODEOWNERS. Create one to require reviews per area?",
      }, { action: "create .github/CODEOWNERS", options: ["yes", "no"], recommended: "no" })
    );
  }

  if (!repo.preCommit.husky && !repo.preCommit.lefthook && !repo.preCommit.preCommit) {
    questions.push(
      q("hooks", "local", {
        pt: "Hook local (pre-commit) rodando format/lint antes do commit, para o gate de styles quase nunca falhar no CI?",
        en: "Local pre-commit hook running format/lint so the styles gate rarely fails in CI?",
      }, { action: "configure husky/lefthook/pre-commit", options: ["yes", "no"], recommended: "no" })
    );
  }

  questions.push(
    q("required_checks", "process", {
      pt: "Marcar os jobs com modo block como required checks na branch protection/ruleset?",
      en: "Mark block-mode jobs as required checks in branch protection/rulesets?",
    }, { action: "gh api rulesets (manual confirmation)", options: ["yes", "no"], recommended: "yes" }),
    q("summary", "reporting", {
      pt: "Publicar resumo (cobertura, audit) no Job Summary do Actions? (padrão: sim)",
      en: "Publish coverage/audit summary to the Actions Job Summary? (default: yes)",
    }, { options: ["yes", "no"], recommended: "yes" })
  );

  return questions.map((item) => ({ ...item, status: questionStatus(item, gates) }));
}

function getGatesPath(gates, yamlPath) {
  if (!yamlPath?.startsWith("ci.gates.")) return undefined;
  let cur = gates;
  let prev = null;
  for (const part of yamlPath.slice("ci.gates.".length).split(".")) {
    if (!isPlain(cur)) return cur !== undefined && scalarField(prev, cur) === part ? cur : undefined;
    prev = part;
    cur = cur[part];
  }
  return cur;
}

/** new | answered | declined — so a re-run only asks what is still open. */
export function questionStatus(item, gates) {
  if (!isPlain(gates)) return "new";
  if (list(gates.declined).includes(item.id)) return "declined";
  if (item.yaml && getGatesPath(gates, item.yaml) !== undefined) return "answered";
  if (item.app && /^apps\.[^.]+\.[a-z_]+$/.test(item.id) && item.yaml) {
    const appCfg = gates.apps?.[item.app];
    if (appCfg === "off" || appCfg === false) return "answered";
  }
  return "new";
}

/**
 * Suggested ci.gates YAML using every question's recommended answer.
 * The agent edits it with the person's answers before writing project.yml.
 */
export function suggestGatesYaml(scan, { defaultBranch = "main", preset = null } = {}) {
  if (PRESET_NAMES.includes(preset)) return suggestPresetYaml(scan, { defaultBranch, preset });
  const lines = ["  gates:", `    branches: [${defaultBranch}]`, "    pull_request: true", "    defaults:"];
  lines.push("      lint: block", "      format: block", "      typecheck: block", "      test: block", "      build: block");
  lines.push("      coverage: { mode: warn, metric: lines, min: 80 }");
  lines.push("      audit: { mode: warn, level: high, fix: check }");
  if (scan.apps.length) {
    lines.push("    apps:");
    for (const app of scan.apps) {
      lines.push(`      ${app.name}:`);
      lines.push(`        path: ${app.path}`);
      for (const g of ["lint", "format", "typecheck", "test", "build"]) {
        if (!app.gates[g]) lines.push(`        ${g}: off   # not detected`);
      }
      if (!app.gates.coverage) lines.push("        coverage: off   # no coverage tool detected");
      if (!app.gates.audit) lines.push("        audit: off   # no audit tool for this stack");
      else if (!app.gates.audit.fix) lines.push("        audit: { fix: off }   # stack has no safe auto-fix");
      if (app.gates.migrations) lines.push("        migrations: block");
    }
  }
  if (scan.repo.dockerfiles.length) lines.push("    docker: { build: block, scan: warn }");
  const infraCompose = scan.repo.compose.find((c) => c.services.some((s) => s.infra));
  if (infraCompose) {
    const svc = infraCompose.services.filter((s) => s.infra).map((s) => s.name);
    lines.push(`    compose_smoke: { mode: warn, file: ${infraCompose.path}, services: [${svc.join(", ")}] }`);
  }
  if (scan.repo.e2e.length) lines.push("    e2e: warn");
  if (scan.repo.iac.terraform.length) lines.push("    iac: block");
  if (scan.repo.openapi.length) lines.push("    openapi: warn");
  lines.push(`    commitlint: ${scan.repo.commitlint ? "block" : "off"}`);
  if (scan.repo.codeqlLanguages.length) lines.push("    codeql: off");
  return lines.join("\n");
}

/** Preset draft: only what differs from the preset for this repo (undetected gates, services, compose). */
function suggestPresetYaml(scan, { defaultBranch, preset }) {
  const lines = ["  gates:", `    preset: ${preset}`, `    branches: [${defaultBranch}]`];
  if (scan.apps.length) {
    lines.push("    apps:");
    for (const app of scan.apps) {
      lines.push(`      ${app.name}:`, `        path: ${app.path}`);
      for (const g of ["lint", "format", "typecheck", "test", "build"]) {
        if (!app.gates[g]) lines.push(`        ${g}: off   # not detected`);
      }
      if (preset !== "minimal" && !app.gates.coverage) lines.push("        coverage: off   # no coverage tool detected");
      if (preset !== "minimal" && !app.gates.audit) lines.push("        audit: off   # no audit tool for this stack");
      else if (preset === "strict" && app.gates.audit && !app.gates.audit.fix) lines.push("        audit: { fix: off }   # stack has no safe auto-fix");
      if (preset !== "minimal" && !app.gates.migrations) lines.push("        migrations: off   # no migration tool detected");
      if (app.services?.length) lines.push(`        # services (auto): ${app.services.map((s) => s.kind).join(", ")}`);
      if (app.migrate && app.services?.length) lines.push("        migrate: true");
      if (app.library && app.setup?.version) lines.push(`        # library: consider matrix: { versions: [${app.setup.version}] }`);
    }
  }
  const infraCompose = scan.repo.compose.find((c) => c.services.some((s) => s.infra));
  if (preset !== "minimal" && infraCompose) {
    const svc = infraCompose.services.filter((s) => s.infra).map((s) => s.name);
    lines.push(`    compose_smoke: { file: ${infraCompose.path}, services: [${svc.join(", ")}] }`);
  }
  if (preset !== "minimal" && !scan.repo.docs?.markdownFiles) lines.push("    docs: off");
  return lines.join("\n");
}

/** Typical wall-clock minutes per job (GitHub-hosted, warm cache). Rough by design. */
const STACK_MINUTES = {
  node: 3, python: 3, go: 3, rust: 6, flutter: 5, dart: 3, dotnet: 4, "java-maven": 5, "java-gradle": 5, php: 3, ruby: 4, custom: 3,
};
const OS_MULTIPLIER = { "ubuntu-latest": 1, linux: 1, windows: 2, macos: 10 };

function osMultiplier(runner) {
  const r = String(runner || "ubuntu-latest").toLowerCase();
  if (r.includes("macos")) return OS_MULTIPLIER.macos;
  if (r.includes("windows")) return OS_MULTIPLIER.windows;
  return 1;
}

/**
 * Billable-minute estimate per pipeline run (push = everything; PR assumes the affected filter
 * skips half of the apps in a monorepo). macOS runners bill 10x, Windows 2x.
 */
export function estimateCiMinutes(plan, scan = null) {
  const repo = scan?.repo;
  const present = (cond) => !repo || Boolean(cond);
  const jobs = [];
  const add = (name, minutes, mult = 1, prOnly = false, pushOnly = false) =>
    jobs.push({ name, minutes, billable: Math.ceil(minutes) * mult, prOnly, pushOnly });
  for (const app of plan.apps) {
    let m = STACK_MINUTES[app.stack] ?? 3;
    if (app.decisions.coverage.mode !== "off") m += 1;
    if (app.resolvedServices?.length) m += 1;
    const versions = Math.max(1, app.decisions.matrix.versions.length);
    const oses = app.decisions.matrix.os.length ? app.decisions.matrix.os : [app.decisions.runner || plan.runner];
    for (const os of oses) add(`app-${app.name}${oses.length > 1 ? ` (${os})` : ""}`, m * versions, osMultiplier(os));
    if (app.decisions.fix.lint !== "off" || app.decisions.fix.format !== "off") add(`style-fix-${app.name}`, 2, 1, true);
  }
  const dockerCount = plan.docker.files?.length || repo?.dockerfiles.length || 1;
  const hasDocker = present(repo?.dockerfiles.length);
  if (hasDocker && plan.docker.build !== "off") add("docker", (plan.docker.cache ? 3 : 6) * dockerCount);
  if (hasDocker && plan.docker.publish) add("docker-publish", 4 * dockerCount, 1, false, true);
  if (plan.composeSmoke.mode !== "off" && plan.composeSmoke.file) add("compose-smoke", 3);
  if (plan.e2e !== "off" && present(repo?.e2e.length)) add("e2e", 8 * Math.max(1, repo?.e2e.length || 1));
  if (plan.iac !== "off" && present(repo?.iac.terraform.length)) add("iac", 1);
  if (plan.openapi !== "off" && present(repo?.openapi.length)) add("openapi", 1);
  if (plan.commitlint !== "off") add("commitlint", 1, 1, true);
  if (plan.codeql !== "off" && present(repo?.codeqlLanguages.length)) add("codeql", 8);
  if (plan.dependencyReview.mode !== "off") add("dependency-review", 1, 1, true);
  if (plan.secretsScan !== "off") add("secrets", 1);
  if (Object.values(plan.prChecks).some((c) => c.mode !== "off")) add("pr-hygiene", 1, 1, true);
  if (plan.lighthouse.mode !== "off") add("lighthouse", 5);
  if (plan.a11y.mode !== "off") add("a11y", 4);
  if (plan.bundleSize.mode !== "off") add("bundle-size", 3);
  if (plan.mobileBuild.mode !== "off") {
    if (plan.mobileBuild.android) add("mobile-android", 10);
    if (plan.mobileBuild.ios) add("mobile-ios", 15, OS_MULTIPLIER.macos);
  }
  if ((plan.docs.links !== "off" || plan.docs.markdown !== "off") && present(repo?.docs?.markdownFiles)) add("docs", 1);
  if (plan.affected.enabled && plan.apps.length > 1) add("changes", 1, 1, true);

  const sum = (pred) => jobs.filter(pred).reduce((n, j) => n + j.billable, 0);
  const appShare = plan.affected.enabled && plan.apps.length > 1 ? 0.5 : 1;
  const prMinutes = Math.ceil(
    jobs.filter((j) => !j.pushOnly).reduce((n, j) => n + (j.name.startsWith("app-") ? j.billable * appShare : j.billable), 0)
  );
  return {
    jobs,
    perPush: sum((j) => !j.prOnly),
    perPullRequest: prMinutes,
    note: "Rough billable minutes per run on GitHub-hosted runners (Linux 1x, Windows 2x, macOS 10x). Public repos are free.",
  };
}

function printHuman(scan, questions, { lang = "en", root = null } = {}) {
  const tr = (key, vars = {}) => t(key, vars, lang, { root });
  console.log(`${tr("gates.header", { apps: scan.apps.length, files: scan.scannedFiles })}\n`);
  for (const app of scan.apps) {
    console.log(`■ ${app.name}  [${app.stack}${app.pm && app.pm !== app.stack ? `/${app.pm}` : ""}]  ${app.path}`);
    for (const g of APP_GATES) {
      const v = app.gates[g];
      const extra = v?.needs ? `  (needs ${v.needs})` : v?.fix && g !== "audit" ? `  (fix: ${v.fix})` : "";
      console.log(`    ${g.padEnd(10)} ${v ? v.command : "—"}${extra}`);
      if (g === "audit" && v?.fix) console.log(`    ${"".padEnd(10)} fix: ${v.fix}`);
    }
    if (app.setup?.version) console.log(`    ${"version".padEnd(10)} ${app.setup.version} (${app.setup.versionSource})`);
    if (app.services?.length) console.log(`    ${"services".padEnd(10)} ${app.services.map((s) => `${s.kind}=${s.image} (${s.source})`).join(", ")}`);
    if (app.migrate) console.log(`    ${"migrate".padEnd(10)} ${app.migrate}`);
    if (app.web) console.log(`    ${"web".padEnd(10)} ${app.web.framework}${app.web.dist ? ` → ${app.web.dist}` : ""}`);
    if (app.bundleSize) console.log(`    ${"bundle".padEnd(10)} ${app.bundleSize.command}`);
    if (app.mobile) console.log(`    ${"mobile".padEnd(10)} ${app.mobile.kind}: ${[app.mobile.android && "android", app.mobile.ios && "ios"].filter(Boolean).join(", ")}`);
  }
  const r = scan.repo;
  console.log(`\n${tr("gates.repoLevel")}`);
  console.log(`    docker     ${r.dockerfiles.map((d) => d.path).join(", ") || "—"}`);
  for (const c of r.compose) {
    console.log(`    compose    ${c.path}: ${c.services.map((s) => `${s.name}${s.image ? `=${s.image}` : ""}`).join(", ")}`);
  }
  console.log(`    e2e        ${r.e2e.map((e) => `${e.tool}@${e.dir || "."}`).join(", ") || "—"}`);
  console.log(`    iac        ${r.iac.terraform.length ? `terraform: ${r.iac.terraform.join(", ")}` : "—"}${r.iac.helm.length ? ` helm: ${r.iac.helm.join(", ")}` : ""}`);
  console.log(`    openapi    ${r.openapi.join(", ") || "—"}`);
  console.log(`    commitlint ${r.commitlint || "—"}`);
  console.log(`    codeql     ${r.codeqlLanguages.join(", ") || "—"}`);
  console.log(`    dependabot ${r.github.dependabot ? "yes" : r.github.renovate ? "renovate" : "no"}  codeowners ${r.github.codeowners ? "yes" : "no"}`);
  console.log(`    hadolint   ${r.hadolint ? ".hadolint.yaml" : "—"}  docs ${r.docs.markdownFiles} md${r.docs.markdownlint ? " (markdownlint config)" : ""}`);
  console.log(`    release    ${r.release.join(", ") || "—"}  deploy ${r.deploy.join(", ") || "—"}`);

  const counts = questions.reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`\n${tr("gates.questions", { count: questions.length, summary: summary ? `: ${summary}` : "" })}`);
  const recommended = tr("gates.recommended");
  for (const item of questions) {
    const text = questionText(item.question, lang);
    const tag = item.status && item.status !== "new" ? ` (${item.status})` : "";
    console.log(`  - [${item.id}]${tag} ${text}${item.recommended !== undefined ? `  → ${recommended}: ${JSON.stringify(item.recommended)}` : ""}`);
  }
  console.log(`\n${tr("gates.next1")}`);
  console.log(tr("gates.next2"));
  console.log(tr("gates.next3"));
}

/** Minimal line diff (LCS) for --preview; returns `+`/`-`/` ` prefixed lines with collapsed context. */
export function lineDiff(before, after, { context = 2 } = {}) {
  const a = String(before || "").split("\n");
  const b = String(after || "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  const keep = ops.map((op, k) => op[0] !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o[0] !== " "));
  const out = [];
  let skipped = false;
  ops.forEach((op, k) => {
    if (keep[k]) {
      out.push(`${op[0]} ${op[1]}`);
      skipped = false;
    } else if (!skipped) {
      out.push("  …");
      skipped = true;
    }
  });
  return { lines: out, added: ops.filter((o) => o[0] === "+").length, removed: ops.filter((o) => o[0] === "-").length };
}

function printEstimate(est) {
  console.log("\nCI minutes estimate (billable, per run):");
  for (const j of est.jobs) {
    const when = j.prOnly ? " (PR only)" : j.pushOnly ? " (push only)" : "";
    console.log(`    ${j.name.padEnd(28)} ~${j.billable} min${when}`);
  }
  console.log(`  ≈ ${est.perPush} min per push · ≈ ${est.perPullRequest} min per PR update`);
  console.log(`  ${est.note}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const { resolveHyperionPaths } = await import("./paths.mjs");
  const { detectDefaultBranch, readCiGatesFromProjectYml } = await import("./pipeline-lib.mjs");
  const root = process.cwd();
  const paths = resolveHyperionPaths(root);
  const kitRootRel = paths.kitRootRel || "";
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const preset = flag("--preset");
  if (preset && !PRESET_NAMES.includes(preset)) {
    console.error(`Unknown preset "${preset}" — use ${PRESET_NAMES.join(", ")}`);
    process.exit(2);
  }
  let gates = await readCiGatesFromProjectYml(readText(paths.projectYmlPath) || "");
  const gatesFile = flag("--gates-file");
  if (gatesFile) {
    const { load } = await import("js-yaml");
    const doc = load(readText(path.resolve(root, gatesFile)) || "") || {};
    gates = doc?.ci?.gates || doc?.gates || doc;
  }
  if (preset) gates = { ...(gates || {}), preset };

  const scan = scanRepoForGates(root, { kitRootRel });
  let questions = buildGateQuestions(scan, { gates });
  if (argv.includes("--pending")) questions = questions.filter((x) => x.status === "new");
  const defaultBranch = detectDefaultBranch(root);
  const lang = normalizeTag(flag("--lang")) || (argv.includes("--en") ? "en" : resolveLanguages(root).primary);

  if (argv.includes("--json")) {
    const plan = resolveGatePlan(scan, gates || {});
    console.log(JSON.stringify({ scan, questions, estimate: estimateCiMinutes(plan, scan) }, null, 2));
  } else if (argv.includes("--yaml")) {
    console.log(suggestGatesYaml(scan, { defaultBranch, preset }));
  } else if (argv.includes("--preview") || argv.includes("--estimate")) {
    const { renderProductCiForRepo } = await import("./product-ci-render.mjs");
    const { plan, content } = renderProductCiForRepo(root, { gates: gates || {}, kitRootRel, defaultBranch });
    printEstimate(estimateCiMinutes(plan, scan));
    if (argv.includes("--preview")) {
      const target = path.join(root, ".github", "workflows", "hyperion-product-ci.yml");
      const current = readText(target);
      if (!current) {
        console.log(`\n${toPosix(path.relative(root, target))} does not exist yet — full render:\n`);
        console.log(content);
      } else {
        const diff = lineDiff(current, content);
        console.log(`\nPreview ${toPosix(path.relative(root, target))}: +${diff.added} −${diff.removed}`);
        if (diff.added || diff.removed) console.log(diff.lines.join("\n"));
        else console.log("No changes.");
      }
      if (argv.includes("--diagram")) {
        const { graphFromWorkflowText, toMermaid } = await import("./pipeline-diagram.mjs");
        const graph = graphFromWorkflowText(content, { title: "ci.gates → hyperion-product-ci.yml", lang, root });
        console.log(`\nPipeline diagram (Mermaid):\n\n\`\`\`mermaid\n${toMermaid(graph, { steps: !argv.includes("--no-steps"), lang, root })}\n\`\`\``);
      }
      console.log("\nNothing written. Apply with: npm run hyperion:pipeline-apply -- --refresh-gates --yes");
      if (!argv.includes("--diagram")) console.log("Diagram of this pipeline: add --diagram (or npm run hyperion:pipeline-diagram -- --write).");
    }
  } else {
    printHuman(scan, questions, { lang, root });
  }
}

// Not awaited at top level: product-ci-render imports this module, so it must finish evaluating first.
if (isMain) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
