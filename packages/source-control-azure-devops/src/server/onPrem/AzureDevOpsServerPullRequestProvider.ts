import type {
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewVerdict,
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
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { normalizeRefName } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import type { ServerRepositoryRef } from "./azureDevOpsServerConnections.ts";
import {
  decodeAccountName,
  decodeChecks,
  decodeCommits,
  decodeChangeTrackingIds,
  decodeCommentContent,
  decodeConnectionData,
  decodeIdentityIds,
  decodeIdentityNames,
  decodeMergeCapabilities,
  decodePullRequest,
  decodeRefObjectId,
  decodeRefUpdateFailure,
  decodeRepository,
  decodeRootCommentId,
  decodeThreads,
  mentionedIdentityIds,
  mentionIdsIn,
  pendingReviewerLogins,
  pullRequestUpdatedAt,
  reviewDecisionOf,
  type ServerPullRequest,
  restoreMentions,
  type ServerThreads,
  withMentionNames,
} from "./azureDevOpsServerJson.ts";

const KIND = ServerDefinition.definition.kind;
const isProviderError = Schema.is(PullRequestProviderError);

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
const MAX_LIST_PAGES = 5;
const COMPLETION_POLL = "500 millis";
const COMPLETION_POLLS = 10;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...ServerDefinition.definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  search: false,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  // Identity search on Azure DevOps Server matches whole names only, so there is no picker yet.
  reviewers: { request: true, listCandidates: false, searchCandidates: false },
  edit: { changeRequest: true, comment: true },
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

function failureOf(
  error: AzureDevOpsServerApi.AzureDevOpsServerApiError,
): PullRequestProviderFailure {
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

/**
 * A source of checks that cannot be read shows as unread, except when the token stopped working or
 * the server asked to slow down: those must reach the caller, which backs off or asks to sign in.
 */
const unreadUnlessUrgent = <A>(
  read: Effect.Effect<A, AzureDevOpsServerApi.AzureDevOpsServerApiError>,
) =>
  read.pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason !== "rate-limited" && error.reason !== "unauthenticated",
      () => Effect.succeedNone,
    ),
  );

const IDENTITY_NAME_CAPACITY = 1024;
/** Past any line's end, so a comment covers its last line whole. */
const LINE_END_OFFSET = 100_000;

const VOTES: Record<PullRequestReviewVerdict, number | undefined> = {
  approve: 10,
  // "Waiting for the author", which keeps the pull request from completing.
  "request-changes": -5,
  comment: undefined,
};

function positionLine(position: PullRequestReviewPosition): {
  readonly side: "right" | "left";
  readonly line: number;
} {
  switch (position.kind) {
    case "added":
      return { side: "right", line: position.newLine };
    case "deleted":
      return { side: "left", line: position.oldLine };
    case "context":
      return position.side === "left"
        ? { side: "left", line: position.oldLine }
        : { side: "right", line: position.newLine };
  }
}

/** The file and lines a review comment covers, on the side its last line is on. */
export function threadContextOf(draft: PullRequestReviewCommentDraft) {
  const end = positionLine(draft.position);
  const start = draft.startPosition === undefined ? end : positionLine(draft.startPosition);
  const first = start.side === end.side && start.line <= end.line ? start.line : end.line;
  const path = end.side === "left" ? (draft.oldPath ?? draft.path) : draft.path;
  return {
    filePath: path.startsWith("/") ? path : `/${path}`,
    [`${end.side}FileStart`]: { line: first, offset: 1 },
    [`${end.side}FileEnd`]: { line: end.line, offset: LINE_END_OFFSET },
  };
}

const unreadChecks = (name: string): PullRequestCheck => ({
  name,
  status: "pending",
  description: `Azure DevOps Server could not list the ${name.toLowerCase()}.`,
  url: null,
  placeholder: true,
});

const EMPTY_DIFF_SLICE: ProviderDiffSlice = { patch: "", truncated: false, nextCursor: null };
const EMPTY_ITEM: AzureDevOpsItemContent = { contents: "", isBinary: false };

/** Azure's items route requires a leading slash. */
const toItemPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const repositoryPath = (target: Pick<ServerRepositoryRef, "project" | "repository">) =>
  `${AzureDevOpsServerApi.encodePath(target.project)}/_apis/git/repositories/${AzureDevOpsServerApi.encodePath(target.repository)}`;

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
  const api = yield* AzureDevOpsServerApi.AzureDevOpsServerApi;
  const itemReads = yield* Semaphore.make(MAX_ITEM_READS);
  const threadReads = yield* Semaphore.make(THREAD_READ_CONCURRENCY);

  const fail = (operation: string) => (error: AzureDevOpsServerApi.AzureDevOpsServerApiError) =>
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
      new AzureDevOpsServerApi.AzureDevOpsServerApiError({
        server,
        operation,
        status: null,
        reason: "failed",
        detail,
      }),
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
    viewerId?: string,
  ) =>
    threadReads.withPermits(1)(
      api
        .requestList({
          server: target.server,
          operation,
          path: `${pullRequestPath(target, pullRequest.number)}/threads`,
        })
        .pipe(Effect.map((rows) => decodeThreads(rows, pullRequest.url, viewerId))),
    );

  // A closed pull request rarely changes, so a list of many need not read each one's threads.
  const closedActivity = new Map<string, { readonly updatedAt: string; readonly at: number }>();
  const activityKey = (target: ServerRepositoryRef, pullRequest: ServerPullRequest) =>
    `${target.server}\0${pullRequest.location.repositoryId}\0${pullRequest.number}\0${pullRequest.closedAt ?? ""}`;

  /** Dates a pull request by its threads and keeps a closed one's date for the list. */
  const datedBy = Effect.fn("AzureDevOpsServerPullRequestProvider.datedBy")(function* (
    target: ServerRepositoryRef,
    pullRequest: ServerPullRequest,
    threadsUpdatedAt: string | null,
  ) {
    const updatedAt = pullRequestUpdatedAt(pullRequest, threadsUpdatedAt);
    if (pullRequest.state !== "open") {
      const now = yield* Clock.currentTimeMillis;
      if (closedActivity.size >= CLOSED_ACTIVITY_CAPACITY) {
        const oldest = closedActivity.keys().next().value;
        if (oldest !== undefined) closedActivity.delete(oldest);
      }
      closedActivity.set(activityKey(target, pullRequest), { updatedAt, at: now });
    }
    return updatedAt;
  });

  const updatedAtOf = Effect.fn("AzureDevOpsServerPullRequestProvider.updatedAtOf")(function* (
    target: ServerRepositoryRef,
    pullRequest: ServerPullRequest,
  ) {
    if (pullRequest.state !== "open") {
      const now = yield* Clock.currentTimeMillis;
      const held = closedActivity.get(activityKey(target, pullRequest));
      if (held !== undefined && now - held.at < CLOSED_ACTIVITY_TTL_MS) return held.updatedAt;
    }
    const threads = yield* readThreads(target, pullRequest, "listChangeRequests");
    return yield* datedBy(target, pullRequest, threads.lastUpdatedAt);
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
      AzureDevOpsServerApi.AzureDevOpsServerApiError
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
          Effect.flatMap((text) => {
            const decoded = decodeItemContentJson(text);
            // A false empty file would show the whole file as added or deleted.
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : unreadable(target.server, operation, `${path} could not be read.`);
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
            path: `${AzureDevOpsServerApi.encodePath(pullRequest.location.project)}/_apis/policy/evaluations`,
            query: {
              artifactId: `vstfs:///CodeReview/CodeReviewId/${pullRequest.location.projectId}/${pullRequest.number}`,
            },
            preview: true,
          })
          .pipe(unreadUnlessUrgent),
        api
          .requestList({
            server: target.server,
            operation: "getChangeRequestChecks",
            path: `${pullRequestPath(target, pullRequest.number)}/statuses`,
          })
          .pipe(unreadUnlessUrgent),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([policyEvaluations, statuses]) => ({
        checks: [
          ...decodeChecks({
            collectionUrl: target.server,
            project: pullRequest.location.project,
            policyEvaluations: Option.getOrElse(policyEvaluations, () => []),
            statuses: Option.getOrElse(statuses, () => []),
          }),
          // An unread source must not let the rest pass for every check there is.
          ...(Option.isNone(policyEvaluations) ? [unreadChecks("Branch policies")] : []),
          ...(Option.isNone(statuses) ? [unreadChecks("Pull request statuses")] : []),
        ],
        mergeCapabilities: Option.match(policyEvaluations, {
          onNone: () => ({ merge: true, squash: true, rebase: true }),
          onSome: decodeMergeCapabilities,
        }),
      })),
    );

  /** An account name such as `DOMAIN\user`, which identity search matches only whole. */
  const identityIdOf = Effect.fn("AzureDevOpsServerPullRequestProvider.identityIdOf")(function* (
    server: string,
    login: string,
  ) {
    const rows = yield* api.requestList({
      server,
      operation: "setReviewerRequest",
      path: "_apis/identities",
      query: {
        searchFilter: login.includes("\\") ? "AccountName" : "General",
        filterValue: login,
        queryMembership: "None",
      },
    });
    const id = decodeIdentityIds(rows)[0];
    if (id !== undefined) return id;
    return yield* new AzureDevOpsServerApi.AzureDevOpsServerApiError({
      server,
      operation: "setReviewerRequest",
      status: null,
      reason: "not-found",
      detail: `No one named ${login} on this server.`,
    });
  });

  const completionOptions = (
    pullRequest: ServerPullRequest,
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) => ({
    mergeStrategy:
      input.mergeMethod === "squash"
        ? "squash"
        : input.mergeMethod === "rebase"
          ? "rebase"
          : "noFastForward",
    // Azure's own message for a completed pull request, minus agent credits when asked.
    ...(input.removeAgentCreditsOnMerge === true
      ? {
          mergeCommitMessage: removeAgentCredits(
            `Merged PR ${pullRequest.number}: ${pullRequest.title}\n\n${pullRequest.body}`,
          ).trim(),
        }
      : {}),
  });

  const actionBody = Effect.fn("AzureDevOpsServerPullRequestProvider.actionBody")(function* (
    target: ServerRepositoryRef,
    pullRequest: ServerPullRequest,
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    switch (input.action) {
      case "ready":
        return { isDraft: false };
      case "draft":
        return { isDraft: true };
      case "close":
        return { status: "abandoned" };
      case "reopen":
        return { status: "active" };
      case "merge": {
        if (pullRequest.headSha === null) {
          return yield* unreadable(
            target.server,
            "runAction:merge",
            "The pull request names no head commit.",
          );
        }
        // The head the reader saw, so a push since then fails the completion instead of landing.
        return {
          status: "completed",
          lastMergeSourceCommit: { commitId: pullRequest.headSha },
          completionOptions: completionOptions(pullRequest, input),
        };
      }
      case "enable-auto-merge": {
        const viewer = yield* viewerOf(target.server);
        return {
          autoCompleteSetBy: { id: viewer.id },
          completionOptions: completionOptions(pullRequest, input),
        };
      }
      case "disable-auto-merge":
        return { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } };
      default:
        return yield* new PullRequestProviderError({
          provider: KIND,
          operation: "runAction",
          reason: "failed",
          detail: `Azure DevOps Server cannot ${input.action} here.`,
        });
    }
  });

  const awaitCompletion = (target: ServerRepositoryRef, number: number, operation: string) =>
    readPullRequest(target, number, operation).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(COMPLETION_POLL),
        times: COMPLETION_POLLS,
        until: (pullRequest) =>
          pullRequest.state !== "open" || pullRequest.mergeability === "conflicting",
      }),
    );

  /** Deletes only the commit the pull request ended at, so later pushes and shared branches stay. */
  const deleteSourceBranch = Effect.fn("AzureDevOpsServerPullRequestProvider.deleteSourceBranch")(
    function* (target: ServerRepositoryRef, pullRequest: ServerPullRequest, operation: string) {
      const refuse = (detail: string) =>
        new AzureDevOpsServerApi.AzureDevOpsServerApiError({
          server: target.server,
          operation,
          status: null,
          reason: "forbidden",
          detail,
        });
      const branch = pullRequest.headBranch;
      // The branch lives in the fork; one of the same name here is someone else's.
      if (pullRequest.isCrossRepository) {
        return yield* refuse("This pull request comes from a fork. Delete its branch in the fork.");
      }
      if (pullRequest.state === "open") {
        return yield* refuse(
          `Complete or abandon pull request !${pullRequest.number} before deleting its source branch.`,
        );
      }
      if (pullRequest.headSha === null) {
        return yield* refuse(`The server did not report where ${branch} ended.`);
      }
      const repository = decodeRepository(
        yield* api.request({ server: target.server, operation, path: repositoryPath(target) }),
      );
      const defaultBranch = normalizeRefName(repository?.defaultBranch ?? "");
      if (branch === pullRequest.baseBranch || branch === defaultBranch) {
        return yield* refuse(`${branch} is a default or target branch and was not deleted.`);
      }
      const refs = yield* api.requestList({
        server: target.server,
        operation,
        path: `${repositoryPath(target)}/refs`,
        query: { filter: `heads/${branch}` },
      });
      const objectId = decodeRefObjectId(refs, `refs/heads/${branch}`);
      if (objectId === null) return;
      if (objectId.toLowerCase() !== pullRequest.headSha.toLowerCase()) {
        return yield* refuse(`${branch} has new commits and was not deleted.`);
      }
      const results = yield* api.request({
        server: target.server,
        operation,
        method: "POST",
        path: `${repositoryPath(target)}/refs`,
        body: [
          {
            name: `refs/heads/${branch}`,
            oldObjectId: objectId,
            newObjectId: "0000000000000000000000000000000000000000",
          },
        ],
      });
      const failure = decodeRefUpdateFailure(results);
      if (failure !== null) {
        return yield* refuse(`The server kept ${branch}: ${failure}.`);
      }
    },
  );

  const postThread = (
    target: ServerRepositoryRef,
    number: number,
    content: string,
    operation: string,
    threadContext?: ReturnType<typeof threadContextOf>,
    pullRequestThreadContext?: {
      readonly changeTrackingId: number;
      readonly iterationContext: {
        readonly firstComparingIteration: number;
        readonly secondComparingIteration: number;
      };
    },
  ) =>
    api.request({
      server: target.server,
      operation,
      method: "POST",
      path: `${pullRequestPath(target, number)}/threads`,
      body: {
        comments: [{ parentCommentId: 0, content, commentType: 1 }],
        status: "active",
        ...(threadContext === undefined ? {} : { threadContext }),
        ...(pullRequestThreadContext === undefined ? {} : { pullRequestThreadContext }),
      },
    });

  /**
   * The latest iteration and each file's change tracking id in it, which a file comment names so
   * it follows its lines across later pushes. Empty when the pull request has no iterations.
   */
  const reviewTracking = Effect.fn("AzureDevOpsServerPullRequestProvider.reviewTracking")(
    function* (target: ServerRepositoryRef, number: number) {
      const latest = (yield* listIterations(target, number, "submitReview")).at(-1);
      if (latest === undefined) return null;
      const tracking = decodeChangeTrackingIds(
        yield* api.request({
          server: target.server,
          operation: "submitReview",
          path: `${pullRequestPath(target, number)}/iterations/${latest.id}/changes`,
          query: { $top: CHANGE_ENTRIES_PER_PAGE },
        }),
      );
      return { iteration: latest.id, tracking };
    },
  );

  // Display names change rarely; a mention keeps its id either way.
  const identityNames = new Map<string, string>();

  /** Display names of `ids` on `server`, from the cache or one batched identity read. */
  const identityNamesOf = Effect.fn("AzureDevOpsServerPullRequestProvider.identityNamesOf")(
    function* (server: string, ids: ReadonlyArray<string>) {
      const unknown = ids.filter((id) => !identityNames.has(`${server}\0${id}`));
      if (unknown.length > 0) {
        const named = yield* api
          .requestList({
            server,
            operation: "identityNames",
            path: "_apis/identities",
            query: { identityIds: unknown.join(","), queryMembership: "None" },
          })
          .pipe(
            Effect.map(decodeIdentityNames),
            Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
          );
        if (identityNames.size > IDENTITY_NAME_CAPACITY) identityNames.clear();
        for (const [id, name] of named) identityNames.set(`${server}\0${id}`, name);
      }
      return new Map(
        ids.flatMap((id) => {
          const name = identityNames.get(`${server}\0${id}`);
          return name === undefined ? [] : [[id, name] as const];
        }),
      );
    },
  );

  const withNamedMentions = Effect.fn("AzureDevOpsServerPullRequestProvider.withNamedMentions")(
    function* (server: string, threads: ServerThreads) {
      return withMentionNames(
        threads,
        yield* identityNamesOf(server, mentionedIdentityIds(threads)),
      );
    },
  );

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    // Repository names repeat across projects and collections; the full path does not.
    repositoryKey: ({ canonicalKey }) => canonicalKey,
    mergeMessageRewrite: removeAgentCredits,

    getViewer: Effect.fn("AzureDevOpsServerPullRequestProvider.getViewer")(function* (input) {
      // The checkout's own collection, so a broken token elsewhere on the host cannot hide it.
      const checkout = yield* api.resolveCheckout({ cwd: input.cwd }).pipe(Effect.option);
      const servers = yield* api.servers;
      const server =
        checkout._tag === "Some"
          ? checkout.value.target.server
          : (servers.find(
              (candidate) =>
                input.host === undefined ||
                URL.parse(candidate)?.hostname.toLowerCase() === input.host.toLowerCase(),
            ) ?? null);
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
        // Rows that do not decode still count toward the offset, and a page of only those must
        // not end the list before the rows behind it.
        const kept: ServerPullRequest[] = [];
        let consumed = 0;
        let truncated = true;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const remaining = input.limit - kept.length;
          const top = remaining + 1;
          const offset = skip + consumed;
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
              ...(offset === 0 ? {} : { $skip: offset }),
            },
          });
          const decoded = rows.flatMap((row, index) => {
            const pullRequest = decodePullRequest(target.server, row);
            return pullRequest === null ? [] : [{ pullRequest, index }];
          });
          const taken = decoded.slice(0, remaining);
          kept.push(...taken.map(({ pullRequest }) => pullRequest));
          if (taken.length === remaining) {
            const used = (taken.at(-1)?.index ?? -1) + 1;
            consumed += used;
            truncated = rows.length === top || used < rows.length;
            break;
          }
          consumed += rows.length;
          if (rows.length < top) {
            truncated = false;
            break;
          }
        }
        // A conversation that cannot be read fails the list rather than date a row too early,
        // which would make every newer reading of it look stale.
        const items = yield* Effect.forEach(
          kept,
          (pullRequest) =>
            updatedAtOf(target, pullRequest).pipe(
              Effect.map((updatedAt) => toChangeRequest(pullRequest, updatedAt)),
            ),
          { concurrency: THREAD_READ_CONCURRENCY },
        );
        return {
          items,
          truncated,
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
        return toSummary(pullRequest, yield* datedBy(target, pullRequest, threads.lastUpdatedAt));
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
          ...toChangeRequest(
            pullRequest,
            yield* datedBy(target, pullRequest, threads.lastUpdatedAt),
          ),
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
        const viewer = yield* viewerOf(target.server).pipe(Effect.option);
        const [threads, commits] = yield* Effect.all(
          [
            readThreads(
              target,
              pullRequest,
              "getChangeRequestActivity",
              Option.getOrUndefined(viewer)?.id,
            ).pipe(
              Effect.flatMap((read) => withNamedMentions(target.server, read)),
              Effect.result,
            ),
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

    runAction: Effect.fn("AzureDevOpsServerPullRequestProvider.runAction")(
      function* (input) {
        const target = yield* locate(input);
        const operation = `runAction:${input.action}`;
        const pullRequest = yield* readPullRequest(target, input.number, operation);
        if (input.action === "delete-branch") {
          yield* deleteSourceBranch(target, pullRequest, operation);
          return;
        }
        const body = yield* actionBody(target, pullRequest, input);
        const reply = decodePullRequest(
          target.server,
          yield* api.request({
            server: target.server,
            operation,
            method: "PATCH",
            path: pullRequestPath(target, input.number),
            body,
          }),
        );
        if (reply === null) return;
        // Azure completes in the background; answering with the still-active reply would show
        // the pull request open after its merge.
        const settled =
          input.action === "merge" && reply.state === "open"
            ? yield* awaitCompletion(target, input.number, operation)
            : reply;
        // The change adds a system thread, which dates the reply as later reads will.
        const threads = yield* readThreads(target, settled, operation).pipe(Effect.option);
        if (threads._tag === "None") return;
        return toSummary(settled, yield* datedBy(target, settled, threads.value.lastUpdatedAt));
      },
      Effect.mapError((error) => (isProviderError(error) ? error : fail("runAction")(error))),
    ),

    updateChangeRequest: Effect.fn("AzureDevOpsServerPullRequestProvider.updateChangeRequest")(
      function* (input) {
        const target = yield* locate(input);
        yield* api.request({
          server: target.server,
          operation: "updateChangeRequest",
          method: "PATCH",
          path: pullRequestPath(target, input.number),
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          },
        });
      },
      Effect.mapError(fail("updateChangeRequest")),
    ),

    listReviewerCandidates: () => unsupported("listReviewerCandidates"),

    setReviewerRequest: Effect.fn("AzureDevOpsServerPullRequestProvider.setReviewerRequest")(
      function* (input) {
        const target = yield* locate(input);
        const pullRequest = yield* readPullRequest(target, input.number, "setReviewerRequest");
        for (const reviewer of input.reviewers) {
          const known = pullRequest.reviewers.find(
            (candidate) =>
              candidate.id === reviewer.id ||
              candidate.login.toLowerCase() === reviewer.id.toLowerCase(),
          );
          const id = known?.id ?? (yield* identityIdOf(target.server, reviewer.id));
          const path = `${pullRequestPath(target, input.number)}/reviewers/${AzureDevOpsServerApi.encodePath(id)}`;
          yield* input.requested
            ? api.request({
                server: target.server,
                operation: "setReviewerRequest",
                method: "PUT",
                path,
                body: { vote: known?.vote ?? 0 },
              })
            : api.request({
                server: target.server,
                operation: "setReviewerRequest",
                method: "DELETE",
                path,
              });
        }
      },
      Effect.mapError(fail("setReviewerRequest")),
    ),
    comment: Effect.fn("AzureDevOpsServerPullRequestProvider.comment")(
      function* (input) {
        const target = yield* locate(input);
        yield* postThread(target, input.number, input.body, "comment");
      },
      Effect.mapError(fail("comment")),
    ),

    updateComment: Effect.fn("AzureDevOpsServerPullRequestProvider.updateComment")(
      function* (input) {
        const target = yield* locate(input);
        const [threadId, commentId] = input.commentId.split(":");
        const path = `${pullRequestPath(target, input.number)}/threads/${AzureDevOpsServerApi.encodePath(threadId ?? "")}/comments/${AzureDevOpsServerApi.encodePath(commentId ?? "")}`;
        // The editor got mentions as names; the saved comment must keep Azure's own markup.
        const original = decodeCommentContent(
          yield* api.request({ server: target.server, operation: "updateComment", path }),
        );
        const names = yield* identityNamesOf(target.server, mentionIdsIn(original));
        yield* api.request({
          server: target.server,
          operation: "updateComment",
          method: "PATCH",
          path,
          body: { content: restoreMentions(input.body, original, names) },
        });
      },
      Effect.mapError(fail("updateComment")),
    ),

    submitReview: Effect.fn("AzureDevOpsServerPullRequestProvider.submitReview")(
      function* (input) {
        const target = yield* locate(input);
        const tracking =
          input.comments.length === 0 ? null : yield* reviewTracking(target, input.number);
        for (const draft of input.comments) {
          const changeTrackingId = tracking?.tracking.get(draft.path.replace(/^\/+/u, ""));
          yield* postThread(
            target,
            input.number,
            draft.body,
            "submitReview",
            threadContextOf(draft),
            tracking === null || changeTrackingId === undefined
              ? undefined
              : {
                  changeTrackingId,
                  iterationContext: {
                    firstComparingIteration: 1,
                    secondComparingIteration: tracking.iteration,
                  },
                },
          );
        }
        if (input.body.trim() !== "") {
          yield* postThread(target, input.number, input.body, "submitReview");
        }
        const vote = VOTES[input.verdict];
        if (vote === undefined) return;
        // Voting adds the viewer as a reviewer when they were not one.
        const viewer = yield* viewerOf(target.server);
        yield* api.request({
          server: target.server,
          operation: "submitReview",
          method: "PUT",
          path: `${pullRequestPath(target, input.number)}/reviewers/${AzureDevOpsServerApi.encodePath(viewer.id)}`,
          body: { vote },
        });
      },
      Effect.mapError(fail("submitReview")),
    ),

    replyToThread: Effect.fn("AzureDevOpsServerPullRequestProvider.replyToThread")(
      function* (input) {
        const target = yield* locate(input);
        const path = `${pullRequestPath(target, input.number)}/threads/${AzureDevOpsServerApi.encodePath(input.threadId)}`;
        const root = decodeRootCommentId(
          yield* api.request({ server: target.server, operation: "replyToThread", path }),
        );
        yield* api.request({
          server: target.server,
          operation: "replyToThread",
          method: "POST",
          path: `${path}/comments`,
          body: { parentCommentId: root ?? 1, content: input.body, commentType: 1 },
        });
      },
      Effect.mapError(fail("replyToThread")),
    ),

    setThreadResolution: Effect.fn("AzureDevOpsServerPullRequestProvider.setThreadResolution")(
      function* (input) {
        const target = yield* locate(input);
        yield* api.request({
          server: target.server,
          operation: "setThreadResolution",
          method: "PATCH",
          path: `${pullRequestPath(target, input.number)}/threads/${AzureDevOpsServerApi.encodePath(input.threadId)}`,
          body: { status: input.resolved ? "fixed" : "active" },
        });
      },
      Effect.mapError(fail("setThreadResolution")),
    ),
    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
