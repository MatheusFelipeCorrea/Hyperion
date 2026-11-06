/**
 * Tiny GitHub Actions YAML emitters shared by the product CI renderer and its
 * repo-level jobs. Output is plain strings (no YAML dependency at render time).
 */

export function slug(s) {
  return String(s || "x")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";
}

export function q(s) {
  return JSON.stringify(String(s));
}

function scalar(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return q(v);
}

export function runBlock(cmd, indent) {
  const pad = " ".repeat(indent);
  const lines = String(cmd).split("\n");
  return [`${pad}run: |`, ...lines.map((l) => `${pad}  ${l}`)].join("\n");
}

/**
 * @param {{ name: string, id?: string, run?: string, uses?: string, with?: Record<string,string|boolean|number>, mode?: string, if?: string, workingDirectory?: string, env?: Record<string,string>, continueOnError?: boolean, shell?: string }} s
 */
export function step(s) {
  const out = [`      - name: ${s.name}${s.mode === "warn" ? " (warn)" : ""}`];
  if (s.id) out.push(`        id: ${s.id}`);
  if (s.if) out.push(`        if: ${s.if}`);
  if (s.mode === "warn" || s.continueOnError) out.push("        continue-on-error: true");
  if (s.workingDirectory) out.push(`        working-directory: ${s.workingDirectory}`);
  if (s.shell) out.push(`        shell: ${s.shell}`);
  if (s.env && Object.keys(s.env).length) {
    out.push("        env:");
    for (const [k, v] of Object.entries(s.env)) out.push(`          ${k}: ${v}`);
  }
  if (s.uses) {
    out.push(`        uses: ${s.uses}`);
    if (s.with && Object.keys(s.with).length) {
      out.push("        with:");
      for (const [k, v] of Object.entries(s.with)) {
        if (typeof v === "string" && v.includes("\n")) {
          out.push(`          ${k}: |`, ...v.split("\n").map((l) => `            ${l}`));
        } else {
          out.push(`          ${k}: ${scalar(v)}`);
        }
      }
    }
  }
  if (s.run) out.push(runBlock(s.run, 8));
  return out.join("\n");
}

export function checkout(withOpts = null) {
  return step({ name: "Checkout", uses: "actions/checkout@v5", ...(withOpts ? { with: withOpts } : {}) });
}

export const CHECKOUT = checkout();

export function kitScript(kitRootRel, rel) {
  const kit = String(kitRootRel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `"$GITHUB_WORKSPACE/${kit ? `${kit}/` : ""}${rel}"`;
}

function yamlList(items) {
  return `[${items.map((i) => (typeof i === "number" ? i : q(i))).join(", ")}]`;
}

/**
 * Render one job. `steps` are already-rendered step strings.
 * @param {{ id: string, name?: string, runsOn?: string, timeout?: number, if?: string, needs?: string[],
 *   permissions?: Record<string,string>, continueOnError?: boolean, workingDirectory?: string,
 *   matrix?: Record<string, (string|number)[]>, failFast?: boolean, services?: Record<string, object>,
 *   env?: Record<string,string>, outputs?: Record<string,string>, notes?: string[], steps: string[] }} j
 * Notes render as `# NOTE <text>`; pass "(scope): message".
 */
export function job(j) {
  const out = [...(j.notes || []).map((n) => `  # NOTE ${n}`), `  ${j.id}:`];
  if (j.name) out.push(`    name: ${j.name}`);
  if (j.needs?.length) out.push(`    needs: [${j.needs.join(", ")}]`);
  if (j.if) out.push(`    if: ${j.if}`);
  out.push(`    runs-on: ${j.runsOn || "ubuntu-latest"}`);
  if (j.timeout) out.push(`    timeout-minutes: ${j.timeout}`);
  if (j.continueOnError) out.push("    continue-on-error: true");
  if (j.permissions) {
    out.push("    permissions:");
    for (const [k, v] of Object.entries(j.permissions)) out.push(`      ${k}: ${v}`);
  }
  if (j.outputs && Object.keys(j.outputs).length) {
    out.push("    outputs:");
    for (const [k, v] of Object.entries(j.outputs)) out.push(`      ${k}: ${v}`);
  }
  if (j.matrix && Object.keys(j.matrix).length) {
    out.push("    strategy:", `      fail-fast: ${j.failFast ? "true" : "false"}`, "      matrix:");
    for (const [k, v] of Object.entries(j.matrix)) out.push(`        ${k}: ${yamlList(v)}`);
  }
  if (j.env && Object.keys(j.env).length) {
    out.push("    env:");
    for (const [k, v] of Object.entries(j.env)) out.push(`      ${k}: ${v}`);
  }
  if (j.services && Object.keys(j.services).length) {
    out.push("    services:");
    for (const [name, svc] of Object.entries(j.services)) {
      out.push(`      ${name}:`, `        image: ${svc.image}`);
      if (svc.env) {
        out.push("        env:");
        for (const [k, v] of Object.entries(svc.env)) out.push(`          ${k}: ${q(v)}`);
      }
      if (svc.ports?.length) out.push(`        ports: ${yamlList(svc.ports)}`);
      if (svc.options) out.push(`        options: >-`, `          ${svc.options}`);
    }
  }
  if (j.workingDirectory && j.workingDirectory !== ".") {
    out.push("    defaults:", "      run:", `        working-directory: ${j.workingDirectory}`);
  }
  out.push("    steps:", j.steps.join("\n\n"));
  return out.join("\n");
}
