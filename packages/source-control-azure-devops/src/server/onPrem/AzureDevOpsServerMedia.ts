import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";

/** The configured collection `url` sits in, so the token goes only where it was saved for. */
function collectionOf(servers: ReadonlyArray<string>, url: URL): string | undefined {
  const path = url.pathname.toLowerCase();
  return servers.find((server) => {
    const collection = URL.parse(server);
    return (
      collection !== null &&
      collection.origin === url.origin.toLowerCase() &&
      path.startsWith(`${collection.pathname.toLowerCase().replace(/\/+$/u, "")}/`)
    );
  });
}

export const make = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
  const http = yield* AzureDevOpsServerHttp.AzureDevOpsServerHttp;

  return Effect.fn("AzureDevOpsServerMedia.fetchMedia")(function* (
    request: SourceControlMediaRequest,
  ) {
    const url = URL.parse(request.url);
    if (url === null) return null;
    const server = collectionOf(yield* api.servers, url);
    if (server === undefined) return null;
    const authorization = yield* api.authorization(server).pipe(Effect.option);
    if (Option.isNone(authorization)) return null;
    const client = HttpClient.withScope(yield* http.client);
    // Azure keeps attachments gzipped and serves them so whatever the request asks, and a range of
    // a gzip stream decodes to nothing, so the whole file is read and unpacked here.
    const { range: _range, "if-range": _ifRange, ...headers } = request.headers;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url.href).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            "accept-encoding": "identity",
            authorization: authorization.value,
            "x-tfs-fedauthredirect": "Suppress",
          }),
        ),
      )
      .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
    // Node's client follows no redirect, and one could carry the token elsewhere.
    if (response.status >= 300 && response.status < 400) return null;
    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding !== "gzip" && encoding !== "deflate") return response;
    // Response bodies are never backed by shared memory, which is all the narrowing rules out.
    const compressed = (yield* Stream.toReadableStreamEffect(response.stream)) as ReadableStream<
      Uint8Array<ArrayBuffer>
    >;
    const body = compressed.pipeThrough(new DecompressionStream(encoding));
    return HttpClientResponse.fromWeb(
      response.request,
      new Response(body, {
        status: response.status,
        headers: { "content-type": response.headers["content-type"] ?? "application/octet-stream" },
      }),
    );
  });
});
