import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";

const SERVER = "https://ado2022.fritz.box/defaultcollection";

function makeLayer(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
  });
  const layer = AzureDevOpsServerApi.layer.pipe(
    Layer.provide(
      Layer.succeed(AzureDevOpsServerHttp.AzureDevOpsServerHttp, {
        client: Effect.succeed(client),
      }),
    ),
    Layer.provide(
      TestSourceControlHost.layer({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sourceControlHosts: {
            "azure-devops-server": {
              tokens: {
                "https://ADO2022.fritz.box/DefaultCollection/": "pat-secret",
                "https://other/c": "",
              },
            },
          },
        },
      }),
    ),
  );
  return { requests, layer };
}

const failureOf = <A>(effect: Effect.Effect<A, AzureDevOpsServerApi.AzureDevOpsServerApiError>) =>
  Effect.flip(Effect.asVoid(effect));

it.effect("signs requests with the PAT as a Basic password and pins the API version", () => {
  const { requests, layer } = makeLayer(() => Response.json({ value: [{ id: 1 }] }));
  return Effect.gen(function* () {
    const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
    assert.deepStrictEqual(yield* api.servers, [SERVER]);
    const rows = yield* api.requestList({
      server: SERVER,
      operation: "test",
      path: "P/_apis/git/repositories/R/pullrequests",
      query: { "searchCriteria.status": "active", $top: 3, skipped: undefined },
    });
    assert.deepStrictEqual(rows, [{ id: 1 }]);
    yield* api.request({
      server: SERVER,
      operation: "test",
      path: "_apis/connectionData",
      preview: true,
    });
    const [list, connection] = requests.map((request) => ({
      url: new URL(request.url),
      authorization: request.headers.authorization,
    }));
    assert.strictEqual(
      list?.url.pathname,
      "/defaultcollection/P/_apis/git/repositories/R/pullrequests",
    );
    assert.deepStrictEqual(Object.fromEntries(list?.url.searchParams ?? []), {
      "searchCriteria.status": "active",
      $top: "3",
      "api-version": "7.0",
    });
    assert.strictEqual(
      list?.authorization,
      `Basic ${Buffer.from(":pat-secret").toString("base64")}`,
    );
    assert.strictEqual(connection?.url.searchParams.get("api-version"), "7.0-preview");
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  "https://elsewhere.example/_apis",
  "https://ado2022.fritz.box/defaultcollection-other/_apis",
])("does not follow a redirect off the collection to %s, so the PAT stays with it", (location) => {
  const { requests, layer } = makeLayer(
    () => new Response(null, { status: 302, headers: { location } }),
  );
  return Effect.gen(function* () {
    const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
    const error = yield* failureOf(
      api.request({ server: SERVER, operation: "test", path: "_apis/x" }),
    );
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(error.reason, "unauthenticated");
  }).pipe(Effect.provide(layer));
});

it.effect("maps server answers to reasons a reader can act on", () => {
  const answers: Record<string, Response> = {
    "/defaultcollection/401": new Response("", { status: 401 }),
    "/defaultcollection/403": Response.json(
      { message: "TF401027: You need Contribute." },
      { status: 403 },
    ),
    "/defaultcollection/429": new Response("", { status: 429, headers: { "retry-after": "30" } }),
    "/defaultcollection/400": Response.json(
      {
        message:
          "The requested REST API version of 7.0 is out of range for this server. The latest REST API version this server supports is 5.0.",
      },
      { status: 400 },
    ),
  };
  const { layer } = makeLayer((request) => answers[new URL(request.url).pathname]!);
  return Effect.gen(function* () {
    const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
    const failed = (path: string) =>
      failureOf(api.request({ server: SERVER, operation: "test", path }));
    assert.strictEqual((yield* failed("401")).reason, "unauthenticated");
    const forbidden = yield* failed("403");
    assert.deepStrictEqual(
      [forbidden.reason, forbidden.detail],
      ["forbidden", "TF401027: You need Contribute."],
    );
    const limited = yield* failed("429");
    assert.strictEqual(limited.reason, "rate-limited");
    assert.strictEqual(limited.retryAt, 30_000);
    const old = yield* failed("400");
    assert.strictEqual(old.reason, "unsupported-server");
    assert.match(old.detail, /2022 or newer/u);
  }).pipe(Effect.provide(layer));
});

it.effect("asks for a server that is missing or has no token in Settings", () => {
  const { requests, layer } = makeLayer(() => Response.json({}));
  return Effect.gen(function* () {
    const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
    const missing = yield* failureOf(api.resolveRepository({ host: "other", path: "c/p/_git/r" }));
    assert.strictEqual(missing.reason, "not-configured");
    const empty = yield* failureOf(
      api.request({ server: "https://other/c", operation: "test", path: "x" }),
    );
    assert.strictEqual(empty.reason, "not-configured");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it("explains an untrusted certificate apart from an unreachable server", () => {
  const tls = Object.assign(new Error("self-signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.strictEqual(
    AzureDevOpsServerApi.transportFailure({ cause: { cause: tls } }).reason,
    "untrusted-certificate",
  );
  assert.strictEqual(
    AzureDevOpsServerApi.transportFailure(
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    ).reason,
    "unreachable",
  );
});
