import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ciError,
  ciErrorList,
  ciFail,
  ciFailList,
  formatAnnotation,
  MAX_FILE_ANNOTATIONS,
  repoRelative,
  splitFileMessage,
} from "./ci-annotate.mjs";

const actions = { GITHUB_ACTIONS: "true" };

function capture(fn) {
  const out = [];
  fn((s) => out.push(s));
  return out;
}

test("formatAnnotation escapes data and properties the way the runner expects", () => {
  assert.equal(
    formatAnnotation("50%\nnext line", { title: "Cards: sync, forward", file: "a\\b.md", line: 3 }),
    "::error title=Cards%3A sync%2C forward,file=a/b.md,line=3::50%25%0Anext line"
  );
  assert.equal(formatAnnotation("plain"), "::error::plain");
  assert.equal(formatAnnotation("w", { level: "warning" }), "::warning::w");
});

test("annotation files are relative to the checkout", () => {
  const workspace = join(tmpdir(), "repo");
  const env = { ...actions, GITHUB_WORKSPACE: workspace };
  assert.equal(repoRelative(join(workspace, ".github", "project.yml"), env), ".github/project.yml");
  assert.equal(repoRelative("./docs/a.md", env), "docs/a.md");
  assert.equal(repoRelative(undefined, env), undefined);
  const out = capture((write) => ciError("m", { file: join(workspace, "x", "y.md") }, { env, write }));
  assert.equal(out[0], "::error file=x/y.md::m");
});

test("ciError only writes inside GitHub Actions", () => {
  assert.deepEqual(capture((write) => ciError("x", {}, { env: {}, write })), []);
  assert.deepEqual(capture((write) => ciError("x", { title: "T" }, { env: actions, write })), ["::error title=T::x"]);
});

test("ciFail uses the repo language and the <key>Title catalog entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-annotate-"));
  try {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "project.yml"), "locale: pt-BR\n");
    const out = capture((write) => ciFail(dir, "cards.fail.items", { count: 2, ids: "S-1, S-2" }, {}, { env: actions, write }));
    assert.equal(out.length, 1);
    assert.match(out[0], /^::error title=Alguns cards não foram sincronizados::2 card\(s\) falharam ao criar\/atualizar no board: S-1, S-2\./);

    const custom = capture((write) => ciFail(dir, "cards.fail.unexpected", { script: "ci-sync" }, { message: "boom" }, { env: actions, write }));
    assert.equal(custom[0], "::error title=ci-sync falhou::boom");
    assert.deepEqual(capture((write) => ciFail(dir, "cards.fail.items", {}, {}, { env: {}, write })), []);

    const crash = capture((write) => ciFail(dir, "cards.fail.unexpected", { script: "ci-sync", error: "fetch failed" }, {}, { env: actions, write }));
    assert.match(crash[0], /::ci-sync parou com: fetch failed\. .*token/);

    const headSha = capture((write) => ciFail(dir, "cards.fail.headSha", { script: "report-pr-guard-check" }, {}, { env: actions, write }));
    assert.match(headSha[0], /--head-sha <sha>/);

    const many = Array.from({ length: MAX_FILE_ANNOTATIONS + 2 }, (_, i) => `f${i}.md: ruim`);
    const list = capture((write) => ciFailList(dir, "cards.fail.validate", many, {}, { env: actions, write }));
    assert.match(list.at(-1), /\(mais 2 no log\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitFileMessage pins path-prefixed problems to their file", () => {
  assert.deepEqual(splitFileMessage(".github/cards/stories/S-1.md: card_id is required (string)."), {
    file: ".github/cards/stories/S-1.md",
    line: undefined,
    message: "card_id is required (string).",
  });
  assert.equal(splitFileMessage("docs/a.md:12: bad").line, 12);
  assert.deepEqual(splitFileMessage('Duplicate skill name "x": a and b'), { message: 'Duplicate skill name "x": a and b' });
});

test("ciErrorList caps per-file annotations and always ends with the fix", () => {
  const problems = Array.from({ length: MAX_FILE_ANNOTATIONS + 3 }, (_, i) => `f${i}.md: bad`);
  const out = capture((write) => ciErrorList("Docs", problems, "Fix and run npm run docs:check", { env: actions, write }));
  assert.equal(out.length, MAX_FILE_ANNOTATIONS + 1);
  assert.match(out[0], /^::error title=Docs,file=f0\.md::bad$/);
  assert.match(out.at(-1), /Fix and run npm run docs:check \(3 more in the log\)$/);

  const objects = capture((write) => ciErrorList("T", [{ file: "x.md", message: "m" }], "s", { env: actions, write }));
  assert.equal(objects[0], "::error title=T,file=x.md::m");
});
