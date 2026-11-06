/**
 * `--ignore` glob matching shared by coverage-gate.mjs and diff-coverage.mjs.
 * Kept in its own module so diff-coverage.mjs never imports coverage-gate.mjs:
 * that cycle deadlocks the coverage-gate CLI (unsettled top-level await, exit 13).
 */

export function globToRegExp(pattern) {
  const p = String(pattern).trim().replace(/\\/g, "/");
  if (!/[*?]/.test(p)) return { test: (s) => s.includes(p) };
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (p[i + 1] === "/") i += 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(^|/)${re}$`);
}

export function makeIgnore(patterns) {
  const list = (patterns || []).flatMap((p) => String(p).split(",")).map((s) => s.trim()).filter(Boolean);
  const res = list.map(globToRegExp);
  return (file) => {
    const f = String(file || "").replace(/\\/g, "/");
    return res.some((r) => r.test(f));
  };
}
