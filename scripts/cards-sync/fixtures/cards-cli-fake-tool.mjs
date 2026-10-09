/**
 * Test support: stand-in for the `gh`, `git` and `npm` binaries that the cards
 * CLIs shell out to. cards-cli-harness.mjs puts tiny `gh`/`git`/`npm` wrappers
 * (that exec this file with the tool name as first arg) first on PATH, so the
 * scripts under test never reach the real tools, the network or your session.
 *
 * Behavior is driven by env vars (all optional — unset means "fail"):
 *   FAKE_GH_TOKEN        `gh auth token` output
 *   FAKE_GH_LABELS       JSON array of names for `gh label list`
 *   FAKE_GH_FAIL_NAMES   comma list of label names whose delete/edit/create fails
 *   FAKE_GIT_ORIGIN      `git remote get-url origin` output
 *   FAKE_GIT_HOOKS       `git rev-parse --git-path hooks` output
 *   FAKE_NPM_MODIFIED    JSON { pkg: isoDate } for `npm view <pkg> time.modified`
 *   FAKE_TOOL_LOG        file that gets one JSON line per invocation
 */
import { appendFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) appendFileSync(process.env.FAKE_TOOL_LOG, `${JSON.stringify({ tool, args })}\n`);

function out(text) {
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gh() {
  if (args[0] === "auth" && args[1] === "token") {
    if (process.env.FAKE_GH_TOKEN) out(process.env.FAKE_GH_TOKEN);
    fail("gh: not logged in");
  }
  if (args[0] === "label" && args[1] === "list") {
    if (!process.env.FAKE_GH_LABELS) fail("gh: label list failed");
    out(JSON.stringify(JSON.parse(process.env.FAKE_GH_LABELS).map((name) => ({ name }))));
  }
  if (args[0] === "label") {
    const failing = (process.env.FAKE_GH_FAIL_NAMES || "").split(",").filter(Boolean);
    if (failing.includes(args[2])) fail(`gh: cannot ${args[1]} ${args[2]}`);
    out("");
  }
}

function git() {
  if (args.join(" ") === "remote get-url origin") {
    if (process.env.FAKE_GIT_ORIGIN) out(process.env.FAKE_GIT_ORIGIN);
    fail("fatal: not a git repository");
  }
  if (args.join(" ") === "rev-parse --git-path hooks") {
    if (process.env.FAKE_GIT_HOOKS) out(process.env.FAKE_GIT_HOOKS);
    fail("fatal: not a git repository");
  }
}

function npm() {
  if (args[0] === "view" && args[2] === "time.modified") {
    const modified = JSON.parse(process.env.FAKE_NPM_MODIFIED || "{}")[args[1]];
    if (modified) out(modified);
    fail("npm ERR! 404");
  }
}

({ gh, git, npm })[tool]?.();
fail(`fake ${tool}: unsupported invocation: ${args.join(" ")}`);
