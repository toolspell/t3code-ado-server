// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpClient takes Node's own agents.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Only a Node agent sets the CAs it trusts.
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/http/HttpClient";

/**
 * Azure DevOps Server often runs behind a company CA or a self-signed certificate that the OS
 * trusts but Node does not. Only these requests also trust the OS store; global trust stays as
 * Node has it.
 */
function trustedCertificates(): ReadonlyArray<string> {
  const read = (store: "default" | "system") => {
    try {
      return NodeTls.getCACertificates(store);
    } catch {
      return [];
    }
  };
  return [...new Set([...read("default"), ...read("system")])];
}

export class AzureDevOpsServerHttp extends Context.Service<
  AzureDevOpsServerHttp,
  { readonly client: Effect.Effect<HttpClient.HttpClient> }
>()("@t3tools/source-control-azure-devops/server/onPrem/AzureDevOpsServerHttp") {}

/** @public */
export const make = Effect.gen(function* () {
  let current:
    | {
        readonly key: string;
        readonly client: HttpClient.HttpClient;
        readonly agents: { readonly http: NodeHttp.Agent; readonly https: NodeHttps.Agent };
      }
    | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      current?.agents.http.destroy();
      current?.agents.https.destroy();
    }),
  );

  // The desktop app adds its login shell's NODE_EXTRA_CA_CERTS after start, so the agent follows
  // the default list instead of keeping the one it started with.
  const client = Effect.gen(function* () {
    const certificates = trustedCertificates();
    const key = `${certificates.length}:${certificates.reduce((total, certificate) => total + certificate.length, 0)}`;
    if (current?.key === key) return current.client;
    const agents = {
      http: new NodeHttp.Agent({ keepAlive: true }),
      https: new NodeHttps.Agent({ keepAlive: true, ca: [...certificates] }),
    };
    const httpClient = yield* NodeHttpClient.makeNodeHttp.pipe(
      Effect.provideService(NodeHttpClient.HttpAgent, agents),
    );
    current = { key, client: httpClient, agents };
    return httpClient;
  });

  return AzureDevOpsServerHttp.of({ client });
});

export const layer = Layer.effect(AzureDevOpsServerHttp, make);
