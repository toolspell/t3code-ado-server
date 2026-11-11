import * as NodeTls from "node:tls";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";

vi.mock("node:tls", { spy: true });

it.effect("trusts a replaced certificate even when the list keeps its size", () =>
  Effect.gen(function* () {
    let certificates = ["-----CERTIFICATE A-----"];
    using _trust = vi
      .spyOn(NodeTls, "getCACertificates")
      .mockImplementation((store) => (store === "system" ? [] : certificates));
    const http = yield* AzureDevOpsServerHttp.make;
    const first = yield* http.client;
    assert.strictEqual(yield* http.client, first);
    certificates = ["-----CERTIFICATE B-----"];
    assert.notStrictEqual(yield* http.client, first);
  }).pipe(Effect.scoped),
);
