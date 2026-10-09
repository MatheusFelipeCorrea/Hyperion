/**
 * Test support: fetch route for the cards CLI subprocess tests (see
 * scripts/hyperion/fetch-mock-preload.mjs). Fully driven by the run's `state`:
 *
 *   state.responses   [{ url, method?, status?, statusText?, body }] — first entry whose
 *                     `url` is a substring of the request URL wins; `body` may be an
 *                     object (JSON), a string (raw text) or null (empty body).
 *   state.github      { projects: { repository|user|organization: nodes[] },
 *                       project: { scope, id?, fields: nodes[] }, failMutations?,
 *                       issues?: nodes[], newProjectNumber? }
 *                     — GitHub GraphQL: Projects v2 listing, project lookup, field mutations,
 *                       owner/repository node ids, issue listing + create/update (kept in
 *                       `issues`), views listing and createProjectV2 (which turns
 *                       `project` into the new, field-less repository Project).
 *   state.gitlab      { labels: names[], listStatus?, fail?: names[] } — GitLab Labels API.
 */
function reply(status, body, statusText) {
  const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, statusText, headers: { "content-type": "application/json" } });
}

function githubGraphql(req, gh) {
  const query = String(req.body?.query || "");
  const scope = /repository\(/.test(query)
    ? "repository"
    : /user\(/.test(query)
      ? "user"
      : /organization\(/.test(query)
        ? "organization"
        : null;

  if (/^\s*mutation/.test(query)) {
    if (gh.failMutations) return { errors: [{ message: "mutation refused" }] };
    const vars = req.body.variables || {};
    const { name, fieldId } = vars;
    if (/createProjectV2Field/.test(query)) return { data: { createProjectV2Field: { projectV2Field: { id: "PVTF_new", name } } } };
    if (/updateProjectV2Field/.test(query)) return { data: { updateProjectV2Field: { projectV2Field: { id: fieldId, name } } } };
    if (/createProjectV2\(/.test(query)) {
      gh.project = { scope: "repository", id: "PVT_new", fields: [] };
      return { data: { createProjectV2: { projectV2: { id: "PVT_new", number: gh.newProjectNumber } } } };
    }
    if (/createProjectV2View/.test(query)) return { data: { createProjectV2View: { projectV2View: { id: "PVTV_new", name, layout: vars.layout } } } };
    if (/createIssue\(/.test(query)) {
      gh.issues = gh.issues || [];
      const number = gh.issues.length + 1;
      const issue = { id: `I_${number}`, number, title: vars.title, url: `https://github.com/acme/app/issues/${number}`, body: vars.body, state: "OPEN" };
      gh.issues.push(issue);
      return { data: { createIssue: { issue } } };
    }
    if (/updateIssue\(/.test(query)) {
      const issue = (gh.issues || []).find((i) => i.id === vars.issueId);
      Object.assign(issue, { title: vars.title, body: vars.body });
      return { data: { updateIssue: { issue } } };
    }
    return undefined;
  }

  if (/issues\(first/.test(query)) {
    return { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: gh.issues || [] } } } };
  }
  if (/views\(first/.test(query)) return { data: { node: { views: { nodes: [] } } } };
  if (scope && /\{ id \} \}\s*$/.test(query)) return { data: { [scope]: { id: `${scope}_node` } } };

  if (/projectsV2\(/.test(query)) {
    const nodes = gh.projects?.[scope];
    return nodes === undefined ? { errors: [{ message: `no ${scope} projects` }] } : { data: { [scope]: { projectsV2: { nodes } } } };
  }

  if (/projectV2\(number/.test(query)) {
    const project = gh.project;
    if (project && project.scope === scope) {
      return { data: { [scope]: { projectV2: { id: project.id || "PVT_1", fields: { nodes: project.fields || [] } } } } };
    }
    return scope === "repository" ? { errors: [{ message: "Could not resolve to a ProjectV2" }] } : { data: { [scope]: null } };
  }
  return undefined;
}

function gitlabLabels(req, gl) {
  const match = req.url.match(/\/api\/v4\/projects\/[^/]+\/labels(?:\/([^?]+))?(?:\?.*\bpage=(\d+))?/);
  if (!match) return undefined;
  if (req.method === "GET") {
    if (gl.listStatus) return reply(gl.listStatus, { message: "upstream error" });
    const page = Number(match[2] || 1);
    return gl.labels.slice((page - 1) * 100, page * 100).map((name) => ({ name }));
  }
  const target = match[1] ? decodeURIComponent(match[1]) : req.body?.name;
  if ((gl.fail || []).includes(target)) return reply(403, { message: "403 Forbidden" });
  if (req.method === "DELETE") return reply(204, null);
  return { name: target, ...req.body };
}

export default (req, state) => {
  const canned = (state.responses || []).find((r) => req.url.includes(r.url) && (!r.method || r.method === req.method));
  if (canned) return reply(canned.status ?? 200, canned.body ?? null, canned.statusText);

  if (req.url === "https://api.github.com/graphql" && state.github) return githubGraphql(req, state.github);
  if (state.gitlab) return gitlabLabels(req, state.gitlab);
  return undefined;
};
