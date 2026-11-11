import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";
import * as AzureDevOpsServerMedia from "./AzureDevOpsServerMedia.ts";

const SERVER = "https://ado2022.fritz.box/defaultcollection";
const ATTACHMENT = "/_apis/git/repositories/r/pullRequests/33/attachments/shot.png";

it.effect("sends the token only to media inside a configured collection, and unpacks it", () => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    // Azure serves attachments gzipped whatever the request asks for.
    const gzipped = new Blob(["png bytes"]).stream().pipeThrough(new CompressionStream("gzip"));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(gzipped, {
          status: 200,
          headers: { "content-type": "image/png", "content-encoding": "gzip" },
        }),
      ),
    );
  });
  const api = AzureDevOpsServerApi.AzureDevOpsServerApi.of({
    servers: Effect.succeed([SERVER]),
    resolveRepository: () => Effect.die("unused"),
    resolveCheckout: () => Effect.die("unused"),
    authorization: () => Effect.succeed("Basic secret"),
    requestText: () => Effect.die("unused"),
    request: () => Effect.die("unused"),
    requestList: () => Effect.die("unused"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(AzureDevOpsServerApi.AzureDevOpsServerApi, api),
    Layer.succeed(AzureDevOpsServerHttp.AzureDevOpsServerHttp, {
      client: Effect.succeed(client),
    }),
  );
  return Effect.gen(function* () {
    const fetchMedia = yield* AzureDevOpsServerMedia.make;
    const inside = yield* fetchMedia({
      url: `https://ado2022.fritz.box/DefaultCollection/p${ATTACHMENT}`,
      headers: { range: "bytes=0-" },
    });
    assert.strictEqual(inside?.status, 200);
    assert.strictEqual(inside?.headers["content-encoding"], undefined);
    assert.strictEqual(yield* inside!.text, "png bytes");
    assert.strictEqual(requests[0]?.headers.authorization, "Basic secret");
    assert.strictEqual(new URL(requests[0]?.url ?? "").searchParams.get("api-version"), "7.0");
    // A range of a gzip stream would decode to nothing.
    assert.strictEqual(requests[0]?.headers.range, undefined);
    for (const url of [
      `https://ado2022.fritz.box/defaultcollection-other/p${ATTACHMENT}`,
      `https://elsewhere.example/defaultcollection/p${ATTACHMENT}`,
    ]) {
      assert.isNull(yield* fetchMedia({ url, headers: {} }), url);
    }
    assert.strictEqual(requests.length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
