import type {
  PullRequestCapabilities,
  PullRequestListState,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestSummary,
  type ProviderDiffSlice,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerDefinition from "../../shared/serverDefinition.ts";
import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  byteLength,
  formatAzureDevOpsDiffCursor,
  MAX_DIFF_SLICE_BYTES,
  MAX_DIFF_SLICE_EDITS,
  MAX_DIFF_SLICE_FILES,
  MAX_FILE_DIFF_EDITS,
  parseAzureDevOpsDiffCursor,
  type AzureDevOpsFileTexts,
} from "../azureDevOpsDiff.ts";
import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  type AzureDevOpsChangeEntry,
  type AzureDevOpsItemContent,
  type AzureDevOpsIteration,
} from "../azureDevOpsPullRequestJson.ts";
import {
  AzureDevOpsServerApi,
  AzureDevOpsServerApiError,
  encodePath,
} from "./AzureDevOpsServerApi.ts";
import type { ServerRepositoryRef } from "./azureDevOpsServerConnections.ts";
import {
  decodeAccountName,
  decodeChecks,
  decodeCommits,
  decodeConnectionData,
  decodeMergeCapabilities,
  decodePullRequest,
  decodeThreads,
  pendingReviewerLogins,
  pullRequestUpdatedAt,
  reviewDecisionOf,
  type ServerPullRequest,
} from "./azureDevOpsServerJson.ts";

const KIND = ServerDefinition.definition.kind;

const DIFF_FILE_CONCURRENCY = 4;
const MAX_ITEM_READS = 2 * DIFF_FILE_CONCURRENCY;
/** List rows read their threads to learn when they last changed; the server limits the rest. */
const THREAD_READ_CONCURRENCY = 4;
const CHANGE_ENTRIES_PER_PAGE = 2000;
/** Count raw entries, including folders and malformed rows. */
const MAX_CHANGE_ENTRIES = 10_000;
const VIEWER_TTL_MS = 5 * 60_000;
const CLOSED_ACTIVITY_TTL_MS = 10 * 60_000;
const CLOSED_ACTIVITY_CAPACITY = 512;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [...ServerDefinition.definition.changeRequestActions],
  mergeMethods: [],
  search: false,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  review: { inlineComment: false, rangeComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false, searchCandidates: false },
  edit: { changeRequest: false, comment: false },
  // Azure's own viewed marks use an undocumented route and reset on every push.
  viewedFiles: "environment",
};

/** Permissions live in security namespaces a PAT with the documented scopes cannot read. */
const VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Add this server's collection URL and a personal access token in Settings → Source control → Azure DevOps Server.",
  unauthenticated:
    "The server refused the saved personal access token. Replace it in Settings → Source control → Azure DevOps Server.",
};

function failureOf(error: AzureDevOpsServerApiError): PullRequestProviderFailure {
  switch (error.reason) {
    case "not-configured":
      return { reason: "missing-tool", accessHint: error.detail };
    case "unauthenticated":
    case "forbidden":
    case "not-found":
      return { reason: error.reason };
    case "rate-limited":
      return { reason: "rate-limited", retryAt: error.retryAt };
    default:
      return { reason: "failed" };
  }
}

const STATUS_FILTER: Record<PullRequestListState, string> = {
  open: "active",
  closed: "abandoned",
  merged: "completed",
  all: "all",
};

const EMPTY_DIFF_SLICE: ProviderDiffSlice = { patch: "", truncated: false, nextCursor: null };
const EMPTY_ITEM: AzureDevOpsItemContent = { contents: "", isBinary: false };

/** Azure's items route requires a leading slash. */
const toItemPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const repositoryPath = (target: Pick<ServerRepositoryRef, "project" | "repository">) =>
  `${encodePath(target.project)}/_apis/git/repositories/${encodePath(target.repository)}`;

const pullRequestPath = (target: ServerRepositoryRef, number: number) =>
  `${repositoryPath(target)}/pullRequests/${number}`;

function toChangeRequest(pullRequest: ServerPullRequest, updatedAt: string): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    // Azure states no line counts; they would take both sides of every file.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
    mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
    updatedAt,
    reviewRequestLogins: pendingReviewerLogins(pullRequest.reviewers),
    labels: pullRequest.labels.map((name) => ({ name, color: null })),
    reviewDecision: reviewDecisionOf(pullRequest.reviewers),
  };
}

function toSummary(
  pullRequest: ServerPullRequest,
  updatedAt: string,
): ProviderChangeRequestSummary {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
    mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
    updatedAt,
    reviewDecision: reviewDecisionOf(pullRequest.reviewers),
    ...(pullRequest.headSha === null ? {} : { headSha: pullRequest.headSha }),
    autoMergeEnabled: pullRequest.autoMergeEnabled,
    ...(pullRequest.autoMergeMethod === undefined
      ? {}
      : { autoMergeMethod: pullRequest.autoMergeMethod }),
  };
}

export const make = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi;
  const itemReads = yield* Semaphore.make(MAX_ITEM_READS);
  const threadReads = yield* Semaphore.make(THREAD_READ_CONCURRENCY);

  const fail = (operation: string) => (error: AzureDevOpsServerApiError) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      ...failureOf(error),
      detail: error.detail,
      cause: error,
    });

  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: KIND,
        operation,
        reason: "failed",
        detail: "Azure DevOps Server does not support this here yet.",
      }),
    );

  const unreadable = (server: string, operation: string, detail: string) =>
    Effect.fail(
      new AzureDevOpsServerApiError({ server, operation, status: null, reason: "failed", detail }),
    );

  const locate = (input: { readonly host: string; readonly repository: string }) =>
    api.resolveRepository({ host: input.host, path: input.repository });

  const viewers = new Map<
    string,
    { readonly id: string; readonly login: string; readonly at: number }
  >();

  const viewerOf = Effect.fn("AzureDevOpsServerPullRequestProvider.viewerOf")(function* (
    server: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const held = viewers.get(server);
    if (held !== undefined && now - held.at < VIEWER_TTL_MS) return held;
    const connection = decodeConnectionData(
      yield* api.request({
        server,
        operation: "getViewer",
        path: "_apis/connectionData",
        preview: true,
      }),
    );
    if (connection === null) {
      return yield* unreadable(server, "getViewer", "The server named no signed-in user.");
    }
    const id = connection.authenticatedUser.id;
    const login =
      decodeAccountName(
        yield* api
          .requestList({
            server,
            operation: "getViewer",
            path: "_apis/identities",
            query: { identityIds: id, queryMembership: "None" },
          })
          .pipe(Effect.orElseSucceed(() => [])),
      ) ??
      connection.authenticatedUser.providerDisplayName ??
      id;
    const viewer = { id, login, at: now };
    viewers.set(server, viewer);
    return viewer;
  });

  const readPullRequest = Effect.fn("AzureDevOpsServerPullRequestProvider.readPullRequest")(
    function* (target: ServerRepositoryRef, number: number, operation: string) {
      const body = yield* api.request({
        server: target.server,
        operation,
        path: pullRequestPath(target, number),
      });
      const pullRequest = decodePullRequest(target.server, body);
      if (pullRequest !== null) return pullRequest;
      return yield* unreadable(
        target.server,
        operation,
        `Pull request ${number} could not be read.`,
      );
    },
  );

  const readThreads = (
    target: ServerRepositoryRef,
    pullRequest: ServerPullRequest,
    operation: string,
  ) =>
    threadReads.withPermits(1)(
      api
        .requestList({
          server: target.server,
          operation,
          path: `${pullRequestPath(target, pullRequest.number)}/threads`,
        })
        .pipe(Effect.map((rows) => decodeThreads(rows, pullRequest.url))),
    );

  // A closed pull request rarely changes, so a list of many need not read each one's threads.
  const closedActivity = new Map<string, { readonly updatedAt: string; readonly at: number }>();

  const updatedAtOf = Effect.fn("AzureDevOpsServerPullRequestProvider.updatedAtOf")(function* (
    target: ServerRepositoryRef,
    pullRequest: ServerPullRequest,
  ) {
    const key = `${target.server}\0${pullRequest.location.repositoryId}\0${pullRequest.number}\0${pullRequest.closedAt ?? ""}`;
    const now = yield* Clock.currentTimeMillis;
    if (pullRequest.state !== "open") {
      const held = closedActivity.get(key);
      if (held !== undefined && now - held.at < CLOSED_ACTIVITY_TTL_MS) return held.updatedAt;
    }
    const threads = yield* readThreads(target, pullRequest, "listChangeRequests");
    const updatedAt = pullRequestUpdatedAt(pullRequest, threads.lastUpdatedAt);
    if (pullRequest.state !== "open") {
      if (closedActivity.size >= CLOSED_ACTIVITY_CAPACITY) {
        const oldest = closedActivity.keys().next().value;
        if (oldest !== undefined) closedActivity.delete(oldest);
      }
      closedActivity.set(key, { updatedAt, at: now });
    }
    return updatedAt;
  });

  const listIterations = (target: ServerRepositoryRef, number: number, operation: string) =>
    api
      .requestText({
        server: target.server,
        operation,
        path: `${pullRequestPath(target, number)}/iterations`,
      })
      .pipe(
        Effect.map((text) => {
          const decoded = decodeIterationsJson(text);
          return Result.isSuccess(decoded) ? decoded.success : [];
        }),
      );

  const listIterationChanges = (
    target: ServerRepositoryRef,
    number: number,
    iterationId: number,
    operation: string,
  ) => {
    const from = (
      skip: number,
      collected: ReadonlyArray<AzureDevOpsChangeEntry>,
    ): Effect.Effect<
      { readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>; readonly truncated: boolean },
      AzureDevOpsServerApiError
    > =>
      api
        .requestText({
          server: target.server,
          operation,
          path: `${pullRequestPath(target, number)}/iterations/${iterationId}/changes`,
          query: { $top: CHANGE_ENTRIES_PER_PAGE, $skip: skip },
        })
        .pipe(
          Effect.flatMap((text) => {
            const decoded = decodeIterationChangesJson(text);
            if (!Result.isSuccess(decoded))
              return Effect.succeed({ changes: collected, truncated: true });
            const changes = [...collected, ...decoded.success.changes];
            const nextSkip = decoded.success.nextSkip;
            if (nextSkip === null) return Effect.succeed({ changes, truncated: false });
            return nextSkip <= skip || nextSkip >= MAX_CHANGE_ENTRIES
              ? Effect.succeed({ changes, truncated: true })
              : from(nextSkip, changes);
          }),
        );
    return from(0, []);
  };

  const readItemContent = (
    target: ServerRepositoryRef,
    path: string,
    commit: string,
    operation: string,
  ) =>
    itemReads.withPermits(1)(
      api
        .requestText({
          server: target.server,
          operation,
          path: `${repositoryPath(target)}/items`,
          query: {
            path: toItemPath(path),
            "versionDescriptor.versionType": "commit",
            "versionDescriptor.version": commit,
            includeContent: true,
            // Encoded content cannot identify binaries; Azure's metadata can.
            includeContentMetadata: true,
            $format: "json",
          },
        })
        .pipe(
          Effect.map((text) => {
            const decoded = decodeItemContentJson(text);
            return Result.isSuccess(decoded) ? decoded.success : EMPTY_ITEM;
          }),
        ),
    );

  /** Azure fails reads of absent files. */
  const readTexts = (input: {
    readonly target: ServerRepositoryRef;
    readonly iteration: AzureDevOpsIteration;
    readonly change: Pick<AzureDevOpsChangeEntry, "changeKind" | "path" | "oldPath">;
    readonly operation: string;
  }) =>
    Effect.all(
      [
        input.change.changeKind === "new"
          ? Effect.succeed(EMPTY_ITEM)
          : readItemContent(
              input.target,
              input.change.oldPath,
              input.iteration.mergeBaseCommit,
              input.operation,
            ),
        input.change.changeKind === "deleted"
          ? Effect.succeed(EMPTY_ITEM)
          : readItemContent(
              input.target,
              input.change.path,
              input.iteration.headCommit,
              input.operation,
            ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([oldItem, newItem]): AzureDevOpsFileTexts => ({
        oldContents: oldItem.contents,
        newContents: newItem.contents,
        binary: oldItem.isBinary || newItem.isBinary,
      })),
    );

  const readChecks = (target: ServerRepositoryRef, pullRequest: ServerPullRequest) =>
    Effect.all(
      [
        api
          .requestList({
            server: target.server,
            operation: "getChangeRequestChecks",
            path: `${encodePath(pullRequest.location.project)}/_apis/policy/evaluations`,
            query: {
              artifactId: `vstfs:///CodeReview/CodeReviewId/${pullRequest.location.projectId}/${pullRequest.number}`,
            },
            preview: true,
          })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<unknown> => [])),
        api
          .requestList({
            server: target.server,
            operation: "getChangeRequestChecks",
            path: `${pullRequestPath(target, pullRequest.number)}/statuses`,
          })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<unknown> => [])),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([policyEvaluations, statuses]) => ({
        checks: decodeChecks({
          collectionUrl: target.server,
          project: pullRequest.location.project,
          policyEvaluations,
          statuses,
        }),
        mergeCapabilities: decodeMergeCapabilities(policyEvaluations),
      })),
    );

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    // Repository names repeat across projects and collections; the full path does not.
    repositoryKey: ({ canonicalKey }) => canonicalKey,

    getViewer: Effect.fn("AzureDevOpsServerPullRequestProvider.getViewer")(function* (input) {
      const servers = yield* api.servers;
      const server =
        servers.find(
          (candidate) =>
            input.host === undefined ||
            URL.parse(candidate)?.hostname.toLowerCase() === input.host.toLowerCase(),
        ) ?? null;
      if (server === null) {
        return yield* new PullRequestProviderError({
          provider: KIND,
          operation: "getViewer",
          reason: "missing-tool",
          detail: UNAVAILABLE_REQUIREMENT.missing,
        });
      }
      return (yield* viewerOf(server).pipe(Effect.mapError(fail("getViewer")))).login;
    }),

    listChangeRequests: Effect.fn("AzureDevOpsServerPullRequestProvider.listChangeRequests")(
      function* (input) {
        const target = yield* locate(input);
        const viewer = input.involvement === "all" ? null : yield* viewerOf(target.server);
        const skip = input.cursor?.delivered ?? 0;
        const top = input.limit + 1;
        const rows = yield* api.requestList({
          server: target.server,
          operation: "listChangeRequests",
          path: `${repositoryPath(target)}/pullrequests`,
          query: {
            "searchCriteria.status": STATUS_FILTER[input.state],
            ...(viewer !== null && input.involvement === "authored"
              ? { "searchCriteria.creatorId": viewer.id }
              : {}),
            ...(viewer !== null && input.involvement === "reviewing"
              ? { "searchCriteria.reviewerId": viewer.id }
              : {}),
            $top: top,
            ...(skip === 0 ? {} : { $skip: skip }),
          },
        });
        const decoded = rows.flatMap((row, index) => {
          const pullRequest = decodePullRequest(target.server, row);
          return pullRequest === null ? [] : [{ pullRequest, index }];
        });
        const kept = decoded.slice(0, input.limit);
        const consumed = kept.length < input.limit ? rows.length : (kept.at(-1)?.index ?? -1) + 1;
        const items = yield* Effect.forEach(
          kept,
          ({ pullRequest }) =>
            updatedAtOf(target, pullRequest).pipe(
              // One unreadable conversation must not hide the whole list.
              Effect.orElseSucceed(() => pullRequestUpdatedAt(pullRequest, null)),
              Effect.map((updatedAt) => toChangeRequest(pullRequest, updatedAt)),
            ),
          { concurrency: THREAD_READ_CONCURRENCY },
        );
        return {
          items,
          truncated: rows.length === top || consumed < rows.length,
          cursorAdvance: consumed,
          // Azure orders by creation, which offset pages keep stable.
          continues: true,
        };
      },
      Effect.mapError(fail("listChangeRequests")),
    ),

    getChangeRequestPreview: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestPreview",
    )(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(target, input.number, "getChangeRequestPreview");
        return {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          createdAt: pullRequest.createdAt,
        };
      },
      Effect.mapError(fail("getChangeRequestPreview")),
    ),

    getChangeRequestSummary: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestSummary",
    )(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(target, input.number, "getChangeRequestSummary");
        const threads = yield* readThreads(target, pullRequest, "getChangeRequestSummary");
        return toSummary(pullRequest, pullRequestUpdatedAt(pullRequest, threads.lastUpdatedAt));
      },
      Effect.mapError(fail("getChangeRequestSummary")),
    ),

    getChangeRequestChecks: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestChecks",
    )(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(target, input.number, "getChangeRequestChecks");
        const { checks } = yield* readChecks(target, pullRequest);
        return { state: pullRequest.state, checks };
      },
      Effect.mapError(fail("getChangeRequestChecks")),
    ),

    getChangeRequest: Effect.fn("AzureDevOpsServerPullRequestProvider.getChangeRequest")(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(target, input.number, "getChangeRequest");
        const [threads, iterations, checks] = yield* Effect.all(
          [
            readThreads(target, pullRequest, "getChangeRequest"),
            listIterations(target, input.number, "getChangeRequest").pipe(
              Effect.orElseSucceed((): ReadonlyArray<AzureDevOpsIteration> => []),
            ),
            readChecks(target, pullRequest),
          ],
          { concurrency: 3 },
        );
        const latest = iterations.at(-1);
        const changedFiles =
          latest === undefined
            ? 0
            : yield* listIterationChanges(target, input.number, latest.id, "getChangeRequest").pipe(
                Effect.map((listed) => listed.changes.length),
                Effect.orElseSucceed(() => 0),
              );
        const detail: ProviderChangeRequestDetail = {
          ...toChangeRequest(pullRequest, pullRequestUpdatedAt(pullRequest, threads.lastUpdatedAt)),
          body: pullRequest.body,
          // The trial merge's source commit can lag behind a new push; the iteration cannot.
          headSha: latest?.headCommit ?? pullRequest.headSha,
          changedFiles,
          mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
          closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
          reviewers: pullRequest.reviewers.map(({ login, name, avatarUrl }) => ({
            login,
            name,
            avatarUrl,
          })),
          checks: checks.checks,
          mergeCapabilities: checks.mergeCapabilities,
          viewerPermissions: VIEWER_PERMISSIONS,
          autoMergeEnabled: pullRequest.autoMergeEnabled,
          ...(pullRequest.autoMergeMethod === undefined
            ? {}
            : { autoMergeMethod: pullRequest.autoMergeMethod }),
        };
        return detail;
      },
      Effect.mapError(fail("getChangeRequest")),
    ),

    getChangeRequestActivity: Effect.fn(
      "AzureDevOpsServerPullRequestProvider.getChangeRequestActivity",
    )(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(
          target,
          input.number,
          "getChangeRequestActivity",
        );
        const [threads, commits] = yield* Effect.all(
          [
            readThreads(target, pullRequest, "getChangeRequestActivity").pipe(Effect.result),
            api
              .requestList({
                server: target.server,
                operation: "getChangeRequestActivity",
                path: `${pullRequestPath(target, input.number)}/commits`,
              })
              .pipe(
                Effect.map(decodeCommits),
                Effect.orElseSucceed(() => []),
              ),
          ],
          { concurrency: 2 },
        );
        const conversation = Result.isSuccess(threads) ? threads.success : null;
        const activity: ProviderChangeRequestActivity = {
          author: pullRequest.author,
          comments: conversation?.comments ?? [],
          commentCount: conversation?.comments.length ?? 0,
          commentsTruncated: conversation === null,
          reviewThreads: conversation?.reviewThreads ?? [],
          overviewThreads: conversation?.overviewThreads ?? [],
          commits,
        };
        return activity;
      },
      Effect.mapError(fail("getChangeRequestActivity")),
    ),

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    // Azure states which commits a pull request has, but not a diff per commit, so the Code tab
    // always shows the whole change.
    getDiff: Effect.fn("AzureDevOpsServerPullRequestProvider.getDiff")(
      function* (input) {
        const target = yield* locate(input);
        const iterations = yield* listIterations(target, input.number, "getDiff");
        const cursor = parseAzureDevOpsDiffCursor(input.cursor);
        const iteration =
          cursor === null
            ? iterations.at(-1)
            : iterations.find((candidate) => candidate.id === cursor.iterationId);
        if (iteration === undefined) return EMPTY_DIFF_SLICE;
        const listed = yield* listIterationChanges(target, input.number, iteration.id, "getDiff");
        const changes = listed.changes;

        const sections: string[] = [];
        let truncated = listed.truncated;
        let bytes = 0;
        let edits = 0;
        let index = cursor?.fileIndex ?? 0;
        let full = false;
        // Prefetched files beyond the slice must be read again.
        const batchWidth = () => {
          if (sections.length === 0) return DIFF_FILE_CONCURRENCY;
          const admits = (left: number, spent: number) =>
            Math.ceil(left / Math.max(1, spent / sections.length));
          return Math.max(
            1,
            Math.min(
              DIFF_FILE_CONCURRENCY,
              MAX_DIFF_SLICE_FILES - sections.length,
              admits(MAX_DIFF_SLICE_BYTES - bytes, bytes),
              admits(MAX_DIFF_SLICE_EDITS - MAX_FILE_DIFF_EDITS - edits, edits),
            ),
          );
        };
        while (!full && index < changes.length) {
          const batch = changes.slice(index, index + batchWidth());
          const read = yield* Effect.forEach(
            batch,
            (change) =>
              readTexts({ target, iteration, change, operation: "getDiff" }).pipe(
                // Credential and throttling failures must reach the caller; a missing file must not.
                Effect.catchIf(
                  (error) => error.reason === "not-found" || error.reason === "failed",
                  () => Effect.succeed(null),
                ),
                Effect.map((texts) => ({ change, texts })),
              ),
            { concurrency: DIFF_FILE_CONCURRENCY },
          );
          for (const { change, texts } of read) {
            // Synchronous diffs need yields to let other server work run.
            yield* Effect.yieldNow;
            const file =
              texts === null
                ? azureDevOpsUnreadableFilePatch(change)
                : azureDevOpsFilePatch({ change, texts });
            sections.push(file.section);
            bytes += byteLength(file.section);
            edits += file.edits;
            truncated = truncated || file.truncated;
            index += 1;
            // Add a file before checking budgets so oversized files cannot stall the cursor.
            if (
              bytes >= MAX_DIFF_SLICE_BYTES ||
              edits + MAX_FILE_DIFF_EDITS > MAX_DIFF_SLICE_EDITS ||
              sections.length >= MAX_DIFF_SLICE_FILES ||
              file.abandoned
            ) {
              full = true;
              break;
            }
          }
        }
        const slice: ProviderDiffSlice = {
          patch: sections.join(""),
          truncated,
          nextCursor:
            index >= changes.length
              ? null
              : formatAzureDevOpsDiffCursor({ iterationId: iteration.id, fileIndex: index }),
        };
        return slice;
      },
      Effect.mapError(fail("getDiff")),
    ),

    getDiffFileContents: Effect.fn("AzureDevOpsServerPullRequestProvider.getDiffFileContents")(
      function* (input) {
        const target = yield* locate(input);
        const iteration = (yield* listIterations(target, input.number, "getDiffFileContents")).at(
          -1,
        );
        if (iteration === undefined) return { oldContents: "", newContents: "" };
        return yield* readTexts({
          target,
          iteration,
          change: { changeKind: input.changeType, path: input.newPath, oldPath: input.oldPath },
          operation: "getDiffFileContents",
        });
      },
      Effect.mapError(fail("getDiffFileContents")),
    ),

    /**
     * A path the change does not carry is at the empty revision, where a file the pull request
     * deletes sits. When the change was too long to read to its end, those paths stay out:
     * reporting them as deleted would clear a file nobody has read.
     */
    getFileRevisions: Effect.fn("AzureDevOpsServerPullRequestProvider.getFileRevisions")(
      function* (input) {
        const revisions = new Map<string, string>();
        if (input.paths.length === 0) return { revisions };
        const target = yield* locate(input);
        const latest = (yield* listIterations(target, input.number, "getFileRevisions")).at(-1);
        if (latest === undefined) return { revisions };
        const listed = yield* listIterationChanges(
          target,
          input.number,
          latest.id,
          "getFileRevisions",
        );
        const marked = new Set(input.paths);
        for (const change of listed.changes) {
          if (!marked.has(change.path) || change.objectId === null) continue;
          revisions.set(change.path, change.objectId);
        }
        if (!listed.truncated) {
          for (const path of input.paths) {
            if (!revisions.has(path)) revisions.set(path, "");
          }
        }
        return { revisions };
      },
      Effect.mapError(fail("getFileRevisions")),
    ),

    forgetChangeRequestReads: (scope) =>
      Effect.sync(() => {
        if (scope === undefined) {
          closedActivity.clear();
          viewers.clear();
          return;
        }
        for (const key of closedActivity.keys()) {
          const [, , number] = key.split("\0");
          if (scope.number === undefined || number === String(scope.number))
            closedActivity.delete(key);
        }
      }),

    runAction: () => unsupported("runAction"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    replyToThread: () => unsupported("replyToThread"),
    setThreadResolution: () => unsupported("setThreadResolution"),
    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
