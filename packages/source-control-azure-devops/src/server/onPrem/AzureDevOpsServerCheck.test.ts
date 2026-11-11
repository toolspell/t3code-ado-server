import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerCheck from "./AzureDevOpsServerCheck.ts";

const notJson = new AzureDevOpsServerApi.AzureDevOpsServerApiError({
  server: "x",
  operation: "checkServer",
  status: null,
  reason: "failed",
  detail: "The server answered with something other than JSON.",
});

function makeLayer(
  answer: (
    input: AzureDevOpsServerApi.AzureDevOpsServerRequest,
  ) => Effect.Effect<unknown, AzureDevOpsServerApi.AzureDevOpsServerApiError>,
) {
  const seen: AzureDevOpsServerApi.AzureDevOpsServerRequest[] = [];
  const request = (input: AzureDevOpsServerApi.AzureDevOpsServerRequest) => {
    seen.push(input);
    return answer(input);
  };
  const api = AzureDevOpsServerApi.AzureDevOpsServerApi.of({
    servers: Effect.succeed([]),
    resolveRepository: () => Effect.die("unused"),
    resolveCheckout: () => Effect.die("unused"),
    requestText: (input) => request(input).pipe(Effect.map((body) => JSON.stringify(body))),
    request,
    requestList: (input) =>
      request(input).pipe(
        Effect.map((body) => (body as { readonly value: ReadonlyArray<unknown> }).value),
      ),
  });
  return { seen, layer: Layer.succeed(AzureDevOpsServerApi.AzureDevOpsServerApi, api) };
}

const check = (url: string, token?: string) =>
  Effect.gen(function* () {
    const checkServer = yield* AzureDevOpsServerCheck.make;
    return yield* checkServer({ url, token }).pipe(Effect.result);
  });

it.effect("signs in with the entered token and keys the server as Settings does", () => {
  const { layer, seen } = makeLayer((input) =>
    Effect.succeed(
      input.path === "_apis/connectionData"
        ? {
            authenticatedUser: { id: "u1", providerDisplayName: "Max Beckenbach" },
            deploymentType: "onPremises",
            webApplicationRelativeDirectory: "DefaultCollection/",
          }
        : { value: [] },
    ),
  );
  return Effect.gen(function* () {
    const checkServer = yield* AzureDevOpsServerCheck.make;
    assert.deepStrictEqual(
      yield* checkServer({ url: "https://ADO2022.fritz.box/DefaultCollection/", token: "pat" }),
      { url: "https://ado2022.fritz.box/defaultcollection", account: "Max Beckenbach" },
    );
    assert.deepStrictEqual(
      seen.map((input) => [input.server, input.path, input.token]),
      [
        ["https://ado2022.fritz.box/defaultcollection", "_apis/connectionData", "pat"],
        ["https://ado2022.fritz.box/defaultcollection", "_apis/projects", "pat"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("offers the server's collections when the URL names the server itself", () => {
  const { layer } = makeLayer((input) =>
    Effect.succeed(
      input.path === "_apis/connectionData"
        ? { authenticatedUser: { id: "u1" }, deploymentType: "onPremises" }
        : { value: [{ name: "DefaultCollection" }, { name: "Second One" }] },
    ),
  );
  return Effect.gen(function* () {
    const result = yield* check("https://ado2022.fritz.box");
    assert.isTrue(result._tag === "Failure");
    if (result._tag !== "Failure") return;
    assert.strictEqual(result.failure.reason, "wrong-server");
    assert.deepStrictEqual(result.failure.suggestions, [
      "https://ado2022.fritz.box/defaultcollection",
      "https://ado2022.fritz.box/second%20one",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("offers the parent URL when a project page answers instead of a collection", () => {
  const { layer } = makeLayer(() => Effect.fail(notJson));
  return Effect.gen(function* () {
    const result = yield* check("https://tfs.corp/DefaultCollection/Payments");
    assert.isTrue(result._tag === "Failure");
    if (result._tag !== "Failure") return;
    assert.strictEqual(result.failure.reason, "wrong-server");
    assert.deepStrictEqual(result.failure.suggestions, ["https://tfs.corp/defaultcollection"]);
    assert.strictEqual(result.failure.cause, notJson);
  }).pipe(Effect.provide(layer));
});

it.effect("turns Azure DevOps Services and bad URLs away before sending the token", () => {
  const { layer, seen } = makeLayer(() => Effect.die("must not be asked"));
  return Effect.gen(function* () {
    for (const [url, reason] of [
      ["https://dev.azure.com/acme", "wrong-server"],
      ["tfs.corp/DefaultCollection", "invalid-url"],
    ] as const) {
      const result = yield* check(url, "pat");
      assert.strictEqual(result._tag === "Failure" ? result.failure.reason : null, reason, url);
    }
    assert.strictEqual(seen.length, 0);
  }).pipe(Effect.provide(layer));
});
