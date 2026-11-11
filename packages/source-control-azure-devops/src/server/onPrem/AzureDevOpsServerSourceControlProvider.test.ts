import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerSourceControlProvider from "./AzureDevOpsServerSourceControlProvider.ts";

const SERVER = "https://ado2022.fritz.box/defaultcollection";
const checkout = { server: SERVER, project: "DemoProjectTwo", repository: "DemoProjectTwo" };

function makeLayer() {
  const paths: string[] = [];
  const answer = (input: AzureDevOpsServerApi.AzureDevOpsServerRequest): unknown => {
    paths.push(input.path);
    if (input.path.endsWith("/pullrequests")) {
      return {
        value: [
          {
            pullRequestId: 26,
            title: "Safe writes",
            status: "active",
            creationDate: "2026-11-10T08:00:00Z",
            sourceRefName: "refs/heads/feature/26",
            targetRefName: "refs/heads/main",
            repository: {
              id: "r",
              name: "DemoProjectTwo",
              project: { id: "p", name: "DemoProjectTwo" },
            },
          },
        ],
      };
    }
    if (input.path.endsWith("/threads")) {
      return { value: [{ id: 1, lastUpdatedDate: "2026-11-11T14:09:18Z", comments: [] }] };
    }
    return {
      id: "other",
      name: "Api",
      project: { id: "pp", name: "Payments" },
      remoteUrl: "https://ado2022.fritz.box/DefaultCollection/Payments/_git/Api",
      sshUrl: "ssh://ado2022.fritz.box:2222/DefaultCollection/Payments/_git/Api",
    };
  };
  const api = AzureDevOpsServerApi.AzureDevOpsServerApi.of({
    servers: Effect.succeed([SERVER]),
    resolveRepository: () => Effect.succeed(checkout),
    resolveCheckout: () =>
      Effect.succeed({
        target: checkout,
        remote: {
          name: "origin",
          url: "https://ado2022.fritz.box/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
        },
      }),
    requestText: (input) => Effect.sync(() => JSON.stringify(answer(input))),
    request: (input) => Effect.sync(() => answer(input)),
    requestList: (input) =>
      Effect.sync(() => (answer(input) as { readonly value: ReadonlyArray<unknown> }).value),
  });
  return {
    paths,
    layer: Layer.mergeAll(
      Layer.succeed(AzureDevOpsServerApi.AzureDevOpsServerApi, api),
      TestSourceControlHost.layer(),
      NodeServices.layer,
    ),
  };
}

it.effect("dates a branch's pull request by its threads, as the pull request reads do", () => {
  const { layer } = makeLayer();
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerSourceControlProvider.make;
    const [changeRequest] = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/26",
      state: "open",
    });
    assert.deepStrictEqual(
      Option.map(changeRequest!.updatedAt, DateTime.formatIso),
      Option.some("2026-11-11T14:09:18.000Z"),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("looks up the repository asked for in the checkout's collection", () => {
  const { layer, paths } = makeLayer();
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsServerSourceControlProvider.make;
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "Payments/Api",
    });
    assert.deepStrictEqual(urls, {
      nameWithOwner: "Payments/Api",
      url: "https://ado2022.fritz.box/DefaultCollection/Payments/_git/Api",
      sshUrl: "ssh://ado2022.fritz.box:2222/DefaultCollection/Payments/_git/Api",
    });
    assert.deepStrictEqual(paths, ["Payments/_apis/git/repositories/Api"]);
  }).pipe(Effect.provide(layer));
});
