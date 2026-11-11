import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
  type SourceControlProviderAuth,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import {
  normalizeRefName,
  trimOptionalString,
} from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  parseGitRemoteHost,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerDefinition from "../../shared/serverDefinition.ts";
import {
  AzureDevOpsServerApi,
  AzureDevOpsServerApiError,
  encodePath,
} from "./AzureDevOpsServerApi.ts";
import type { ServerRepositoryRef } from "./azureDevOpsServerConnections.ts";
import {
  decodeConnectionData,
  decodePullRequest,
  decodePullRequests,
  decodeRepository,
  latestTime,
  type ServerPullRequest,
} from "./azureDevOpsServerJson.ts";

const KIND = ServerDefinition.definition.kind;
const isApiError = Schema.is(AzureDevOpsServerApiError);
/** Each server gets its own budget inside discovery's three seconds. */
const PROBE_TIMEOUT = Duration.millis(2_500);

const STATUS_FILTER: Record<ChangeRequestState | "all", string> = {
  open: "active",
  closed: "abandoned",
  merged: "completed",
  all: "all",
};

const repositoryPath = (target: Pick<ServerRepositoryRef, "project" | "repository">) =>
  `${encodePath(target.project)}/_apis/git/repositories/${encodePath(target.repository)}`;

function toChangeRequest(pullRequest: ServerPullRequest): ChangeRequest {
  const updatedAt = latestTime(pullRequest.createdAt, pullRequest.closedAt);
  return {
    provider: KIND,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseRefName: pullRequest.baseBranch,
    headRefName: pullRequest.headBranch,
    ...(pullRequest.headSha === null ? {} : { headSha: pullRequest.headSha }),
    state: pullRequest.state,
    ...(pullRequest.isDraft ? { isDraft: true } : {}),
    closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
    mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
    updatedAt: updatedAt === null ? Option.none() : DateTime.make(updatedAt),
    isCrossRepository: pullRequest.isCrossRepository,
  };
}

/** A pull request number, `#12`, or a pull request URL. */
function pullRequestNumberOf(reference: string): number | null {
  const trimmed = reference.trim();
  const url = URL.parse(trimmed);
  const number =
    url === null
      ? Number(trimmed.replace(/^#/u, ""))
      : (ServerDefinition.definition.parseChangeRequestUrl(url)?.number ?? Number.NaN);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export const make = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const { git } = host;

  const providerError =
    (
      operation: string,
      cwd: string,
      extra?: { readonly reference?: string; readonly repository?: string },
    ) =>
    (cause: unknown) =>
      new SourceControlProviderError({
        provider: KIND,
        operation,
        cwd,
        ...(extra?.reference === undefined
          ? {}
          : {
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                extra.reference,
              ),
            }),
        ...(extra?.repository === undefined
          ? {}
          : {
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                extra.repository,
              ),
            }),
        detail: isApiError(cause) ? cause.detail : `Azure DevOps Server ${operation} failed.`,
        cause,
      });

  const remoteOf = Effect.fn("AzureDevOpsServerSourceControlProvider.remoteOf")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    if (input.context?.provider.kind === KIND) {
      return { name: input.context.remoteName, url: input.context.remoteUrl };
    }
    const remotes = yield* yield* git.remotes(input.cwd);
    const remote = remotes.remotes.find(
      (candidate) => recognizeRemoteWith(ServerDefinition.definition, candidate.url) !== null,
    );
    if (remote !== undefined) return { name: remote.name, url: remote.url };
    return yield* new AzureDevOpsServerApiError({
      server: input.cwd,
      operation: "resolveRepository",
      status: null,
      reason: "not-configured",
      detail: "No remote of this checkout is on an Azure DevOps Server.",
    });
  });

  const targetOf = Effect.fn("AzureDevOpsServerSourceControlProvider.targetOf")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    const remote = yield* remoteOf(input);
    const remoteHost = parseGitRemoteHost(remote.url);
    const path = SourceControlProvider.repositoryPathFromRemoteUrl(remote.url);
    if (remoteHost === null || path === null) {
      return yield* new AzureDevOpsServerApiError({
        server: remote.url,
        operation: "resolveRepository",
        status: null,
        reason: "not-configured",
        detail: "The remote names no Azure DevOps Server repository.",
      });
    }
    const target = yield* api.resolveRepository({ host: remoteHost.hostname, path });
    return { target, remote };
  });

  const readPullRequest = Effect.fn("AzureDevOpsServerSourceControlProvider.readPullRequest")(
    function* (target: ServerRepositoryRef, reference: string, operation: string) {
      const number = pullRequestNumberOf(reference);
      const pullRequest =
        number === null
          ? null
          : decodePullRequest(
              target.server,
              yield* api.request({
                server: target.server,
                operation,
                path: `${repositoryPath(target)}/pullRequests/${number}`,
              }),
            );
      if (pullRequest !== null) return pullRequest;
      return yield* new AzureDevOpsServerApiError({
        server: target.server,
        operation,
        status: null,
        reason: "not-found",
        detail: `No pull request ${reference} could be read.`,
      });
    },
  );

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    // Fork pull requests are listed by source branch with no owner filter.
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
      limit: 100,
    }),

    listChangeRequests: Effect.fn("AzureDevOpsServerSourceControlProvider.listChangeRequests")(
      function* (input) {
        const { target } = yield* targetOf(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const rows = yield* api.requestList({
          server: target.server,
          operation: "listChangeRequests",
          path: `${repositoryPath(target)}/pullrequests`,
          query: {
            "searchCriteria.status": STATUS_FILTER[input.state],
            "searchCriteria.sourceRefName": `refs/heads/${branch}`,
            $top: input.limit ?? 20,
          },
        });
        return decodePullRequests(target.server, rows).map(toChangeRequest);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("listChangeRequests", input.cwd, { reference: input.headSelector }),
          ),
        ),
    ),

    getChangeRequest: Effect.fn("AzureDevOpsServerSourceControlProvider.getChangeRequest")(
      function* (input) {
        const { target } = yield* targetOf(input);
        return toChangeRequest(yield* readPullRequest(target, input.reference, "getChangeRequest"));
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("getChangeRequest", input.cwd, { reference: input.reference }),
          ),
        ),
    ),

    createChangeRequest: Effect.fn("AzureDevOpsServerSourceControlProvider.createChangeRequest")(
      function* (input) {
        const { target } = yield* targetOf(input);
        const description = yield* fileSystem.readFileString(input.bodyFile);
        yield* api.request({
          server: target.server,
          operation: "createChangeRequest",
          method: "POST",
          path: `${repositoryPath(target)}/pullrequests`,
          body: {
            sourceRefName: `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
            targetRefName: `refs/heads/${input.target?.refName ?? input.baseRefName}`,
            title: input.title,
            description,
          },
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("createChangeRequest", input.cwd, { reference: input.headSelector }),
          ),
        ),
    ),

    getRepositoryCloneUrls: Effect.fn(
      "AzureDevOpsServerSourceControlProvider.getRepositoryCloneUrls",
    )(
      function* (input) {
        const target =
          input.host === undefined
            ? (yield* targetOf(input)).target
            : yield* api.resolveRepository({ host: input.host, path: input.repository });
        const repository = decodeRepository(
          yield* api.request({
            server: target.server,
            operation: "getRepositoryCloneUrls",
            path: repositoryPath(target),
          }),
        );
        const url = trimOptionalString(repository?.remoteUrl);
        if (repository === null || url === null) {
          return yield* new AzureDevOpsServerApiError({
            server: target.server,
            operation: "getRepositoryCloneUrls",
            status: null,
            reason: "not-found",
            detail: "The server named no clone URL for the repository.",
          });
        }
        return {
          nameWithOwner: `${repository.project.name}/${repository.name}`,
          url,
          sshUrl: trimOptionalString(repository.sshUrl) ?? url,
        };
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("getRepositoryCloneUrls", input.cwd, { repository: input.repository }),
          ),
        ),
    ),

    createRepository: Effect.fn("AzureDevOpsServerSourceControlProvider.createRepository")(
      function* (input) {
        return yield* new SourceControlProviderError({
          provider: KIND,
          operation: "createRepository",
          cwd: input.cwd,
          detail: "Create the repository on your Azure DevOps Server, then add it as a remote.",
        });
      },
    ),

    getDefaultBranch: Effect.fn("AzureDevOpsServerSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const { target } = yield* targetOf(input);
        const repository = decodeRepository(
          yield* api.request({
            server: target.server,
            operation: "getDefaultBranch",
            path: repositoryPath(target),
          }),
        );
        const branch = trimOptionalString(repository?.defaultBranch);
        return branch === null ? null : normalizeRefName(branch);
      },
      (effect, input) => effect.pipe(Effect.mapError(providerError("getDefaultBranch", input.cwd))),
    ),

    checkoutChangeRequest: Effect.fn(
      "AzureDevOpsServerSourceControlProvider.checkoutChangeRequest",
    )(
      function* (input) {
        const { target, remote } = yield* targetOf(input);
        const pullRequest = yield* readPullRequest(
          target,
          input.reference,
          "checkoutChangeRequest",
        );
        if (pullRequest.isCrossRepository) {
          return yield* new AzureDevOpsServerApiError({
            server: target.server,
            operation: "checkoutChangeRequest",
            status: null,
            reason: "failed",
            detail: "Pull requests from forks cannot be checked out here yet.",
          });
        }
        const branch = pullRequest.headBranch;
        const localBranches = yield* git.listLocalBranchNames(input.cwd);
        if (input.force === true || !localBranches.includes(branch)) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName: remote.name,
            remoteBranch: branch,
            localBranch: branch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName: remote.name,
            remoteBranch: branch,
          });
        }
        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch,
          remoteName: remote.name,
          remoteBranch: branch,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: branch }));
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("checkoutChangeRequest", input.cwd, { reference: input.reference }),
          ),
        ),
    ),
  });
});

/** One account per configured server, so a server that refuses its token shows on its own. */
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi;

  const probeServer = (server: string) =>
    api
      .request({ server, operation: "probeAuth", path: "_apis/connectionData", preview: true })
      .pipe(
        Effect.map(decodeConnectionData),
        Effect.timeout(PROBE_TIMEOUT),
        Effect.match({
          onFailure: (error) => ({
            host: server,
            account: URL.parse(server)?.hostname ?? server,
            active: true,
            authenticated: false,
            error: isApiError(error) ? error.detail : "The server did not answer in time.",
          }),
          onSuccess: (connection) => ({
            host: server,
            account:
              trimOptionalString(connection?.authenticatedUser.providerDisplayName) ??
              connection?.authenticatedUser.id ??
              server,
            active: true,
            authenticated: connection !== null,
          }),
        }),
      );

  const probeAuth: Effect.Effect<SourceControlProviderAuth> = Effect.gen(function* () {
    const servers = yield* api.servers;
    if (servers.length === 0) {
      return providerAuth({
        status: "unauthenticated",
        detail: "Add a server in Settings → Source control → Azure DevOps Server.",
      });
    }
    const accounts = yield* Effect.forEach(servers, probeServer, { concurrency: "unbounded" });
    const signedIn = accounts.filter((account) => account.authenticated);
    const first = signedIn[0];
    const auth = providerAuth({
      status: first === undefined ? "unauthenticated" : "authenticated",
      account: first?.account,
      host: first?.host,
      detail:
        signedIn.length === accounts.length
          ? undefined
          : `${signedIn.length} of ${accounts.length} servers signed in.`,
    });
    return { ...auth, accounts };
  });

  return {
    type: "api",
    kind: KIND,
    label: ServerDefinition.definition.label,
    installHint: "Add a server and a personal access token in Settings → Source control.",
    probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});
