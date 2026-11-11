import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestOverviewThread,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import {
  normalizeRefName,
  toIsoUtc,
  trimOptionalString as trimmed,
} from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

// Unknown enum values and missing optional fields must not fail a payload.
const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const OptionalInt = Schema.optional(Schema.NullOr(Schema.Int));

const RawIdentity = Schema.Struct({
  id: OptionalString,
  displayName: OptionalString,
  uniqueName: OptionalString,
  isContainer: OptionalBoolean,
});

const RawReviewer = Schema.Struct({
  ...RawIdentity.fields,
  vote: OptionalInt,
  isRequired: OptionalBoolean,
  hasDeclined: OptionalBoolean,
});

const RawCommitRef = Schema.optional(Schema.NullOr(Schema.Struct({ commitId: OptionalString })));

export const RawPullRequest = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: OptionalString,
  status: OptionalString,
  isDraft: OptionalBoolean,
  createdBy: Schema.optional(Schema.NullOr(RawIdentity)),
  creationDate: Schema.String,
  closedDate: OptionalString,
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  mergeStatus: OptionalString,
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawReviewer))),
  labels: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: OptionalString, active: OptionalBoolean }))),
  ),
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentity)),
  completionOptions: Schema.optional(
    Schema.NullOr(Schema.Struct({ mergeStrategy: OptionalString, squashMerge: OptionalBoolean })),
  ),
  lastMergeSourceCommit: RawCommitRef,
  forkSource: Schema.optional(Schema.NullOr(Schema.Unknown)),
  repository: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    project: Schema.Struct({ id: Schema.String, name: Schema.String }),
  }),
});
export type RawPullRequest = typeof RawPullRequest.Type;

export const RawList = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const FilePosition = Schema.optional(Schema.NullOr(Schema.Struct({ line: OptionalInt })));

const RawComment = Schema.Struct({
  id: Schema.Int,
  parentCommentId: OptionalInt,
  content: OptionalString,
  commentType: OptionalString,
  publishedDate: OptionalString,
  lastContentUpdatedDate: OptionalString,
  isDeleted: OptionalBoolean,
  author: Schema.optional(Schema.NullOr(RawIdentity)),
});

const RawThread = Schema.Struct({
  id: Schema.Int,
  status: OptionalString,
  isDeleted: OptionalBoolean,
  lastUpdatedDate: OptionalString,
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: OptionalString,
        rightFileStart: FilePosition,
        rightFileEnd: FilePosition,
        leftFileStart: FilePosition,
        leftFileEnd: FilePosition,
      }),
    ),
  ),
  comments: Schema.optional(Schema.NullOr(Schema.Array(RawComment))),
});

const RawGitUserDate = Schema.optional(
  Schema.NullOr(
    Schema.Struct({ name: OptionalString, email: OptionalString, date: OptionalString }),
  ),
);

const RawCommit = Schema.Struct({
  commitId: Schema.String,
  comment: OptionalString,
  author: RawGitUserDate,
  committer: RawGitUserDate,
});

const RawPolicyEvaluation = Schema.Struct({
  status: OptionalString,
  configuration: Schema.Struct({
    isBlocking: OptionalBoolean,
    isEnabled: OptionalBoolean,
    isDeleted: OptionalBoolean,
    type: Schema.optional(Schema.NullOr(Schema.Struct({ displayName: OptionalString }))),
    settings: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  context: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});

const RawStatus = Schema.Struct({
  id: OptionalInt,
  state: OptionalString,
  description: OptionalString,
  targetUrl: OptionalString,
  creationDate: OptionalString,
  updatedDate: OptionalString,
  context: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: OptionalString, genre: OptionalString })),
  ),
});

export const RawRepository = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.Struct({ id: Schema.String, name: Schema.String }),
  remoteUrl: OptionalString,
  sshUrl: OptionalString,
  defaultBranch: OptionalString,
});
export type RawRepository = typeof RawRepository.Type;

export const RawConnectionData = Schema.Struct({
  authenticatedUser: Schema.Struct({ id: Schema.String, providerDisplayName: OptionalString }),
  deploymentType: OptionalString,
  webApplicationRelativeDirectory: OptionalString,
});
export type RawConnectionData = typeof RawConnectionData.Type;

const IdentityProperty = Schema.optional(Schema.NullOr(Schema.Struct({ $value: OptionalString })));

const RawIdentityRecord = Schema.Struct({
  id: Schema.String,
  providerDisplayName: OptionalString,
  properties: Schema.optional(
    Schema.NullOr(Schema.Struct({ Domain: IdentityProperty, Account: IdentityProperty })),
  ),
});

/** Rows that fail to decode drop out; one odd row must not hide the rest. */
function decodeEach<A, I>(schema: Schema.Codec<A, I>, rows: ReadonlyArray<unknown>): A[] {
  const decode = Schema.decodeUnknownExit(schema);
  return rows.flatMap((row) => {
    const decoded = decode(row);
    return Exit.isSuccess(decoded) ? [decoded.value] : [];
  });
}

/** The newest of the given host times, normalized so the server can compare them as text. */
function latestTime(...times: ReadonlyArray<string | null | undefined>): string | null {
  let latest: { readonly at: number; readonly value: string } | null = null;
  for (const time of times) {
    const value = trimmed(time);
    if (value === null) continue;
    const at = Date.parse(value);
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest.at) latest = { at, value };
  }
  return latest === null ? null : toIsoUtc(latest.value);
}

export interface ServerRepositoryLocation {
  readonly projectId: string;
  readonly project: string;
  readonly repositoryId: string;
  readonly repository: string;
}

export interface ServerReviewer extends PullRequestActor {
  readonly id: string;
  readonly vote: number;
  readonly isRequired: boolean;
  readonly isGroup: boolean;
}

export interface ServerPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly isCrossRepository: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<ServerReviewer>;
  readonly labels: ReadonlyArray<string>;
  readonly autoMergeEnabled: boolean;
  readonly autoMergeMethod: PullRequestMergeMethod | undefined;
  readonly location: ServerRepositoryLocation;
}

/** Account names, such as `DOMAIN\user`, are what Azure DevOps Server shows as the login. */
function toActor(raw: typeof RawIdentity.Type | null | undefined): PullRequestActor | null {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  return login === null ? null : { login, name: trimmed(raw?.displayName), avatarUrl: null };
}

function toState(status: string | null | undefined): PullRequestState {
  switch (status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    // A policy rejection or a failed trial merge is not a conflict to resolve.
    case "conflicts":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toMergeMethod(strategy: string | null | undefined): PullRequestMergeMethod | undefined {
  switch (strategy?.trim().toLowerCase()) {
    case "squash":
      return "squash";
    case "rebase":
    case "rebasemerge":
      return "rebase";
    case "nofastforward":
      return "merge";
    default:
      return undefined;
  }
}

function toReviewer(raw: typeof RawReviewer.Type): ServerReviewer | null {
  const actor = toActor(raw);
  const id = trimmed(raw.id);
  return actor === null || id === null
    ? null
    : {
        ...actor,
        id,
        vote: raw.vote ?? 0,
        isRequired: raw.isRequired === true,
        isGroup: raw.isContainer === true,
      };
}

function repositoryWebUrl(
  collectionUrl: string,
  location: Pick<ServerRepositoryLocation, "project" | "repository">,
): string {
  return `${collectionUrl}/${encodeURIComponent(location.project)}/_git/${encodeURIComponent(location.repository)}`;
}

function pullRequestWebUrl(
  collectionUrl: string,
  location: Pick<ServerRepositoryLocation, "project" | "repository">,
  number: number,
): string {
  return `${repositoryWebUrl(collectionUrl, location)}/pullrequest/${number}`;
}

/** List and single reads lack a web link on Azure DevOps Server, so the URL is built here. */
function toPullRequest(collectionUrl: string, raw: RawPullRequest): ServerPullRequest | null {
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (headBranch === null || baseBranch === null) return null;
  const location: ServerRepositoryLocation = {
    projectId: raw.repository.project.id,
    project: raw.repository.project.name,
    repositoryId: raw.repository.id,
    repository: raw.repository.name,
  };
  const autoMergeEnabled = (raw.autoCompleteSetBy ?? null) !== null;
  const strategy = toMergeMethod(raw.completionOptions?.mergeStrategy);
  return {
    number: raw.pullRequestId,
    title: raw.title,
    body: raw.description ?? "",
    url: pullRequestWebUrl(collectionUrl, location, raw.pullRequestId),
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    headSha: trimmed(raw.lastMergeSourceCommit?.commitId),
    state: toState(raw.status),
    isDraft: raw.isDraft === true,
    isCrossRepository: (raw.forkSource ?? null) !== null,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: toIsoUtc(raw.creationDate),
    closedAt: latestTime(raw.closedDate),
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => toReviewer(reviewer) ?? []),
    labels: (raw.labels ?? []).flatMap((label) =>
      label.active === false ? [] : (trimmed(label.name) ?? []),
    ),
    autoMergeEnabled,
    autoMergeMethod: !autoMergeEnabled
      ? undefined
      : (strategy ?? (raw.completionOptions?.squashMerge === true ? "squash" : undefined)),
    location,
  };
}

export function decodePullRequests(collectionUrl: string, rows: ReadonlyArray<unknown>) {
  return decodeEach(RawPullRequest, rows).flatMap((raw) => toPullRequest(collectionUrl, raw) ?? []);
}

export function decodePullRequest(collectionUrl: string, raw: unknown): ServerPullRequest | null {
  return decodePullRequests(collectionUrl, [raw])[0] ?? null;
}

/**
 * Azure DevOps rejects with -10, waits for the author with -5, approves with suggestions with 5
 * and approves with 10. A required reviewer who has not voted keeps the review open.
 */
export function reviewDecisionOf(
  reviewers: ReadonlyArray<ServerReviewer>,
): PullRequestReviewDecision | null {
  if (reviewers.some((reviewer) => reviewer.vote < 0)) return "changes-requested";
  if (reviewers.some((reviewer) => reviewer.isRequired && reviewer.vote === 0)) {
    return "review-required";
  }
  if (reviewers.some((reviewer) => reviewer.vote > 0)) return "approved";
  return reviewers.length === 0 ? null : "review-required";
}

/** Reviewers who were asked and have not voted yet. */
export function pendingReviewerLogins(reviewers: ReadonlyArray<ServerReviewer>): string[] {
  return reviewers.filter((reviewer) => reviewer.vote === 0).map((reviewer) => reviewer.login);
}

export interface ServerThreads {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly overviewThreads: ReadonlyArray<PullRequestOverviewThread>;
  /**
   * Azure keeps no update time on a pull request. Its threads, system ones included, date every
   * push, comment, vote, resolution and status change; title edits and work item links leave none.
   */
  readonly lastUpdatedAt: string | null;
}

const RESOLVED_THREAD_STATUSES = new Set(["fixed", "wontfix", "closed", "bydesign"]);

function toRepositoryPath(value: string | null | undefined): string | null {
  const path = value?.replace(/^\/+/u, "") ?? "";
  return path.length === 0 ? null : path;
}

/** Azure stores a mention as `@<identity id>`; the names fill in once read. */
const MENTION = /@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/giu;

export function mentionIdsIn(text: string): ReadonlyArray<string> {
  return [...new Set([...text.matchAll(MENTION)].map((match) => match[1]!.toLowerCase()))];
}

export function mentionedIdentityIds(threads: ServerThreads): ReadonlyArray<string> {
  return mentionIdsIn(threads.comments.map((comment) => comment.body).join("\n"));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * `@Display Name` back to `@<id>` for the identities `original` mentioned, longest name first so a
 * name inside another cannot take its place. Two people with one name are restored in the order
 * they were mentioned; a further mention of an ambiguous name stays text.
 */
export function restoreMentions(
  edited: string,
  original: string,
  names: ReadonlyMap<string, string>,
): string {
  const idsByName = new Map<string, string[]>();
  for (const match of original.matchAll(MENTION)) {
    const id = match[1]!.toLowerCase();
    const name = names.get(id);
    if (name === undefined) continue;
    const ids = idsByName.get(name) ?? [];
    ids.push(id);
    idsByName.set(name, ids);
  }
  let restored = edited;
  for (const [name, ids] of [...idsByName].toSorted(
    ([left], [right]) => right.length - left.length,
  )) {
    const distinct = [...new Set(ids)];
    let seen = 0;
    restored = restored.replace(new RegExp(`@${escapeRegExp(name)}(?![\\w])`, "gu"), (written) => {
      const id = distinct.length === 1 ? distinct[0] : ids[seen];
      seen += 1;
      return id === undefined ? written : `@<${id}>`;
    });
  }
  return restored;
}

const RawChangeTracking = Schema.Struct({
  changeEntries: Schema.Array(
    Schema.Struct({
      changeTrackingId: OptionalInt,
      item: Schema.optional(Schema.NullOr(Schema.Struct({ path: OptionalString }))),
    }),
  ),
});

/** Each changed file's change tracking id in an iteration, keyed by its path without `/`. */
export function decodeChangeTrackingIds(body: unknown): ReadonlyMap<string, number> {
  const [decoded] = decodeEach(RawChangeTracking, [body]);
  return new Map(
    (decoded?.changeEntries ?? []).flatMap((entry) => {
      const path = toRepositoryPath(entry.item?.path);
      return path === null || entry.changeTrackingId == null
        ? []
        : [[path, entry.changeTrackingId] as const];
    }),
  );
}

const RawCommentContent = Schema.Struct({ content: OptionalString });

export function decodeCommentContent(body: unknown): string {
  return decodeEach(RawCommentContent, [body])[0]?.content ?? "";
}

/** `@<id>` as `@Display Name` for the identities `names` knows, the rest as written. */
export function withMentionNames(
  threads: ServerThreads,
  names: ReadonlyMap<string, string>,
): ServerThreads {
  if (names.size === 0) return threads;
  const named = <C extends { readonly body: string }>(comment: C): C => ({
    ...comment,
    body: comment.body.replace(MENTION, (written, id: string) => {
      const name = names.get(id.toLowerCase());
      return name === undefined ? written : `@${name}`;
    }),
  });
  return {
    ...threads,
    comments: threads.comments.map(named),
    reviewThreads: threads.reviewThreads.map((thread) => ({
      ...thread,
      comments: thread.comments.map(named),
    })),
    overviewThreads: threads.overviewThreads.map((thread) => ({
      ...thread,
      comments: thread.comments.map(named),
    })),
  };
}

export function decodeIdentityNames(rows: ReadonlyArray<unknown>): ReadonlyMap<string, string> {
  return new Map(
    decodeEach(RawIdentityRecord, rows).flatMap((identity) => {
      const name = trimmed(identity.providerDisplayName);
      return name === null ? [] : [[identity.id.toLowerCase(), name] as const];
    }),
  );
}

/** The comment a reply in thread `rows` answers: its first, the one that started it. */
export function decodeRootCommentId(thread: unknown): number | null {
  const [decoded] = decodeEach(RawThread, [thread]);
  const ids = (decoded?.comments ?? [])
    .filter((comment) => (comment.parentCommentId ?? 0) === 0)
    .map((comment) => comment.id);
  return ids.length === 0 ? null : Math.min(...ids);
}

export function decodeThreads(
  rows: ReadonlyArray<unknown>,
  pullRequestUrl: string,
  /** Set to mark which comments the viewer may edit: their own. */
  viewerId?: string,
): ServerThreads {
  const comments: PullRequestComment[] = [];
  const reviewThreads: PullRequestReviewThread[] = [];
  const overviewThreads: PullRequestOverviewThread[] = [];
  let lastUpdatedAt: string | null = null;
  for (const thread of decodeEach(RawThread, rows)) {
    // A deleted comment or thread moves the date too, and drops out of the conversation.
    lastUpdatedAt = latestTime(lastUpdatedAt, thread.lastUpdatedDate);
    if (thread.isDeleted === true) continue;
    const path = toRepositoryPath(thread.threadContext?.filePath);
    const url = `${pullRequestUrl}?discussionId=${thread.id}`;
    const threadComments: PullRequestThreadComment[] = [];
    for (const comment of thread.comments ?? []) {
      const createdAt = latestTime(comment.publishedDate);
      const body = comment.content ?? "";
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        body.trim().length === 0 ||
        createdAt === null
      ) {
        continue;
      }
      const editedAt = latestTime(comment.lastContentUpdatedDate);
      const shared = {
        id: `${thread.id}:${comment.id}`,
        author: toActor(comment.author),
        body,
        createdAt,
        ...(editedAt !== null && editedAt !== createdAt ? { editedAt } : {}),
        url,
        ...(viewerId === undefined
          ? {}
          : { canEdit: comment.author?.id?.toLowerCase() === viewerId.toLowerCase() }),
      };
      threadComments.push(shared);
      comments.push({
        ...shared,
        kind: path === null ? "issue-comment" : "review-comment",
        path,
        reviewState: null,
      });
    }
    if (threadComments.length === 0) continue;
    const isResolved = RESOLVED_THREAD_STATUSES.has(thread.status?.trim().toLowerCase() ?? "");
    const context = thread.threadContext;
    const rightLine = context?.rightFileEnd?.line ?? context?.rightFileStart?.line ?? null;
    const leftLine = context?.leftFileEnd?.line ?? context?.leftFileStart?.line ?? null;
    const shared = {
      id: String(thread.id),
      isResolved,
      isOutdated: false,
      comments: threadComments,
      commentCount: threadComments.length,
    };
    if (path === null) {
      overviewThreads.push({ ...shared, path: null, line: null, side: "right" });
    } else {
      const line = rightLine ?? leftLine;
      reviewThreads.push({
        ...shared,
        path,
        line: line !== null && line > 0 ? line : null,
        side: rightLine === null && leftLine !== null ? "left" : "right",
      });
    }
  }
  return {
    comments: comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    reviewThreads,
    overviewThreads,
    lastUpdatedAt,
  };
}

/** See `ServerThreads.lastUpdatedAt`. Every read of a pull request must date it the same way. */
export function pullRequestUpdatedAt(
  pullRequest: Pick<ServerPullRequest, "createdAt" | "closedAt">,
  threadsUpdatedAt: string | null,
): string {
  return (
    latestTime(pullRequest.createdAt, pullRequest.closedAt, threadsUpdatedAt) ??
    pullRequest.createdAt
  );
}

export function decodeCommits(rows: ReadonlyArray<unknown>): ReadonlyArray<PullRequestCommit> {
  return decodeEach(RawCommit, rows).flatMap((commit): PullRequestCommit[] => {
    const committedDate = latestTime(commit.committer?.date ?? commit.author?.date);
    const oid = trimmed(commit.commitId);
    if (committedDate === null || oid === null) return [];
    const login = trimmed(commit.author?.email) ?? trimmed(commit.author?.name);
    return [
      {
        oid,
        messageHeadline: (commit.comment ?? "").split(/\r?\n/u, 1)[0] ?? "",
        committedDate,
        ...(login === null
          ? {}
          : { authors: [{ login, name: trimmed(commit.author?.name), avatarUrl: null }] }),
      },
    ];
  });
}

function policyStatus(status: string | null | undefined): PullRequestCheck["status"] | null {
  switch (status?.trim().toLowerCase()) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "notapplicable":
      return null;
    default:
      return "pending";
  }
}

function statusCheckStatus(state: string | null | undefined): PullRequestCheck["status"] {
  switch (state?.trim().toLowerCase()) {
    case "succeeded":
      return "success";
    case "failed":
    case "error":
      return "failure";
    case "notapplicable":
      return "skipped";
    default:
      return "pending";
  }
}

const stringField = (record: Readonly<Record<string, unknown>> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" ? trimmed(value) : null;
};

/**
 * Branch policies are what gate completion on Azure DevOps Server, builds among them; statuses
 * other services post on the pull request come after them.
 */
export function decodeChecks(input: {
  readonly collectionUrl: string;
  readonly project: string;
  readonly policyEvaluations: ReadonlyArray<unknown>;
  readonly statuses: ReadonlyArray<unknown>;
}): ReadonlyArray<PullRequestCheck> {
  const policies = decodeEach(RawPolicyEvaluation, input.policyEvaluations).flatMap(
    (evaluation): PullRequestCheck[] => {
      const configuration = evaluation.configuration;
      if (configuration.isEnabled === false || configuration.isDeleted === true) return [];
      const status = policyStatus(evaluation.status);
      if (status === null) return [];
      const typeName = trimmed(configuration.type?.displayName) ?? "Branch policy";
      const name = stringField(configuration.settings, "displayName") ?? typeName;
      const buildId = evaluation.context?.buildId;
      return [
        {
          name,
          status,
          description: name === typeName ? null : typeName,
          url:
            typeof buildId === "number"
              ? `${input.collectionUrl}/${encodeURIComponent(input.project)}/_build/results?buildId=${buildId}`
              : null,
          required: configuration.isBlocking !== false,
        },
      ];
    },
  );
  const statuses = dedupeChecks(
    decodeEach(RawStatus, input.statuses).flatMap((status) => {
      const name = trimmed(status.context?.name);
      if (name === null) return [];
      return [
        {
          check: {
            name,
            status: statusCheckStatus(status.state),
            description: trimmed(status.description),
            url: trimmed(status.targetUrl),
          },
          workflowName: trimmed(status.context?.genre),
          at: latestTime(status.updatedDate, status.creationDate),
          ...(status.id == null ? {} : { sequence: status.id }),
        },
      ];
    }),
  );
  return [...policies, ...statuses];
}

const MERGE_STRATEGY_SETTINGS = [
  "allowSquash",
  "allowNoFastForward",
  "allowRebase",
  "allowRebaseMerge",
];

/**
 * The "Require a merge strategy" policy narrows how a pull request may complete; without one,
 * every strategy is allowed.
 */
export function decodeMergeCapabilities(
  policyEvaluations: ReadonlyArray<unknown>,
): PullRequestMergeCapabilities {
  for (const evaluation of decodeEach(RawPolicyEvaluation, policyEvaluations)) {
    const configuration = evaluation.configuration;
    if (configuration.isEnabled === false || configuration.isDeleted === true) continue;
    const settings = configuration.settings;
    if (settings == null || !MERGE_STRATEGY_SETTINGS.some((key) => key in settings)) continue;
    return {
      merge: settings.allowNoFastForward === true,
      squash: settings.allowSquash === true,
      rebase: settings.allowRebase === true || settings.allowRebaseMerge === true,
    };
  }
  return { merge: true, squash: true, rebase: true };
}

export function decodeRepository(raw: unknown): RawRepository | null {
  return decodeEach(RawRepository, [raw])[0] ?? null;
}

export function decodeConnectionData(raw: unknown): RawConnectionData | null {
  return decodeEach(RawConnectionData, [raw])[0] ?? null;
}

/** `DOMAIN\account`, the `uniqueName` Azure DevOps Server shows on pull requests. */
export function decodeAccountName(rows: ReadonlyArray<unknown>): string | null {
  const [identity] = decodeEach(RawIdentityRecord, rows);
  const domain = trimmed(identity?.properties?.Domain?.$value);
  const account = trimmed(identity?.properties?.Account?.$value);
  if (account === null) return null;
  return domain === null ? account : `${domain}\\${account}`;
}

const RawRef = Schema.Struct({ name: Schema.String, objectId: Schema.String });

/** The commit `name` points at, or null when the server lists no such ref. */
export function decodeRefObjectId(rows: ReadonlyArray<unknown>, name: string): string | null {
  return decodeEach(RawRef, rows).find((ref) => ref.name === name)?.objectId ?? null;
}

const RawRefUpdate = Schema.Struct({
  success: OptionalBoolean,
  updateStatus: OptionalString,
  customMessage: OptionalString,
});

/** Why a ref update the server answered was refused, or null when every update succeeded. */
export function decodeRefUpdateFailure(body: unknown): string | null {
  const rows =
    typeof body === "object" && body !== null && "value" in body && Array.isArray(body.value)
      ? body.value
      : [];
  const failed = decodeEach(RawRefUpdate, rows).find((update) => update.success === false);
  if (failed === undefined) return null;
  return trimmed(failed.customMessage) ?? trimmed(failed.updateStatus) ?? "refused";
}

export function decodeIdentityIds(rows: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return decodeEach(RawIdentityRecord, rows).map((identity) => identity.id);
}
