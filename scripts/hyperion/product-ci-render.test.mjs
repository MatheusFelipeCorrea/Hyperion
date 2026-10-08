import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { renderProductCiForRepo, readGatesHash, gatesHash } from "./product-ci-render.mjs";

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-render-"));
  write(root, "api/package.json", {
    scripts: { test: "jest", lint: "eslint .", "format:check": "prettier --check .", "rabbit:check": "node check.js" },
    devDependencies: { jest: "^29", eslint: "^9", prettier: "^3" },
  });
  write(root, "api/package-lock.json", "{}");
  write(root, "api/Dockerfile", "FROM node:22\n");
  write(root, "api/docker-compose.yml", "services:\n  rabbitmq:\n    image: rabbitmq:3\n");
  write(root, "svc/go.mod", "module example.com/svc\n\ngo 1.22\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const job = (doc, id) => doc.jobs[id];
const stepNamed = (j, re) => j.steps.find((s) => re.test(s.name));

describe("renderProductCiForRepo", () => {
  it("renders valid YAML with one job per app and maps block/warn/off", () => {
    const { content } = renderProductCiForRepo(root, {
      kitRootRel: "Hyperion",
      gates: {
        branches: ["main", "dev"],
        defaults: { coverage: { mode: "block", min: 85 }, audit: { mode: "warn", level: "high", fix: "check" }, build: "off" },
        apps: { svc: { format: "warn", coverage: "off" } },
      },
    });
    const doc = load(content);
    assert.deepEqual(doc.on.push.branches, ["main", "dev"]);
    assert.ok("pull_request" in doc.on);
    assert.deepEqual(Object.keys(doc.jobs).sort(), ["app-api", "app-svc"]);

    const api = job(doc, "app-api");
    assert.equal(api.defaults.run["working-directory"], "api");
    assert.ok(stepNamed(api, /^Format check/));
    const gate = stepNamed(api, /^Coverage gate/);
    assert.match(gate.run, /"\$GITHUB_WORKSPACE\/Hyperion\/scripts\/hyperion\/coverage-gate\.mjs" --dir \. --metric lines --min 85 --mode block/);
    const audit = stepNamed(api, /^Dependency audit/);
    assert.equal(audit["continue-on-error"], true);
    assert.match(audit.run, /npm audit --audit-level=high/);
    const fix = stepNamed(api, /^Audit fix check/);
    assert.match(fix.run, /npm audit fix/);
    assert.match(fix.run, /checkout -- \./);
    assert.ok(!stepNamed(api, /^Build/));

    const svc = job(doc, "app-svc");
    assert.equal(stepNamed(svc, /^Format check/)["continue-on-error"], true);
    assert.ok(stepNamed(svc, /^Test$/));
    assert.ok(!stepNamed(svc, /^Coverage gate/));
    assert.equal(svc.steps.find((s) => s.uses === "actions/setup-go@v5").with["go-version-file"], "svc/go.mod");
  });

  it("adds docker, compose smoke and the weekly audit-fix PR job only when accepted", () => {
    const { content } = renderProductCiForRepo(root, {
      gates: {
        defaults: { audit: { mode: "warn", fix: "pr" } },
        apps: { svc: "off" },
        docker: { build: "block", scan: "warn" },
        compose_smoke: { mode: "warn", check: "npm run rabbit:check" },
      },
    });
    const doc = load(content);
    assert.ok(doc.on.schedule);
    const pr = job(doc, "audit-fix-api");
    assert.match(pr.if, /schedule/);
    assert.equal(pr.permissions["pull-requests"], "write");
    const docker = job(doc, "docker");
    assert.match(stepNamed(docker, /^Build api\/Dockerfile/).run, /docker build -f "api\/Dockerfile"/);
    assert.equal(stepNamed(docker, /^Scan/)["continue-on-error"], true);
    const compose = job(doc, "compose-smoke");
    assert.equal(compose["continue-on-error"], true);
    assert.equal(compose.defaults.run["working-directory"], "api");
    assert.ok(stepNamed(compose, /^Install dependencies/));
    assert.match(stepNamed(compose, /^Start services/).run, /up -d --wait/);
    assert.equal(stepNamed(compose, /^Stop services/).if, "${{ always() }}");
  });

  it("embeds a stable gates hash that changes with decisions", () => {
    const a = renderProductCiForRepo(root, { gates: { defaults: { coverage: { mode: "warn" } } } });
    const b = renderProductCiForRepo(root, { gates: { defaults: { coverage: { mode: "warn" } } } });
    const c = renderProductCiForRepo(root, { gates: { defaults: { coverage: { mode: "block" } } } });
    assert.equal(readGatesHash(a.content), gatesHash(a.plan));
    assert.equal(readGatesHash(a.content), readGatesHash(b.content));
    assert.notEqual(readGatesHash(a.content), readGatesHash(c.content));
  });

  it("writes CI messages in the repo language, comments multilingual, job names in English", () => {
    const gates = {
      preset: "strict",
      defaults: { coverage: { mode: "block", min: 80, comment: true }, audit: { mode: "warn", fix: "pr" } },
      apps: { svc: "off" },
      notify: { on: "failure", slack: true },
    };
    const en = renderProductCiForRepo(root, { gates });
    write(root, ".github/project.yml", "version: 1\nlocale: pt-BR\nlanguages: [pt-BR, en]\n");
    try {
      const pt = renderProductCiForRepo(root, { gates });
      const doc = load(pt.content);
      const api = job(doc, "app-api");
      assert.match(stepNamed(api, /^Coverage gate/).run, /--lang pt-BR,en/);
      assert.doesNotMatch(stepNamed(load(en.content).jobs["app-api"], /^Coverage gate/).run, /--lang/);
      assert.ok(stepNamed(api, /^Test \+ coverage/));
      const prJob = job(doc, "audit-fix-api");
      const openPr = stepNamed(prJob, /^Open or update PR/).run;
      assert.match(openPr, /chore\(deps\): correção de audit \(api\)/);
      assert.match(openPr, /<details><summary>English<\/summary>/);
      assert.notEqual(readGatesHash(pt.content), readGatesHash(en.content));
      const hygiene = job(doc, "pr-hygiene");
      assert.equal(hygiene.name, "PR hygiene");
      assert.match(stepNamed(hygiene, /^Branch name$/).run, /não segue o padrão \$PATTERN/);
      assert.match(job(doc, "notify").steps[0].env.STATUS, /'falhou' \|\| 'passou'/);
    } finally {
      fs.rmSync(path.join(root, ".github"), { recursive: true, force: true });
    }
  });

  it("notes explicitly requested gates that have no command", () => {
    const { content } = renderProductCiForRepo(root, { gates: { apps: { svc: { typecheck: "block" } } } });
    assert.match(content, /# NOTE \(svc\): typecheck: block requested but no command/);
    load(content);
  });
});

function assertNoSecretsInIf(doc) {
  for (const [id, j] of Object.entries(doc.jobs)) {
    assert.ok(!/secrets\./.test(j.if || ""), `job ${id} uses secrets in if`);
    for (const s of j.steps || []) assert.ok(!/secrets\./.test(s.if || ""), `step ${s.name} in ${id} uses secrets in if`);
  }
}

describe("expanded product CI", () => {
  it("balanced preset: affected filter, services, style suggestions, security and PR hygiene", () => {
    const { content } = renderProductCiForRepo(root, { kitRootRel: "Hyperion", gates: { preset: "balanced" } });
    const doc = load(content);
    assertNoSecretsInIf(doc);
    assert.ok("merge_group" in doc.on);
    for (const id of ["changes", "app-api", "app-svc", "style-fix-api", "docker", "compose-smoke", "dependency-review", "secrets", "pr-hygiene"]) {
      assert.ok(doc.jobs[id], `missing job ${id}`);
    }
    const changes = job(doc, "changes");
    assert.match(changes.steps[0].with.filters, /api:\n {2}- 'api\/\*\*'/);
    assert.equal(changes.outputs.svc, "${{ steps.filter.outputs.svc }}");

    const api = job(doc, "app-api");
    assert.deepEqual(api.needs, ["changes"]);
    assert.match(api.if, /needs\.changes\.outputs\.api == 'true'/);
    assert.equal(api.services.rabbitmq.image, "rabbitmq:3");
    assert.equal(api.env.RABBITMQ_URL, "amqp://guest:guest@localhost:5672");
    assert.equal(api.permissions["pull-requests"], "write");
    assert.match(stepNamed(api, /^Coverage gate/).run, /--summary-out "\$RUNNER_TEMP\/coverage-api\.md"/);
    assert.equal(stepNamed(api, /^Coverage comment/).uses, "marocchino/sticky-pull-request-comment@v2");
    assert.equal(stepNamed(api, /^Upload test reports/).with.path.split("\n")[0], "api/coverage/");

    const fix = job(doc, "style-fix-api");
    assert.equal(fix.permissions["pull-requests"], "write");
    assert.equal(fix.permissions.contents, "read");
    assert.equal(stepNamed(fix, /^Post suggestions/).uses, "reviewdog/action-suggester@v1");
    assert.match(fix.if, /head\.repo\.full_name == github\.repository/);

    const docker = job(doc, "docker");
    assert.ok(stepNamed(docker, /hadolint/));
    assert.equal(stepNamed(docker, /^Build api\/Dockerfile/).with["cache-from"], "type=gha,scope=api");
    assert.match(stepNamed(job(doc, "secrets"), /gitleaks/).run, /gitleaks" git --log-opts/);
    const pr = job(doc, "pr-hygiene");
    assert.equal(stepNamed(pr, /^Branch name/)["continue-on-error"], true);
    assert.equal(stepNamed(pr, /^PR title/).env.PR_TITLE, "${{ github.event.pull_request.title }}");
  });

  it("strict preset: diff coverage, blocking security and failure notifications", () => {
    const { content } = renderProductCiForRepo(root, { gates: { preset: "strict" } });
    const doc = load(content);
    assertNoSecretsInIf(doc);
    const gate = stepNamed(job(doc, "app-api"), /^Coverage gate/);
    assert.match(gate.run, /--diff-base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" --diff-min 80 --diff-mode block/);
    assert.equal(job(doc, "app-api").steps[0].with["fetch-depth"], 0);
    assert.ok(!job(doc, "dependency-review")["continue-on-error"]);
    assert.ok(stepNamed(job(doc, "pr-hygiene"), /^PR size/));
    const notify = job(doc, "notify");
    assert.ok(notify.needs.includes("app-api") && notify.needs.includes("secrets"));
    assert.ok(!notify.needs.includes("changes"));
    assert.match(notify.if, /failure\(\) && github\.event_name != 'pull_request'/);
    assert.equal(stepNamed(notify, /^Send/).env.SLACK_WEBHOOK_URL, "${{ secrets.SLACK_WEBHOOK_URL }}");
  });

  it("matrix, retry, migrate, commit-mode style fix and GHCR publish", () => {
    const { content } = renderProductCiForRepo(root, {
      gates: {
        defaults: { coverage: { mode: "warn" } },
        apps: {
          api: { matrix: { versions: [20, 22] }, retry: 2, format: { fix: "commit" }, services: ["postgres"], migrate: "npx prisma migrate deploy" },
          svc: { matrix: { os: ["ubuntu-latest", "windows-latest"] }, services: ["redis"] },
        },
        docker: { build: "block", publish: { platforms: ["linux/amd64", "linux/arm64"] }, cache: true },
        merge_group: false,
        timeout_minutes: 20,
      },
    });
    const doc = load(content);
    assertNoSecretsInIf(doc);
    assert.ok(!("merge_group" in doc.on));
    assert.deepEqual(doc.on.push.tags, ["v*"]);

    const api = job(doc, "app-api");
    assert.deepEqual(api.strategy.matrix.version, ["20", "22"]);
    assert.equal(api["timeout-minutes"], 20);
    assert.equal(stepNamed(api, /^Setup Node/).with["node-version"], "${{ matrix.version }}");
    assert.equal(stepNamed(api, /^Test \+ coverage/).if, "${{ matrix.version == '20' }}");
    assert.equal(stepNamed(api, /^Test$/).if, "${{ !(matrix.version == '20') }}");
    assert.match(stepNamed(api, /^Test \+ coverage/).run, /until npm run test -- --coverage/);
    assert.ok(stepNamed(api, /^Apply migrations/));
    assert.equal(api.env.DATABASE_URL, "postgresql://postgres:postgres@localhost:5432/app_test");

    const svc = job(doc, "app-svc");
    assert.equal(svc["runs-on"], "${{ matrix.os }}");
    assert.equal(svc.services, undefined);
    assert.match(content, /# NOTE \(svc\): service containers need Linux runners/);

    const fix = job(doc, "style-fix-api");
    assert.equal(fix.permissions.contents, "write");
    assert.equal(fix.steps[0].with.ref, "${{ github.head_ref }}");
    assert.match(stepNamed(fix, /^Commit style fixes/).run, /\[hyperion-style-fix\]/);

    const pub = job(doc, "docker-publish");
    assert.equal(pub.permissions.packages, "write");
    assert.deepEqual(pub.needs, ["app-api", "app-svc", "docker"]);
    assert.match(pub.if, /refs\/heads\/main/);
    assert.match(pub.if, /refs\/tags\/v/);
    assert.ok(stepNamed(pub, /^Setup QEMU/));
    assert.equal(stepNamed(pub, /^Publish api\/Dockerfile/).with.platforms, "linux/amd64,linux/arm64");
  });
});

describe("web, mobile and docs jobs", () => {
  let webRoot;
  before(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-render-web-"));
    write(webRoot, "web/package.json", {
      scripts: { build: "vite build", test: "vitest", size: "size-limit" },
      devDependencies: { vite: "^5", vitest: "^2", "size-limit": "^11" },
      "size-limit": [{ path: "dist/*.js", limit: "100 kB" }],
    });
    write(webRoot, "web/package-lock.json", "{}");
    write(webRoot, "mobile/pubspec.yaml", "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n");
    write(webRoot, "mobile/lib/main.dart", "void main() {}");
    write(webRoot, "mobile/android/build.gradle", "plugins {}");
    write(webRoot, "mobile/ios/Runner/Info.plist", "<plist/>");
    write(webRoot, "README.md", "# Demo\n");
  });
  after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

  it("renders Lighthouse, axe, bundle size, Android/iOS builds and docs checks", () => {
    const { content } = renderProductCiForRepo(webRoot, {
      kitRootRel: "Hyperion",
      gates: {
        lighthouse: "warn",
        a11y: { mode: "block", urls: ["/", "/about"] },
        bundle_size: "block",
        mobile_build: { mode: "warn", ios: true },
        docs: { links: "block", markdown: "warn" },
      },
    });
    const doc = load(content);
    assertNoSecretsInIf(doc);
    const lh = job(doc, "lighthouse");
    assert.equal(lh["continue-on-error"], undefined);
    const lhStep = stepNamed(lh, /^Lighthouse CI/);
    assert.equal(lhStep["continue-on-error"], true);
    assert.match(lhStep.run, /"staticDistDir": "dist"/);
    assert.match(lhStep.run, /"categories:accessibility"/);
    const a11y = job(doc, "a11y");
    assert.match(stepNamed(a11y, /^Serve app/).run, /serve -s "dist" -l 4173/);
    assert.match(stepNamed(a11y, /^axe/).run, /"http:\/\/localhost:4173\/about"/);
    assert.match(stepNamed(job(doc, "bundle-size"), /^Bundle size/).run, /size-limit/);
    assert.match(stepNamed(job(doc, "mobile-android-mobile"), /^Build APK/).run, /flutter build apk --debug/);
    assert.equal(job(doc, "mobile-ios-mobile")["runs-on"], "macos-latest");
    const docs = job(doc, "docs");
    assert.match(stepNamed(docs, /^Links/).with.args, /--offline .*--exclude-path Hyperion/);
    assert.ok(stepNamed(docs, /^Default markdownlint config/));
    assert.match(stepNamed(docs, /^markdownlint/).with.globs, /!Hyperion\/\*\*/);
  });
});
