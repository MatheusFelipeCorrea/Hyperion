import test from "node:test";
import assert from "node:assert/strict";
import { azureLinkWorkItems } from "./azure.mjs";
import { gitlabLinkIssues } from "./gitlab.mjs";
import { linearSetParent } from "./linear.mjs";

function stubRequest(response = {}) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return response;
  };
  fn.calls = calls;
  return fn;
}

test("azureLinkWorkItems PATCHes the child work item with a Hierarchy-Reverse relation pointing at the parent", async () => {
  const azureRequest = stubRequest();
  await azureLinkWorkItems(azureRequest, "https://dev.azure.com/myorg", "MyProject", 42, 7);

  assert.equal(azureRequest.calls.length, 1);
  const [endpoint, method, body, contentType] = azureRequest.calls[0];
  assert.equal(endpoint, "/_apis/wit/workitems/42?api-version=7.0");
  assert.equal(method, "PATCH");
  assert.equal(contentType, "application/json-patch+json");
  assert.equal(body.length, 1);
  assert.equal(body[0].op, "add");
  assert.equal(body[0].path, "/relations/-");
  assert.equal(body[0].value.rel, "System.LinkTypes.Hierarchy-Reverse");
  // parent work item id (7) must appear in the relation URL, project name encoded
  assert.match(body[0].value.url, /\/MyProject\/_apis\/wit\/workitems\/7$/);
});

test("azureLinkWorkItems URL-encodes a project name with spaces", async () => {
  const azureRequest = stubRequest();
  await azureLinkWorkItems(azureRequest, "https://dev.azure.com/myorg", "My Project", 1, 2);
  const [, , body] = azureRequest.calls[0];
  assert.match(body[0].value.url, /My%20Project/);
});

test("gitlabLinkIssues POSTs a relates_to link with child as the acting issue and parent as the target", async () => {
  const gitlabRequest = stubRequest();
  await gitlabLinkIssues(gitlabRequest, 555, 10, 3);

  assert.equal(gitlabRequest.calls.length, 1);
  const [endpoint, method, body] = gitlabRequest.calls[0];
  assert.equal(endpoint, "/api/v4/projects/555/issues/10/links");
  assert.equal(method, "POST");
  assert.deepEqual(body, { target_project_id: 555, target_issue_iid: 3, link_type: "relates_to" });
});

test("linearSetParent sends an issueUpdate mutation with parentId set to the parent issue's id", async () => {
  const linearGraphql = stubRequest({ issueUpdate: { success: true } });
  await linearSetParent(linearGraphql, "child-uuid", "parent-uuid");

  assert.equal(linearGraphql.calls.length, 1);
  const [query, variables] = linearGraphql.calls[0];
  assert.match(query, /issueUpdate/);
  assert.match(query, /parent\s*\{\s*id\s*\}/);
  assert.deepEqual(variables, { id: "child-uuid", input: { parentId: "parent-uuid" } });
});
