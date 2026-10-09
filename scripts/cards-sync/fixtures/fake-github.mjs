/**
 * Test support: a small stateful fake of the GitHub GraphQL API used by sync.mjs
 * (issues, labels, sub-issues, comments, Projects v2 fields/items/views).
 * Default export is a fetch-mock route: `(req, state) => object | undefined`.
 *
 * state = {
 *   repoSlug, repoId,
 *   issues: [{ id, number, title, body, state, updatedAt, author, labels: [name] }],
 *   labels: { [name]: { id, color, description } },
 *   projects: [{ id, number, title, scope, repos: [slug], fields: [...], items: [...], views: [...] }],
 *   owners: { user: id|null, organization: id|null },
 *   pageSize, newProjectScope, newProjectFields,
 *   fail: { [op]: true | string[] (substring of the op key) | { skip, times } },
 *   failMessage: { [op]: string },
 * }
 * Every mutation is appended to state.log as { op, ...variables } for assertions.
 */

const OPS = [
  ["addComment", /addComment\(/],
  ["createIssue", /createIssue\(/],
  ["updateIssue", /updateIssue\(/],
  ["addSubIssue", /addSubIssue\(/],
  ["updateLabel", /updateLabel\(/],
  ["createLabel", /createLabel\(/],
  ["addLabels", /addLabelsToLabelable\(/],
  ["createProject", /createProjectV2\(/],
  ["linkProject", /linkProjectV2ToRepository\(/],
  ["createField", /createProjectV2Field\(/],
  ["updateField", /updateProjectV2Field\(/],
  ["deleteView", /deleteProjectV2View\(/],
  ["createView", /createProjectV2View\(/],
  ["updateView", /updateProjectV2View\(/],
  ["setFieldValue", /updateProjectV2ItemFieldValue\(/],
  ["addItem", /addProjectV2ItemById\(/],
  ["listProjects", /projectsV2\(first/],
  ["getProject", /projectV2\(number/],
  ["projectRepos", /repositories\(first/],
  ["views", /views\(first/],
  ["itemFields", /fieldValues\(first/],
  ["items", /items\(first/],
  ["issues", /issues\(first/],
  ["label", /label\(name/],
  ["ownerId", /\(login: \$login\) \{ id \}/],
  ["repoId", /repository\(owner: \$owner, name: \$name\) \{ id \}/],
];

const SCOPES = ["repository", "user", "organization"];

function scopeOf(query) {
  return SCOPES.find((scope) => query.includes(`${scope}(`)) || "repository";
}

function shouldFail(state, op, key) {
  const rule = state.fail?.[op];
  state.counts = state.counts || {};
  const n = (state.counts[op] = (state.counts[op] || 0) + 1);
  if (!rule) return false;
  if (rule === true) return true;
  if (Array.isArray(rule)) return rule.some((needle) => String(key).includes(needle));
  return n > (rule.skip || 0) && n <= (rule.skip || 0) + (rule.times ?? Infinity);
}

function page(list, after, size) {
  const start = after ? Number(after) : 0;
  const end = start + size;
  return {
    nodes: list.slice(start, end),
    pageInfo: { hasNextPage: end < list.length, endCursor: end < list.length ? String(end) : null },
  };
}

function nextId(state, prefix) {
  state.seq = (state.seq || 0) + 1;
  return `${prefix}_${state.seq}`;
}

function issueUrl(state, number) {
  return `https://github.com/${state.repoSlug}/issues/${number}`;
}

function projectById(state, id) {
  return state.projects.find((p) => p.id === id);
}

function fieldValueNode(project, fieldId, value) {
  const field = project.fields.find((f) => f.id === fieldId) || { id: fieldId, name: "?" };
  const ref = { id: field.id, name: field.name };
  if (value.singleSelectOptionId) {
    return { field: ref, name: field.options?.find((o) => o.id === value.singleSelectOptionId)?.name ?? "" };
  }
  if (value.iterationId) {
    return { field: ref, title: field.configuration?.iterations?.find((i) => i.id === value.iterationId)?.title ?? "" };
  }
  return { field: ref, ...value };
}

const handlers = {
  repoId: (state) => ({ repository: { id: state.repoId } }),

  issues: (state, v) => {
    const nodes = state.issues.map((issue) => ({
      ...issue,
      url: issueUrl(state, issue.number),
      labels: { nodes: (issue.labels || []).map((name) => ({ name })) },
    }));
    return { repository: { issues: page(nodes, v.endCursor, state.pageSize) } };
  },

  createIssue: (state, v) => {
    const number = Math.max(0, ...state.issues.map((i) => i.number || 0)) + 1;
    const issue = { id: `I_${number}`, number, title: v.title, body: v.body, state: "OPEN", updatedAt: state.now, author: { login: "hyperion" }, labels: [] };
    state.issues.push(issue);
    return { createIssue: { issue: { id: issue.id, number, title: v.title, url: issueUrl(state, number) } } };
  },

  updateIssue: (state, v) => {
    const issue = state.issues.find((i) => i.id === v.issueId);
    Object.assign(issue, { title: v.title, body: v.body });
    return { updateIssue: { issue: { id: issue.id, number: issue.number, title: issue.title, url: issueUrl(state, issue.number) } } };
  },

  addSubIssue: (state, v) => {
    state.subIssues.push([v.issueId, v.subIssueId]);
    return { addSubIssue: { issue: { id: v.issueId } } };
  },

  addComment: (state, v) => {
    state.comments.push({ id: v.id, body: v.body });
    return { addComment: { comment: { id: nextId(state, "C") } } };
  },

  label: (state, v) => ({ repository: { id: state.repoId, label: state.labels[v.labelName] || null } }),

  createLabel: (state, v) => {
    const label = { id: nextId(state, "LA"), color: v.color, description: v.description };
    state.labels[v.name] = label;
    return { createLabel: { label: { id: label.id } } };
  },

  updateLabel: (state, v) => {
    const label = Object.values(state.labels).find((l) => l.id === v.id);
    Object.assign(label, { color: v.color, description: v.description });
    return { updateLabel: { label: { id: v.id } } };
  },

  addLabels: (state, v) => {
    const issue = state.issues.find((i) => i.id === v.labelableId);
    const names = Object.entries(state.labels).filter(([, l]) => v.labelIds.includes(l.id)).map(([name]) => name);
    issue.labels = [...new Set([...(issue.labels || []), ...names])];
    return { addLabelsToLabelable: { clientMutationId: null } };
  },

  getProject: (state, v, query) => {
    const scope = scopeOf(query);
    const project = state.projects.find((p) => p.scope === scope && p.number === v.number);
    return { [scope]: { projectV2: project ? { id: project.id, fields: { nodes: project.fields } } : null } };
  },

  listProjects: (state, v, query) => {
    const scope = scopeOf(query);
    const nodes = state.projects
      .filter((p) => (scope === "repository" ? p.repos.includes(state.repoSlug) : p.scope === scope))
      .map(({ number, title, id }) => ({ number, title, id }));
    return { [scope]: { projectsV2: { nodes } } };
  },

  ownerId: (state, v, query) => {
    const scope = scopeOf(query);
    return { [scope]: state.owners[scope] ? { id: state.owners[scope] } : null };
  },

  createProject: (state, v) => {
    const number = Math.max(0, ...state.projects.map((p) => p.number)) + 1;
    const project = {
      id: `PVT_${number}`,
      number,
      title: v.title,
      scope: state.newProjectScope,
      repos: v.repositoryId ? [state.repoSlug] : [],
      fields: state.newProjectFields,
      items: [],
      views: [],
    };
    state.projects.push(project);
    return { createProjectV2: { projectV2: { id: project.id, number } } };
  },

  projectRepos: (state, v) => ({
    node: { repositories: { nodes: projectById(state, v.projectId).repos.map((nameWithOwner) => ({ nameWithOwner })) } },
  }),

  linkProject: (state, v) => {
    projectById(state, v.projectId).repos.push(state.repoSlug);
    return { linkProjectV2ToRepository: { repository: { nameWithOwner: state.repoSlug } } };
  },

  createField: (state, v, query) => {
    const dataType = query.match(/dataType: (\w+)/)[1];
    const field = { id: nextId(state, "F"), name: v.name };
    if (dataType === "SINGLE_SELECT") {
      Object.assign(field, { __typename: "ProjectV2SingleSelectField", options: v.options.map((o) => ({ ...o, id: nextId(state, "O") })) });
    } else if (dataType === "ITERATION") {
      const iterations = v.config.iterations.map((it) => ({ id: nextId(state, "IT"), title: it.title }));
      Object.assign(field, { __typename: "ProjectV2IterationField", configuration: { iterations } });
    } else {
      Object.assign(field, { __typename: "ProjectV2Field", dataType });
    }
    projectById(state, v.projectId).fields.push(field);
    return { createProjectV2Field: { projectV2Field: { id: field.id, name: field.name } } };
  },

  updateField: (state, v) => {
    const field = state.projects.flatMap((p) => p.fields).find((f) => f.id === v.fieldId);
    field.options = v.options.map((o) => ({ ...o, id: o.id || nextId(state, "O") }));
    return { updateProjectV2Field: { projectV2Field: field } };
  },

  views: (state, v) => ({ node: { views: { nodes: projectById(state, v.id).views } } }),

  createView: (state, v) => {
    projectById(state, v.projectId).views.push({ id: nextId(state, "V"), name: v.name, layout: v.layout });
    return { createProjectV2View: { projectV2View: { id: "v" } } };
  },

  updateView: (state, v) => {
    const view = state.projects.flatMap((p) => p.views).find((x) => x.id === v.viewId);
    Object.assign(view, { name: v.name, layout: v.layout });
    return { updateProjectV2View: { projectV2View: view } };
  },

  deleteView: (state, v) => {
    for (const p of state.projects) p.views = p.views.filter((x) => x.id !== v.viewId);
    return { deleteProjectV2View: { projectV2View: { id: v.viewId } } };
  },

  items: (state, v) => {
    const nodes = projectById(state, v.projectId).items.map((item) => ({ id: item.id, content: item.issueId ? { id: item.issueId } : null }));
    return { node: { items: page(nodes, v.endCursor, state.pageSize) } };
  },

  addItem: (state, v) => {
    const item = { id: nextId(state, "PVTI"), issueId: v.contentId, values: {} };
    projectById(state, v.projectId).items.push(item);
    return { addProjectV2ItemById: { item: { id: item.id } } };
  },

  setFieldValue: (state, v) => {
    projectById(state, v.projectId).items.find((i) => i.id === v.itemId).values[v.fieldId] = v.value;
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.itemId } } };
  },

  itemFields: (state, v) => {
    const project = projectById(state, v.projectId);
    const nodes = project.items.map((item) => {
      const issue = state.issues.find((i) => i.id === item.issueId);
      return {
        content: issue ? { number: issue.number } : {},
        fieldValues: { nodes: Object.entries(item.values).map(([fieldId, value]) => fieldValueNode(project, fieldId, value)) },
      };
    });
    return { node: { items: page(nodes, v.endCursor, state.pageSize) } };
  },
};

/** Key a `fail` rule matches against, per operation. */
function failKey(op, v, query) {
  if (op === "createIssue" || op === "updateIssue") return `${v.title}\n${v.body}`;
  if (op === "createField") return v.name;
  if (op === "getProject" || op === "ownerId") return scopeOf(query);
  return JSON.stringify(v ?? null);
}

export function withDefaults(state) {
  state.repoSlug ??= "acme/app";
  state.repoId ??= "R_1";
  state.now ??= "2026-01-01T00:00:00Z";
  state.pageSize ??= 100;
  state.issues ??= [];
  state.labels ??= {};
  state.projects ??= [];
  state.owners ??= { user: "U_1", organization: null };
  state.newProjectScope ??= "user";
  state.newProjectFields ??= [];
  state.subIssues ??= [];
  state.comments ??= [];
  state.log ??= [];
  return state;
}

export default function fakeGitHub(req, state) {
  if (req.url !== "https://api.github.com/graphql") return undefined;
  withDefaults(state);
  const { query, variables = {} } = req.body;
  const [op] = OPS.find(([, re]) => re.test(query)) || [];
  if (!op) return undefined;
  if (shouldFail(state, op, failKey(op, variables, query))) {
    return { errors: [{ message: state.failMessage?.[op] || `${op} failed` }] };
  }
  if (query.trimStart().startsWith("mutation")) state.log.push({ op, auth: req.headers.Authorization, ...variables });
  return { data: handlers[op](state, variables, query) };
}
