import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

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

const UNREADABLE = Symbol("unreadable");
const THROTTLED = Symbol("throttled");

function makeLayer(lists: {
  readonly pullRequests: ReadonlyArray<unknown>;
  readonly answer?: (input: AzureDevOpsServerApi.AzureDevOpsServerRequest) => unknown;
}) {
  const paths: string[] = [];
  const queries: Array<Readonly<Record<string, unknown>> | undefined> = [];
  const calls: AzureDevOpsServerApi.AzureDevOpsServerRequest[] = [];
  const answer = (input: AzureDevOpsServerApi.AzureDevOpsServerRequest): unknown => {
    paths.push(input.path);
    queries.push(input.query);
    calls.push(input);
    const special = lists.answer?.(input);
    if (special !== undefined) return special;
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
      Effect.suspend(() => {
        const body = answer(input);
        return body === UNREADABLE || body === THROTTLED
          ? Effect.fail(
              new AzureDevOpsServerApi.AzureDevOpsServerApiError({
                server: SERVER,
                operation: "test",
                status: body === THROTTLED ? 429 : 403,
                reason: body === THROTTLED ? "rate-limited" : "forbidden",
                detail: "No.",
              }),
            )
          : Effect.succeed((body as { readonly value: ReadonlyArray<unknown> }).value);
      }),
  });
  return {
    paths,
    queries,
    calls,
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

const writes = (calls: ReadonlyArray<AzureDevOpsServerApi.AzureDevOpsServerRequest>) =>
  calls.filter((call) => call.method !== undefined && call.method !== "GET");

it.effect("completes at the head the reader saw and drops agent credits from the message", () => {
  let reads = 0;
  const { layer, calls } = makeLayer({
    pullRequests: [],
    answer: (input) => {
      if (input.path !== `${BASE}/pullRequests/26`) return undefined;
      if (input.method === "PATCH") return pullRequest(26, { title: "Safe writes" });
      reads += 1;
      // Azure completes in the background: the reply and the first read are still active.
      return pullRequest(26, {
        title: "Safe writes",
        description: "Body.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        lastMergeSourceCommit: { commitId: "abc123" },
        ...(reads > 2 ? { status: "completed", closedDate: "2026-11-11T14:09:19Z" } : {}),
      });
    },
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const merging = yield* provider
      .runAction({
        ...ref,
        number: 26,
        action: "merge",
        mergeMethod: "squash",
        removeAgentCreditsOnMerge: true,
      })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const summary = yield* Fiber.join(merging);
    assert.strictEqual(summary?.state, "merged");
    assert.deepStrictEqual(
      writes(calls).map((call) => [call.method, call.path, call.body]),
      [
        [
          "PATCH",
          `${BASE}/pullRequests/26`,
          {
            status: "completed",
            lastMergeSourceCommit: { commitId: "abc123" },
            completionOptions: {
              mergeStrategy: "squash",
              mergeCommitMessage: "Merged PR 26: Safe writes\n\nBody.",
            },
          },
        ],
      ],
    );
    // Dated by the threads and the close, as later reads date it, so it is not dropped as stale.
    assert.strictEqual(summary?.updatedAt, "2026-11-11T14:09:19.000Z");
  }).pipe(Effect.provide(layer));
});

it.effect("turns auto-complete off by clearing who set it", () => {
  const { layer, calls } = makeLayer({ pullRequests: [] });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    yield* provider.runAction({ ...ref, number: 26, action: "disable-auto-merge" });
    assert.deepStrictEqual(writes(calls)[0]?.body, {
      autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("deletes the source branch at the commit it points at, and reports a refusal", () => {
  const refs = { value: [{ name: "refs/heads/feature/26", objectId: "def456" }] };
  const run = (refused: boolean, overrides: Record<string, unknown> = {}) => {
    const { layer, calls } = makeLayer({
      pullRequests: [],
      answer: (input) =>
        input.path === `${BASE}/pullRequests/26` && input.method === undefined
          ? pullRequest(26, overrides)
          : input.path.endsWith("/refs")
            ? input.method === "POST"
              ? {
                  value: [
                    refused
                      ? {
                          success: false,
                          updateStatus: "rejectedByPolicy",
                          customMessage: "Locked",
                        }
                      : { success: true },
                  ],
                }
              : refs
            : undefined,
    });
    return Effect.gen(function* () {
      const provider = yield* AzureDevOpsServerPullRequestProvider.make;
      const result = yield* provider
        .runAction({ ...ref, number: 26, action: "delete-branch" })
        .pipe(Effect.result);
      return { result, calls };
    }).pipe(Effect.provide(layer));
  };
  return Effect.gen(function* () {
    const deleted = yield* run(false);
    assert.strictEqual(deleted.result._tag, "Success");
    assert.deepStrictEqual(writes(deleted.calls)[0]?.body, [
      {
        name: "refs/heads/feature/26",
        oldObjectId: "def456",
        newObjectId: "0000000000000000000000000000000000000000",
      },
    ]);
    const kept = yield* run(true);
    assert.strictEqual(
      kept.result._tag === "Failure" ? kept.result.failure.reason : null,
      "forbidden",
    );
    // A fork's branch is not this repository's to delete, whatever shares its name here.
    const fork = yield* run(false, { forkSource: { repository: { id: "fork" } } });
    assert.strictEqual(
      fork.result._tag === "Failure" ? fork.result.failure.reason : null,
      "forbidden",
    );
    assert.deepStrictEqual(writes(fork.calls), []);
  });
});

it.effect("adds a reviewer by account name and removes one already on the pull request", () => {
  const { layer, calls } = makeLayer({
    pullRequests: [],
    answer: (input) =>
      input.path === "_apis/identities"
        ? { value: [{ id: "harry-id", providerDisplayName: "Harry Walker" }] }
        : input.path === `${BASE}/pullRequests/26` && input.method === undefined
          ? pullRequest(26, {
              reviewers: [
                { id: "max-id", uniqueName: "ADO2022\\max", displayName: "Max", vote: 0 },
              ],
            })
          : undefined,
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    yield* provider.setReviewerRequest({
      ...ref,
      number: 26,
      reviewers: [{ id: "ADO2022\\hwalker", kind: "user" }],
      requested: true,
    });
    yield* provider.setReviewerRequest({
      ...ref,
      number: 26,
      reviewers: [{ id: "ADO2022\\max", kind: "user" }],
      requested: false,
    });
    assert.deepStrictEqual(
      calls.find((call) => call.path === "_apis/identities")?.query?.searchFilter,
      "AccountName",
    );
    assert.deepStrictEqual(
      writes(calls).map((call) => [call.method, call.path]),
      [
        ["PUT", `${BASE}/pullRequests/26/reviewers/harry-id`],
        ["DELETE", `${BASE}/pullRequests/26/reviewers/max-id`],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("marks checks it could not list instead of passing on the rest", () => {
  const { layer } = makeLayer({
    pullRequests: [],
    answer: (input) =>
      input.path.endsWith("/policy/evaluations")
        ? UNREADABLE
        : input.path.endsWith("/statuses")
          ? { value: [{ id: 1, state: "succeeded", context: { name: "deploy" } }] }
          : undefined,
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const { checks } = yield* provider.getChangeRequestChecks!({ ...ref, number: 26 });
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.status, check.placeholder ?? false]),
      [
        ["deploy", "success", false],
        ["Branch policies", "pending", true],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("lets a throttled check read through so the caller backs off", () => {
  const { layer } = makeLayer({
    pullRequests: [],
    answer: (input) => (input.path.endsWith("/policy/evaluations") ? THROTTLED : undefined),
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const failure = yield* Effect.flip(provider.getChangeRequestChecks!({ ...ref, number: 26 }));
    assert.strictEqual(failure.reason, "rate-limited");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a closed pull request's list date in step with a newer detail read", () => {
  let threadAt = "2026-11-11T10:00:00Z";
  const closed = pullRequest(30, { status: "completed", closedDate: "2026-11-11T09:00:00Z" });
  const { layer } = makeLayer({
    pullRequests: [closed],
    answer: (input) =>
      input.path === `${BASE}/pullRequests/30/threads`
        ? { value: [{ id: 1, lastUpdatedDate: threadAt, comments: [] }] }
        : input.path === `${BASE}/pullRequests/30`
          ? closed
          : undefined,
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const list = () =>
      provider
        .listChangeRequests({ ...ref, state: "merged", involvement: "all", viewer: "v", limit: 5 })
        .pipe(Effect.map((page) => page.items[0]?.updatedAt));
    assert.strictEqual(yield* list(), "2026-11-11T10:00:00.000Z");
    // A comment after the merge: the detail sees it, and the cached list date must follow.
    threadAt = "2026-11-11T12:00:00Z";
    assert.strictEqual(
      (yield* provider.getChangeRequest({ ...ref, number: 30 })).updatedAt,
      "2026-11-11T12:00:00.000Z",
    );
    assert.strictEqual(yield* list(), "2026-11-11T12:00:00.000Z");
  }).pipe(Effect.provide(layer));
});

it.effect("fails the list rather than date a row by a conversation it could not read", () => {
  const { layer } = makeLayer({
    pullRequests: [pullRequest(26)],
    answer: (input) => (input.path.endsWith("/pullRequests/26/threads") ? UNREADABLE : undefined),
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const result = yield* provider
      .listChangeRequests({ ...ref, state: "open", involvement: "all", viewer: "v", limit: 5 })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect("reads past a page of rows that do not decode", () => {
  const { layer, queries } = makeLayer({
    pullRequests: [],
    answer: (input) =>
      input.path === `${BASE}/pullrequests`
        ? input.query?.$skip === undefined
          ? { value: [{ broken: 1 }, { broken: 2 }, { broken: 3 }] }
          : { value: [pullRequest(25)] }
        : undefined,
  });
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerPullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      ...ref,
      state: "open",
      involvement: "all",
      viewer: "v",
      limit: 2,
    });
    assert.deepStrictEqual(
      page.items.map((item) => item.number),
      [25],
    );
    assert.strictEqual(page.cursorAdvance, 4);
    assert.isFalse(page.truncated);
    assert.deepStrictEqual(
      queries
        .filter((query) => query?.$top !== undefined)
        .map((query) => [query?.$top, query?.$skip]),
      [
        [3, undefined],
        [3, 3],
      ],
    );
  }).pipe(Effect.provide(layer));
});
