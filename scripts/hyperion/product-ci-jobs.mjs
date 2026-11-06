/**
 * Job builders for the product CI: toolchain setup and the optional repo-level
 * jobs (affected-paths filter, style auto-fix, dependency review, secrets scan,
 * PR hygiene, Docker lint/cache/publish, Lighthouse, axe, bundle size, mobile
 * builds, docs checks, failure notifications).
 */
import { CHECKOUT, checkout, job, q, slug, step } from "./ci-yaml.mjs";
import { translator } from "./i18n.mjs";
import { gateCommand, SERVICE_CATALOG } from "./pipeline-gates.mjs";

export const WORKFLOW_PATH = ".github/workflows/hyperion-product-ci.yml";

/** Messages in the repo language (plan.i18n from project.yml; en when unset). Job/step names stay English. */
export const ciText = (plan) => translator(plan.i18n, { root: plan.i18nRoot || null });
const GITLEAKS_VERSION = "8.21.2";
const SAME_REPO_PR = "github.event.pull_request.head.repo.full_name == github.repository";

/** `version` overrides the detected toolchain (may be `${{ matrix.version }}`). */
export function setupSteps(app, { coverageOn = false, version = null } = {}) {
  const s = app.setup || {};
  const steps = [];
  switch (s.kind) {
    case "node": {
      if (s.pm === "bun") {
        steps.push(step({ name: "Setup Bun", uses: "oven-sh/setup-bun@v2" }));
        break;
      }
      const w = {};
      if (version) w["node-version"] = String(version);
      else if (s.nodeVersionFile) w["node-version-file"] = s.nodeVersionFile;
      else w["node-version"] = String(s.nodeVersion || "22");
      if (s.pm === "npm" && s.lockfile) {
        w.cache = "npm";
        w["cache-dependency-path"] = s.lockfile;
      }
      steps.push(step({ name: "Setup Node", uses: "actions/setup-node@v5", with: w }));
      if (s.pm === "pnpm" || s.pm === "yarn") steps.push(step({ name: "Enable corepack", run: "corepack enable" }));
      break;
    }
    case "python": {
      const w = version
        ? { "python-version": String(version) }
        : s.pythonVersionFile
          ? { "python-version-file": s.pythonVersionFile }
          : { "python-version": s.pythonVersion || "3.12" };
      steps.push(step({ name: "Setup Python", uses: "actions/setup-python@v5", with: w }));
      if (s.pm === "uv") steps.push(step({ name: "Install uv", run: "pip install uv" }));
      if (s.pm === "poetry") steps.push(step({ name: "Install Poetry", run: "pipx install poetry" }));
      if (s.pm === "pipenv") steps.push(step({ name: "Install Pipenv", run: "pip install pipenv" }));
      break;
    }
    case "go":
      steps.push(
        step({
          name: "Setup Go",
          uses: "actions/setup-go@v5",
          with: version ? { "go-version": String(version) } : { "go-version-file": s.goVersionFile || "go.mod" },
        })
      );
      break;
    case "rust":
      if (version) steps.push(step({ name: `Rust ${version}`, run: `rustup toolchain install ${version} --profile minimal\nrustup default ${version}` }));
      steps.push(step({ name: "Rust components", run: "rustup component add clippy rustfmt" }));
      if (coverageOn) {
        steps.push(step({ name: "Install cargo-llvm-cov", run: "rustup component add llvm-tools-preview\ncargo install cargo-llvm-cov --locked" }));
      }
      break;
    case "flutter": {
      const v = version || s.version;
      steps.push(
        step({
          name: "Setup Flutter",
          uses: "subosito/flutter-action@v2",
          with: v ? { channel: "stable", "flutter-version": String(v), cache: true } : { channel: "stable", cache: true },
        })
      );
      break;
    }
    case "dart":
      steps.push(step({ name: "Setup Dart", uses: "dart-lang/setup-dart@v1", ...(version ? { with: { sdk: String(version) } } : {}) }));
      break;
    case "dotnet":
      steps.push(step({ name: "Setup .NET", uses: "actions/setup-dotnet@v4", with: { "dotnet-version": String(version || s.version || "8.0.x") } }));
      break;
    case "java":
      steps.push(
        step({
          name: "Setup Java",
          uses: "actions/setup-java@v4",
          with: { distribution: "temurin", "java-version": String(version || s.version || "21"), cache: s.build === "gradle" ? "gradle" : "maven" },
        })
      );
      break;
    case "php":
      steps.push(
        step({
          name: "Setup PHP",
          uses: "shivammathur/setup-php@v2",
          with: { "php-version": String(version || s.version || "8.3"), coverage: coverageOn ? "pcov" : "none", tools: "composer" },
        })
      );
      break;
    case "ruby": {
      const w = { "bundler-cache": true, "working-directory": app.path === "." ? "." : app.path };
      if (version || s.version) w["ruby-version"] = String(version || s.version);
      steps.push(step({ name: "Setup Ruby", uses: "ruby/setup-ruby@v1", with: w }));
      break;
    }
    default:
      break;
  }
  return steps;
}

export function installSteps(app, plannedTools = []) {
  const steps = [];
  const install = app.commands?.install || app.install;
  if (install && app.setup?.kind !== "ruby") steps.push(step({ name: "Install dependencies", run: install }));
  if (plannedTools.length) steps.push(step({ name: "Install CI tools", run: `pip install ${plannedTools.join(" ")}` }));
  return steps;
}

const outputKey = (name) => slug(name).replace(/-/g, "_");

/** needs/if so an app job only runs on PRs that touch it (pushes and merge queue run everything). */
export function affectedGate(app, plan) {
  if (!plan.affected.enabled || plan.apps.length < 2) return {};
  return {
    needs: ["changes"],
    if: `\${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.${outputKey(app.name)} == 'true') }}`,
  };
}

export function changesJob(plan) {
  if (!plan.affected.enabled || plan.apps.length < 2) return null;
  const shared = [WORKFLOW_PATH, ...plan.affected.paths];
  const filters = [];
  const outputs = {};
  for (const app of plan.apps) {
    const key = outputKey(app.name);
    const own = app.path === "." ? ["**"] : [`${app.path}/**`];
    filters.push(`${key}:`, ...[...own, ...app.decisions.affectedPaths, ...shared].map((p) => `  - '${p}'`));
    outputs[key] = `\${{ steps.filter.outputs.${key} }}`;
  }
  return job({
    id: "changes",
    name: "Detect changed apps",
    if: "${{ github.event_name == 'pull_request' }}",
    runsOn: plan.runner,
    timeout: 5,
    permissions: { contents: "read", "pull-requests": "read" },
    outputs,
    steps: [step({ name: "Paths filter", id: "filter", uses: "dorny/paths-filter@v3", with: { filters: filters.join("\n") } })],
  });
}

/** Lint/format auto-fix on PRs: `suggest` posts review suggestions, `commit` pushes the fix. */
export function styleFixJob(app, plan) {
  const d = app.decisions;
  const fixes = ["lint", "format"]
    .filter((g) => d.fix[g] !== "off" && d[g] !== "off")
    .map((g) => ({ gate: g, mode: d.fix[g], cmd: app.commands?.[`${g}_fix`] || app.gates?.[g]?.fix || null }))
    .filter((f) => f.cmd);
  if (!fixes.length) return null;
  const commit = fixes.filter((f) => f.mode === "commit");
  const suggest = fixes.filter((f) => f.mode === "suggest");
  const steps = [
    commit.length
      ? checkout({ ref: "${{ github.head_ref }}", token: "${{ secrets.HYPERION_PR_TOKEN || github.token }}" })
      : checkout({ ref: "${{ github.event.pull_request.head.sha }}" }),
    ...setupSteps(app, { version: d.version }),
    ...installSteps(app, app.setup?.kind === "python" ? [...(app.setup.tools || [])] : []),
  ];
  for (const f of commit) steps.push(step({ name: `Apply ${f.gate} fix`, run: f.cmd, continueOnError: true }));
  if (commit.length) {
    steps.push(
      step({
        name: "Commit style fixes",
        run: [
          'cd "$GITHUB_WORKSPACE"',
          'if git diff --quiet; then echo "Nothing to fix."; exit 0; fi',
          'git config user.name "github-actions[bot]"',
          'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
          `git commit -am "style: auto-fix (${app.name}) [hyperion-style-fix]"`,
          "git push",
        ].join("\n"),
      })
    );
  }
  for (const f of suggest) steps.push(step({ name: `Apply ${f.gate} fix (suggest)`, run: f.cmd, continueOnError: true }));
  if (suggest.length) {
    steps.push(
      step({
        name: "Post suggestions",
        uses: "reviewdog/action-suggester@v1",
        with: { tool_name: `hyperion-style-fix (${app.name})`, fail_on_error: false },
      })
    );
  }
  const gate = affectedGate(app, plan);
  const prIf = `github.event_name == 'pull_request' && ${SAME_REPO_PR}`;
  return job({
    id: `style-fix-${slug(app.name)}`,
    name: `${app.name} — style auto-fix (${[...new Set(fixes.map((f) => f.mode))].join("+")})`,
    needs: gate.needs,
    if: gate.needs
      ? `\${{ !cancelled() && ${prIf} && needs.changes.outputs.${outputKey(app.name)} == 'true' }}`
      : `\${{ ${prIf} }}`,
    runsOn: d.runner || plan.runner,
    timeout: 15,
    continueOnError: true,
    permissions: { contents: commit.length ? "write" : "read", ...(suggest.length ? { "pull-requests": "write" } : {}) },
    workingDirectory: app.path,
    steps,
  });
}

export function dependencyReviewJob(plan) {
  const { mode, severity } = plan.dependencyReview;
  if (mode === "off") return null;
  return job({
    id: "dependency-review",
    name: "Dependency review",
    if: "${{ github.event_name == 'pull_request' }}",
    runsOn: plan.runner,
    timeout: 10,
    continueOnError: mode === "warn",
    permissions: { contents: "read" },
    steps: [CHECKOUT, step({ name: "Review new dependencies", uses: "actions/dependency-review-action@v4", with: { "fail-on-severity": severity } })],
  });
}

export function secretsJob(plan) {
  if (plan.secretsScan === "off") return null;
  return job({
    id: "secrets",
    name: "Secrets scan (gitleaks)",
    runsOn: plan.runner,
    timeout: 10,
    continueOnError: plan.secretsScan === "warn",
    steps: [
      checkout({ "fetch-depth": 0 }),
      step({
        name: "gitleaks",
        env: {
          GITLEAKS_VERSION: q(GITLEAKS_VERSION),
          BASE: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}",
        },
        run: [
          'curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar -xz -C "$RUNNER_TEMP" gitleaks',
          'if [ -n "$BASE" ] && [ "$BASE" != "0000000000000000000000000000000000000000" ] && git cat-file -e "${BASE}^{commit}" 2>/dev/null; then',
          '  range="${BASE}..HEAD"',
          "else",
          '  range="--max-count=1"',
          "fi",
          '"$RUNNER_TEMP/gitleaks" git --log-opts="$range" --redact --verbose --exit-code 1 .',
        ].join("\n"),
      }),
    ],
  });
}

export function prHygieneJob(plan) {
  const { branchName, title, cardLink, size } = plan.prChecks;
  if ([branchName, title, cardLink, size].every((c) => c.mode === "off")) return null;
  const tr = ciText(plan);
  const env = {
    PR_TITLE: "${{ github.event.pull_request.title }}",
    PR_BRANCH: "${{ github.head_ref }}",
    PR_BODY: "${{ github.event.pull_request.body }}",
  };
  const steps = [];
  if (branchName.mode !== "off") {
    steps.push(
      step({
        name: "Branch name",
        mode: branchName.mode,
        env: { PR_BRANCH: env.PR_BRANCH, PATTERN: q(branchName.pattern) },
        run: [
          'case "$PR_BRANCH" in dependabot/*|renovate/*) exit 0 ;; esac',
          'if [[ ! "$PR_BRANCH" =~ $PATTERN ]]; then',
          `  echo "::error title=Branch name::${tr.shell("ci.branchName.error", { branch: "$PR_BRANCH", pattern: "$PATTERN" })}"`,
          "  exit 1",
          "fi",
        ].join("\n"),
      })
    );
  }
  if (title.mode !== "off") {
    steps.push(
      step({
        name: "PR title (Conventional Commits)",
        mode: title.mode,
        env: { PR_TITLE: env.PR_TITLE, PATTERN: q(title.pattern) },
        run: [
          'if [[ ! "$PR_TITLE" =~ $PATTERN ]]; then',
          `  echo "::error title=PR title::${tr.shell("ci.prTitle.error", { title: "$PR_TITLE", pattern: "$PATTERN" })}"`,
          "  exit 1",
          "fi",
        ].join("\n"),
      })
    );
  }
  if (cardLink.mode !== "off") {
    steps.push(
      step({
        name: "Card link (CARD_ID)",
        mode: cardLink.mode,
        env: { ...env, PATTERN: q(cardLink.pattern) },
        run: [
          'if ! printf \'%s\\n%s\\n%s\\n\' "$PR_BRANCH" "$PR_TITLE" "$PR_BODY" | grep -Eq "$PATTERN"; then',
          `  echo "::error title=Card link::${tr.shell("ci.cardLink.error", { pattern: "$PATTERN" })}"`,
          "  exit 1",
          "fi",
        ].join("\n"),
      })
    );
  }
  if (size.mode !== "off") {
    steps.push(
      step({
        name: `PR size (<= ${size.max} lines)`,
        mode: size.mode,
        env: { ADDED: "${{ github.event.pull_request.additions }}", REMOVED: "${{ github.event.pull_request.deletions }}", MAX: String(size.max) },
        run: [
          "total=$((ADDED + REMOVED))",
          `echo "${tr.shell("ci.prSize.info", { total: "$total", max: "$MAX" })}"`,
          'if [ "$total" -gt "$MAX" ]; then',
          `  echo "::error title=PR size::${tr.shell("ci.prSize.error", { total: "$total", max: "$MAX" })}"`,
          "  exit 1",
          "fi",
        ].join("\n"),
      })
    );
  }
  return job({
    id: "pr-hygiene",
    name: "PR hygiene",
    if: "${{ github.event_name == 'pull_request' && github.event.pull_request.user.type != 'Bot' }}",
    runsOn: plan.runner,
    timeout: 5,
    steps,
  });
}

function dockerTargets(plan, repo) {
  return repo.dockerfiles.filter((d) => !plan.docker.files || plan.docker.files.includes(d.path));
}

const imageSlug = (t) => slug(t.path.replace(/\/?(Dockerfile|Containerfile).*$/i, "") || "root");

export function dockerJob(plan, repo) {
  const { build, scan, severity, lint, cache } = plan.docker;
  if (build === "off" && scan === "off" && lint === "off") return null;
  const targets = dockerTargets(plan, repo);
  if (!targets.length) return null;
  const steps = [CHECKOUT];
  if (lint !== "off") {
    for (const t of targets) {
      steps.push(
        step({
          name: `Lint ${t.path} (hadolint)`,
          mode: lint,
          run: `docker run --rm -v "$PWD:/repo" -w /repo hadolint/hadolint hadolint ${q(t.path)}`,
        })
      );
    }
  }
  if (cache && (build !== "off" || scan !== "off")) steps.push(step({ name: "Setup Buildx", uses: "docker/setup-buildx-action@v3" }));
  for (const t of targets) {
    if (build === "off" && scan === "off") break;
    const tag = `hyperion-ci/${imageSlug(t)}:\${{ github.sha }}`;
    if (cache) {
      steps.push(
        step({
          name: `Build ${t.path}`,
          mode: build === "off" ? "warn" : build,
          uses: "docker/build-push-action@v6",
          with: {
            context: t.context,
            file: t.path,
            push: false,
            load: scan !== "off",
            tags: tag,
            "cache-from": `type=gha,scope=${imageSlug(t)}`,
            "cache-to": `type=gha,mode=max,scope=${imageSlug(t)}`,
          },
        })
      );
    } else {
      steps.push(
        step({
          name: `Build ${t.path}`,
          run: `docker build -f ${q(t.path)} -t ${q(tag)} ${q(t.context)}`,
          mode: build === "off" ? "warn" : build,
        })
      );
    }
    if (scan !== "off") {
      steps.push(
        step({
          name: `Scan ${t.path} (Trivy ${severity})`,
          run: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --exit-code 1 --ignore-unfixed --severity ${severity} ${q(tag)}`,
          mode: scan,
        })
      );
    }
  }
  return job({ id: "docker", name: "Docker images", runsOn: plan.runner, timeout: 30, steps });
}

/** Push to GHCR on the publish branches and v* tags, after every gate passed. */
export function dockerPublishJob(plan, repo, { needs = [], branches = [] } = {}) {
  const pub = plan.docker.publish;
  if (!pub) return null;
  const targets = dockerTargets(plan, repo);
  if (!targets.length) return null;
  const refs = (pub.branches || branches).map((b) => `github.ref == 'refs/heads/${b}'`);
  if (pub.tags) refs.push("startsWith(github.ref, 'refs/tags/v')");
  const single = targets.length === 1;
  const steps = [CHECKOUT];
  if (pub.platforms.some((p) => p !== "linux/amd64")) steps.push(step({ name: "Setup QEMU", uses: "docker/setup-qemu-action@v3" }));
  steps.push(
    step({ name: "Setup Buildx", uses: "docker/setup-buildx-action@v3" }),
    step({
      name: "Login to GHCR",
      uses: "docker/login-action@v3",
      with: { registry: "ghcr.io", username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" },
    })
  );
  for (const t of targets) {
    const id = imageSlug(t);
    steps.push(
      step({
        name: `Image name (${t.path})`,
        id: `img-${id}`,
        run: `echo "name=ghcr.io/\${GITHUB_REPOSITORY,,}${single ? "" : `-${id}`}" >> "$GITHUB_OUTPUT"`,
      }),
      step({
        name: `Metadata (${t.path})`,
        id: `meta-${id}`,
        uses: "docker/metadata-action@v5",
        with: {
          images: `\${{ steps.img-${id}.outputs.name }}`,
          tags: ["type=ref,event=branch", ...(pub.tags ? ["type=semver,pattern={{version}}", "type=semver,pattern={{major}}.{{minor}}"] : []), "type=sha"].join("\n"),
        },
      }),
      step({
        name: `Publish ${t.path}`,
        uses: "docker/build-push-action@v6",
        with: {
          context: t.context,
          file: t.path,
          push: true,
          platforms: pub.platforms.join(","),
          tags: `\${{ steps.meta-${id}.outputs.tags }}`,
          labels: `\${{ steps.meta-${id}.outputs.labels }}`,
          ...(plan.docker.cache ? { "cache-from": `type=gha,scope=${id}`, "cache-to": `type=gha,mode=max,scope=${id}` } : {}),
        },
      })
    );
  }
  return job({
    id: "docker-publish",
    name: "Publish images (GHCR)",
    needs,
    if: `\${{ github.event_name == 'push' && (${refs.join(" || ") || "false"}) }}`,
    runsOn: plan.runner,
    timeout: 45,
    permissions: { contents: "read", packages: "write" },
    steps,
  });
}

function webSteps(app) {
  const steps = [CHECKOUT, ...setupSteps(app, { version: app.decisions.version }), ...installSteps(app)];
  const build = gateCommand(app, "build");
  if (build) steps.push(step({ name: "Build", run: build }));
  return steps;
}

function serveStep(gate) {
  const base = gate.start ? gate.url || "http://localhost:3000" : "http://localhost:4173";
  const start = gate.start ? `${gate.start} &` : `npx --yes serve -s ${q(gate.dist || "dist")} -l 4173 &`;
  return { base, step: step({ name: "Serve app", run: `${start}\nnpx --yes wait-on --timeout 120000 ${q(base)}` }) };
}

export function lighthouseJob(plan, apps) {
  const g = plan.lighthouse;
  if (g.mode === "off") return null;
  const app = apps.find((a) => a.name === g.app);
  if (!app) return null;
  const level = "error";
  const assertions = Object.fromEntries(Object.entries(g.min).map(([cat, min]) => [`categories:${cat}`, [level, { minScore: Number(min) }]]));
  const collect = g.start
    ? { startServerCommand: g.start, url: g.urls.map((u) => new URL(u, g.url || "http://localhost:3000").href), numberOfRuns: 1 }
    : { staticDistDir: g.dist || "dist", numberOfRuns: 1 };
  const rc = { ci: { collect, assert: { assertions }, upload: { target: "filesystem", outputDir: ".lighthouseci" } } };
  const prefix = app.path === "." ? "" : `${app.path}/`;
  const steps = [
    ...webSteps(app),
    step({
      name: "Lighthouse CI",
      mode: g.mode,
      run: [`cat > "$RUNNER_TEMP/lighthouserc.json" <<'JSON'`, JSON.stringify(rc, null, 2), "JSON", 'npx --yes @lhci/cli@0.14 autorun --config="$RUNNER_TEMP/lighthouserc.json"'].join("\n"),
    }),
    step({
      name: "Upload Lighthouse report",
      if: "${{ !cancelled() }}",
      uses: "actions/upload-artifact@v4",
      with: { name: `lighthouse-${slug(app.name)}`, path: `${prefix}.lighthouseci/`, "if-no-files-found": "ignore", "retention-days": 7 },
    }),
  ];
  return job({ id: "lighthouse", name: `Lighthouse (${app.name})`, ...affectedGate(app, plan), runsOn: plan.runner, timeout: 20, workingDirectory: app.path, steps });
}

export function a11yJob(plan, apps) {
  const g = plan.a11y;
  if (g.mode === "off") return null;
  const app = apps.find((a) => a.name === g.app);
  if (!app) return null;
  const serve = serveStep(g);
  const urls = g.urls.map((u) => q(new URL(u, serve.base).href)).join(" ");
  const steps = [
    ...webSteps(app),
    serve.step,
    step({
      name: "axe accessibility",
      mode: g.mode,
      run: `npx --yes @axe-core/cli ${urls} --exit --chromedriver-path "$CHROMEWEBDRIVER/chromedriver"`,
    }),
  ];
  return job({ id: "a11y", name: `Accessibility (${app.name})`, ...affectedGate(app, plan), runsOn: plan.runner, timeout: 20, workingDirectory: app.path, steps });
}

export function bundleSizeJob(plan, apps) {
  const g = plan.bundleSize;
  if (g.mode === "off") return null;
  const app = apps.find((a) => a.name === g.app);
  const cmd = app?.commands?.bundle_size || app?.bundleSize?.command;
  if (!app || !cmd) return null;
  return job({
    id: "bundle-size",
    name: `Bundle size (${app.name})`,
    ...affectedGate(app, plan),
    runsOn: plan.runner,
    timeout: 15,
    workingDirectory: app.path,
    steps: [...webSteps(app), step({ name: "Bundle size budget", mode: g.mode, run: cmd })],
  });
}

export function mobileJobs(plan, apps) {
  const g = plan.mobileBuild;
  if (g.mode === "off") return [];
  const app = apps.find((a) => a.name === g.app);
  if (!app?.mobile) return [];
  const prefix = app.path === "." ? "" : `${app.path}/`;
  const gate = affectedGate(app, plan);
  const jobs = [];
  if (g.android) {
    const flutter = app.mobile.kind === "flutter";
    const steps = flutter
      ? [
          CHECKOUT,
          step({ name: "Setup Java", uses: "actions/setup-java@v4", with: { distribution: "temurin", "java-version": "17" } }),
          ...setupSteps(app, { version: app.decisions.version }),
          step({ name: "Pub get", run: "flutter pub get" }),
          step({ name: "Build APK (debug)", mode: g.mode, run: "flutter build apk --debug" }),
        ]
      : [
          CHECKOUT,
          ...setupSteps(app, { version: app.decisions.version }),
          step({ name: "Build APK (debug)", mode: g.mode, run: `${app.mobile.gradle === "./gradlew" ? "chmod +x gradlew\n" : ""}${app.mobile.gradle || "gradle"} assembleDebug` }),
        ];
    steps.push(
      step({
        name: "Upload APK",
        if: "${{ success() }}",
        uses: "actions/upload-artifact@v4",
        with: {
          name: `apk-${slug(app.name)}`,
          path: flutter ? `${prefix}build/app/outputs/flutter-apk/app-debug.apk` : `${prefix}**/build/outputs/apk/debug/*.apk`,
          "if-no-files-found": "warn",
          "retention-days": 7,
        },
      })
    );
    jobs.push(job({ id: `mobile-android-${slug(app.name)}`, name: `Android build (${app.name})`, ...gate, runsOn: "ubuntu-latest", timeout: 40, workingDirectory: app.path, steps }));
  }
  if (g.ios && app.mobile.kind === "flutter") {
    jobs.push(
      job({
        id: `mobile-ios-${slug(app.name)}`,
        name: `iOS build (${app.name}, no codesign)`,
        ...gate,
        runsOn: "macos-latest",
        timeout: 60,
        workingDirectory: app.path,
        steps: [
          CHECKOUT,
          ...setupSteps(app, { version: app.decisions.version }),
          step({ name: "Pub get", run: "flutter pub get" }),
          step({ name: "Build iOS (no codesign)", mode: g.mode, run: "flutter build ios --debug --no-codesign" }),
        ],
      })
    );
  }
  return jobs;
}

export function docsJob(plan, repo, { kitRootRel = "" } = {}) {
  const { links, external, markdown } = plan.docs;
  if (links === "off" && markdown === "off") return null;
  if (!repo.docs?.markdownFiles) return null;
  const kit = String(kitRootRel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const steps = [CHECKOUT];
  if (links !== "off") {
    const args = ["--no-progress", ...(external ? [] : ["--offline"]), "--exclude-path node_modules", ...(kit ? [`--exclude-path ${kit}`] : []), "'./**/*.md'"];
    steps.push(step({ name: `Links (lychee${external ? "" : ", offline"})`, mode: links, uses: "lycheeverse/lychee-action@v2", with: { args: args.join(" "), fail: true } }));
  }
  if (markdown !== "off") {
    if (!repo.docs.markdownlint) {
      steps.push(
        step({
          name: "Default markdownlint config",
          run: `echo '{"config":{"default":true,"MD013":false,"MD033":false,"MD041":false}}' > .markdownlint-cli2.jsonc`,
        })
      );
    }
    steps.push(
      step({
        name: "markdownlint",
        mode: markdown,
        uses: "DavidAnson/markdownlint-cli2-action@v19",
        with: { globs: ["**/*.md", "!**/node_modules/**", ...(kit ? [`!${kit}/**`] : [])].join("\n") },
      })
    );
  }
  return job({ id: "docs", name: "Docs checks", runsOn: plan.runner, timeout: 10, steps });
}

/** Slack/Discord webhook on push failures (or every run). Skipped when the secret is unset. */
export function notifyJob(plan, needs) {
  const n = plan.notify;
  if (n.on === "off" || (!n.slack && !n.discord) || !needs.length) return null;
  const when = n.on === "always" ? "always()" : "failure()";
  const tr = ciText(plan);
  const exprStr = (s) => `'${s.replace(/'/g, "''")}'`;
  const env = { STATUS: `\${{ contains(needs.*.result, 'failure') && ${exprStr(tr.t("ci.notify.failed"))} || ${exprStr(tr.t("ci.notify.passed"))} }}` };
  const msg = tr.shell("ci.notify.message", {
    status: "${STATUS}",
    repo: "${GITHUB_REPOSITORY}",
    ref: "${GITHUB_REF_NAME}",
    sha: "${GITHUB_SHA::7}",
    url: "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}",
  });
  const lines = [`msg="${msg}"`];
  if (n.slack) {
    env.SLACK_WEBHOOK_URL = "${{ secrets.SLACK_WEBHOOK_URL }}";
    lines.push('if [ -n "$SLACK_WEBHOOK_URL" ]; then curl -sS -X POST -H "Content-Type: application/json" --data "$(jq -n --arg t "$msg" \'{text:$t}\')" "$SLACK_WEBHOOK_URL"; fi');
  }
  if (n.discord) {
    env.DISCORD_WEBHOOK_URL = "${{ secrets.DISCORD_WEBHOOK_URL }}";
    lines.push('if [ -n "$DISCORD_WEBHOOK_URL" ]; then curl -sS -X POST -H "Content-Type: application/json" --data "$(jq -n --arg t "$msg" \'{content:$t}\')" "$DISCORD_WEBHOOK_URL"; fi');
  }
  return job({
    id: "notify",
    name: "Notify",
    needs,
    if: `\${{ ${when} && github.event_name != 'pull_request' }}`,
    runsOn: "ubuntu-latest",
    timeout: 5,
    steps: [step({ name: "Send notification", env, run: lines.join("\n") })],
  });
}

/** Service containers + connection env for an app job (Linux runners only). */
export function servicesFor(app) {
  const services = {};
  const env = {};
  for (const s of app.resolvedServices || []) {
    const c = SERVICE_CATALOG[s.kind];
    services[s.kind] = { image: s.image, env: c.env, ports: c.ports, options: c.options };
    for (const [k, v] of Object.entries(c.jobEnv)) env[k] = q(v);
  }
  return { services, env };
}
