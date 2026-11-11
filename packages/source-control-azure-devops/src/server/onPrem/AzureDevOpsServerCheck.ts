import {
  SourceControlCheckServerError,
  type SourceControlCheckServerFailure,
} from "@t3tools/contracts";
import { trimOptionalString } from "@t3tools/source-control-core/server/pullRequestUtils";
import { normalizeSourceControlServerUrl } from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";

import * as ServerDefinition from "../../shared/serverDefinition.ts";
import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import { decodeConnectionData } from "./azureDevOpsServerJson.ts";

const KIND = ServerDefinition.definition.kind;

const CHECK_FAILURE: Record<
  AzureDevOpsServerApi.AzureDevOpsServerFailure,
  SourceControlCheckServerFailure
> = {
  "not-configured": "not-configured",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  "not-found": "wrong-server",
  "rate-limited": "failed",
  "untrusted-certificate": "untrusted-certificate",
  unreachable: "unreachable",
  "unsupported-server": "unsupported-server",
  failed: "failed",
};

const COLLECTION_HINT =
  "Use the URL up to and including the collection, as clone URLs show it before the project.";

function parentUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  parsed.pathname = `/${segments.slice(0, -1).join("/")}`;
  return normalizeSourceControlServerUrl(parsed.href);
}

const collectionNames = (rows: ReadonlyArray<unknown>) =>
  rows.flatMap((row) =>
    typeof row === "object" && row !== null && "name" in row && typeof row.name === "string"
      ? (trimOptionalString(row.name) ?? [])
      : [],
  );

export const make = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;

  return Effect.fn("AzureDevOpsServerCheck.checkServer")(function* (input: {
    readonly url: string;
    readonly token: string | undefined;
  }) {
    const fail = (
      reason: SourceControlCheckServerFailure,
      detail: string,
      suggestions?: ReadonlyArray<string>,
    ) =>
      new SourceControlCheckServerError({
        provider: KIND,
        url: input.url,
        reason,
        detail,
        ...(suggestions === undefined || suggestions.length === 0 ? {} : { suggestions }),
      });
    const server = normalizeSourceControlServerUrl(input.url);
    if (server === null) {
      return yield* fail(
        "invalid-url",
        "Enter an http or https URL, such as https://tfs.example.com/DefaultCollection.",
      );
    }
    if (ServerDefinition.isAzureDevOpsServicesHost(new URL(server).hostname)) {
      return yield* fail(
        "wrong-server",
        "That is Azure DevOps Services. Its repositories use the Azure DevOps host, which signs in with `az login`.",
      );
    }
    const fromApi = (error: AzureDevOpsServerApi.AzureDevOpsServerApiError) =>
      fail(
        CHECK_FAILURE[error.reason],
        error.reason === "not-found"
          ? `Nothing at this URL answers like Azure DevOps Server. ${COLLECTION_HINT}`
          : error.detail,
      );
    const request = (path: string, preview?: boolean) =>
      api.request({
        server,
        operation: "checkServer",
        path,
        ...(preview === true ? { preview } : {}),
        ...(input.token === undefined ? {} : { token: input.token }),
      });

    const connection = decodeConnectionData(
      yield* request("_apis/connectionData", true).pipe(
        Effect.mapError((error) => {
          // A project or repository page answers with HTML, not ConnectionData.
          if (error.reason !== "failed" || error.status !== null) return fromApi(error);
          const parent = parentUrl(server);
          return fail(
            "wrong-server",
            `This URL does not answer like an Azure DevOps Server collection. ${COLLECTION_HINT}`,
            parent === null ? [] : [parent],
          );
        }),
      ),
    );
    if (connection === null) {
      return yield* fail(
        "wrong-server",
        `This URL does not answer like an Azure DevOps Server collection. ${COLLECTION_HINT}`,
      );
    }
    if (connection.deploymentType?.toLowerCase() === "hosted") {
      return yield* fail(
        "wrong-server",
        "That is Azure DevOps Services. Its repositories use the Azure DevOps host, which signs in with `az login`.",
      );
    }
    // The server itself answers too, but names no collection, and pull requests live in one.
    if (trimOptionalString(connection.webApplicationRelativeDirectory) === null) {
      const collections = yield* api
        .requestList({
          server,
          operation: "checkServer",
          path: "_apis/projectCollections",
          ...(input.token === undefined ? {} : { token: input.token }),
        })
        .pipe(
          Effect.map(collectionNames),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      return yield* fail(
        "wrong-server",
        `This is the server, not a collection. ${COLLECTION_HINT}`,
        collections.flatMap(
          (name) => normalizeSourceControlServerUrl(`${server}/${encodeURIComponent(name)}`) ?? [],
        ),
      );
    }
    yield* request("_apis/projects").pipe(Effect.mapError(fromApi));
    return {
      url: server,
      account:
        trimOptionalString(connection.authenticatedUser.providerDisplayName) ??
        connection.authenticatedUser.id,
    };
  });
});
