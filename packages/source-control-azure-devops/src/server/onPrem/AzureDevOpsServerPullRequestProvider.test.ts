import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerPullRequestProvider from "./AzureDevOpsServerPullRequestProvider.ts";

const SERVER = "https://ado2022.fritz.box/defaultcollection";
const REPOSITORY = "DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo";
const BASE = "DemoProjectTwo/_apis/git/repositories/DemoProjectTwo";

const pullRequest = (id: number, overrides: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status: "active",
  creationDate: "2026-11-10T08:00:00Z",
  sourceRefName: `refs/heads/feature/${id}`,
  targetRefName: "refs/heads/main",
  repository: {
    id: "repo",
    name: "DemoProjectTwo",
    project: { id: "proj", name: "DemoProjectTwo" },
  },
  ...overrides,
});

const threads: Record<number, ReadonlyArray<unknown>> = {
  // A push and a vote after creation: only threads date them.
  26: [
    { id: 1, lastUpdatedDate: "2026-11-11T14:09:07.963Z", comments: [] },
    { id: 2, lastUpdatedDate: "2026-11-11T14:09:18Z", comments: [] },
  ],
  25: [],
};

function makeLayer(lists: { readonly pullRequests: ReadonlyArray<unknown> }) {
  const paths: string[] = [];
  const queries: Array<Readonly<Record<string, unknown>> | undefined> = [];
  const answer = (input: AzureDevOpsServerApi.AzureDevOpsServerRequest): unknown => {
    paths.push(input.path);
    queries.push(input.query);
    if (input.path === `${BASE}/pullrequests`) return { value: lists.pullRequests };
    const thread = /pullRequests\/(\d+)\/threads$/u.exec(input.path);
    if (thread) return { value: threads[Number(thread[1])] ?? [] };
    const single = /pullRequests\/(\d+)$/u.exec(input.path);
    if (single) return pullRequest(Number(single[1]));
    if (input.path === "_apis/connectionData") return { authenticatedUser: { id: "viewer-id" } };
    if (/pullRequests\/\d+\/iterations$/u.test(input.path)) {
      return {
        value: [
          { id: 1, sourceRefCommit: { commitId: "head" }, commonRefCommit: { commitId: "base" } },
        ],
      };
    }
    // An item read the server answers with something other than its JSON shape.
    if (input.path.endsWith("/items")) return "<html>sign in</html>";
    return { value: [] };
  };
  const api = AzureDevOpsServerApi.AzureDevOpsServerApi.of({
    servers: Effect.succeed([SERVER]),
    resolveRepository: () =>
      Effect.succeed({ server: SERVER, project: "DemoProjectTwo", repository: "DemoProjectTwo" }),
    resolveCheckout: () =>
      Effect.succeed({
        target: { server: SERVER, project: "DemoProjectTwo", repository: "DemoProjectTwo" },
        remote: { name: "origin", url: `https://ado2022.fritz.box/${REPOSITORY}` },
      }),
    requestText: (input) => Effect.sync(() => JSON.stringify(answer(input))),
    request: (input) => Effect.sync(() => answer(input)),
    requestList: (input) =>
      Effect.sync(() => (answer(input) as { readonly value: ReadonlyArray<unknown> }).value),
  });
  return {
    paths,
    queries,
    layer: Layer.succeed(AzureDevOpsServerApi.AzureDevOpsServerApi, api),
  };
}

const ref = { cwd: "/repo", host: "ado2022.fritz.box", repository: REPOSITORY };

it.effect("dates list rows by their threads, as every single read does", () => {
  const { layer } = makeLayer({ pullRequests: [pullRequest(26), pullRequest(25)] });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      ...ref,
      state: "open",
      involvement: "all",
      viewer: "ADO2022\\max",
      limit: 10,
    });
    assert.deepStrictEqual(
      page.items.map((item) => [item.number, item.updatedAt]),
      [
        [26, "2026-11-11T14:09:18.000Z"],
        [25, "2026-11-10T08:00:00.000Z"],
      ],
    );
    const summary = yield* provider.getChangeRequestSummary!({ ...ref, number: 26 });
    assert.strictEqual(summary.updatedAt, page.items[0]?.updatedAt);
    assert.strictEqual(
      page.items[0]?.url,
      `${SERVER}/DemoProjectTwo/_git/DemoProjectTwo/pullrequest/26`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("pages by offset and filters by the viewer's identity", () => {
  const { layer, queries } = makeLayer({
    pullRequests: [pullRequest(27), { broken: true }, pullRequest(26), pullRequest(25)],
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      ...ref,
      state: "merged",
      involvement: "authored",
      viewer: "ADO2022\\max",
      limit: 2,
      cursor: { updatedBefore: "2026-11-12T00:00:00Z", delivered: 4 },
    });
    assert.deepStrictEqual(
      page.items.map((item) => item.number),
      [27, 26],
    );
    // The malformed row counts toward the offset, or the next page would repeat a row.
    assert.strictEqual(page.cursorAdvance, 3);
    assert.isTrue(page.truncated);
    assert.deepStrictEqual(
      queries.find((query) => query?.["searchCriteria.status"]),
      {
        "searchCriteria.status": "completed",
        "searchCriteria.creatorId": "viewer-id",
        $top: 3,
        $skip: 4,
      },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("fails a file it cannot read instead of showing it as empty", () => {
  const { layer } = makeLayer({ pullRequests: [] });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const failure = yield* Effect.flip(
      provider.getDiffFileContents!({
        ...ref,
        number: 25,
        changeType: "change",
        oldPath: "public/app.js",
        newPath: "public/app.js",
      }),
    );
    assert.strictEqual(failure.reason, "failed");
  }).pipe(Effect.provide(layer));
});
