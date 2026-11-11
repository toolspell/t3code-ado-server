import { describe, expect, it } from "vite-plus/test";

import {
  decodeAccountName,
  decodeIdentityNames,
  decodeRootCommentId,
  decodeChecks,
  decodeMergeCapabilities,
  decodePullRequest,
  decodeThreads,
  mentionedIdentityIds,
  pullRequestUpdatedAt,
  restoreMentions,
  reviewDecisionOf,
  withMentionNames,
} from "./azureDevOpsServerJson.ts";

const COLLECTION = "https://ado2022.fritz.box/defaultcollection";

const rawPullRequest = (overrides: Record<string, unknown> = {}) => ({
  pullRequestId: 25,
  title: "UI: vote buttons per place (#15)",
  description: "Adds vote buttons.",
  status: "active",
  isDraft: false,
  createdBy: { id: "c1", displayName: "Charlotte Hughes", uniqueName: "ADO2022\\chughes" },
  creationDate: "2026-11-10T18:19:15.1234567Z",
  sourceRefName: "refs/heads/feature/15-vote-buttons",
  targetRefName: "refs/heads/main",
  mergeStatus: "succeeded",
  reviewers: [
    { id: "r1", displayName: "Max Beckenbach", uniqueName: "ADO2022\\max", vote: 0 },
    { id: "r2", displayName: "Harry Walker", uniqueName: "ADO2022\\hwalker", vote: 10 },
  ],
  lastMergeSourceCommit: { commitId: "d5c793da89887240d8b021c1d9a41666275878a2" },
  repository: {
    id: "6010aac1",
    name: "Demo Repo",
    project: { id: "a8beb27b", name: "Demo Project" },
  },
  ...overrides,
});

const systemThread = (id: number, lastUpdatedDate: string) => ({
  id,
  lastUpdatedDate,
  properties: { CodeReviewThreadType: { $type: "System.String", $value: "VoteUpdate" } },
  comments: [
    {
      id: 1,
      commentType: "system",
      content: "Harry Walker voted 10",
      publishedDate: lastUpdatedDate,
    },
  ],
});

describe("decodePullRequest", () => {
  it("builds the web URL from the collection, as list reads carry none", () => {
    expect(decodePullRequest(COLLECTION, rawPullRequest())).toMatchObject({
      number: 25,
      url: `${COLLECTION}/Demo%20Project/_git/Demo%20Repo/pullrequest/25`,
      author: { login: "ADO2022\\chughes", name: "Charlotte Hughes", avatarUrl: null },
      headBranch: "feature/15-vote-buttons",
      baseBranch: "main",
      state: "open",
      createdAt: "2026-11-10T18:19:15.123Z",
      closedAt: null,
      location: { projectId: "a8beb27b", project: "Demo Project", repository: "Demo Repo" },
    });
  });

  it.each([
    ["conflicts", "conflicting"],
    ["rejectedByPolicy", "unknown"],
    ["failure", "unknown"],
    ["succeeded", "mergeable"],
  ])("reads merge status %s as %s", (mergeStatus, mergeability) => {
    expect(decodePullRequest(COLLECTION, rawPullRequest({ mergeStatus }))?.mergeability).toBe(
      mergeability,
    );
  });
});

describe("pullRequestUpdatedAt", () => {
  // Azure keeps no update time on a pull request: an open one only states its creation.
  it("dates an open pull request by its newest thread, system threads included", () => {
    const pullRequest = decodePullRequest(COLLECTION, rawPullRequest())!;
    const threads = decodeThreads(
      [
        systemThread(1, "2026-11-11T14:09:07.963Z"),
        systemThread(2, "2026-11-11T14:09:18Z"),
        { id: 3, isDeleted: true, lastUpdatedDate: "2026-11-11T14:12:40.5Z", comments: [] },
      ],
      pullRequest.url,
    );
    expect(pullRequestUpdatedAt(pullRequest, threads.lastUpdatedAt)).toBe(
      "2026-11-11T14:12:40.500Z",
    );
  });

  it("keeps the close time when it is the newest, and the creation time with no threads", () => {
    const completed = decodePullRequest(
      COLLECTION,
      rawPullRequest({ status: "completed", closedDate: "2026-11-11T14:14:12.9Z" }),
    )!;
    expect(pullRequestUpdatedAt(completed, "2026-11-11T14:14:12Z")).toBe(
      "2026-11-11T14:14:12.900Z",
    );
    expect(pullRequestUpdatedAt(completed, "2026-11-11T14:14:13.947Z")).toBe(
      "2026-11-11T14:14:13.947Z",
    );
    const open = decodePullRequest(COLLECTION, rawPullRequest())!;
    expect(pullRequestUpdatedAt(open, null)).toBe("2026-11-10T18:19:15.123Z");
  });
});

describe("decodeThreads", () => {
  const url = `${COLLECTION}/P/_git/R/pullrequest/25`;

  it("splits file threads from overview threads and leaves system notes out", () => {
    const decoded = decodeThreads(
      [
        systemThread(286, "2026-11-11T14:09:07.963Z"),
        {
          id: 285,
          status: "fixed",
          lastUpdatedDate: "2026-11-11T14:12:40.5Z",
          comments: [
            {
              id: 1,
              parentCommentId: 0,
              commentType: "text",
              content: "Top-level comment.",
              publishedDate: "2026-11-11T14:08:55.83Z",
              lastContentUpdatedDate: "2026-11-11T14:08:55.83Z",
              author: { displayName: "Max Beckenbach", uniqueName: "ADO2022\\max" },
            },
            {
              id: 2,
              parentCommentId: 1,
              commentType: "text",
              content: "Reply.",
              publishedDate: "2026-11-11T14:09:01.593Z",
              lastContentUpdatedDate: "2026-11-11T14:10:00Z",
            },
          ],
        },
        {
          id: 333,
          status: "active",
          lastUpdatedDate: "2026-11-11T17:00:00Z",
          threadContext: {
            filePath: "/public/app.js",
            rightFileStart: { line: 3, offset: 1 },
            rightFileEnd: { line: 5, offset: 1 },
          },
          comments: [
            {
              id: 1,
              commentType: "text",
              content: "Consider extracting this block.",
              publishedDate: "2026-11-11T17:00:00Z",
            },
          ],
        },
        {
          id: 334,
          status: "active",
          threadContext: { filePath: "/old.js", leftFileStart: { line: 7 } },
          comments: [{ id: 1, content: "Why remove this?", publishedDate: "2026-11-11T17:01:00Z" }],
        },
      ],
      url,
    );
    expect(decoded.overviewThreads).toEqual([
      expect.objectContaining({ id: "285", isResolved: true, path: null, commentCount: 2 }),
    ]);
    expect(decoded.overviewThreads[0]?.comments[1]).toMatchObject({
      id: "285:2",
      editedAt: "2026-11-11T14:10:00.000Z",
      url: `${url}?discussionId=285`,
    });
    expect(decoded.reviewThreads).toEqual([
      expect.objectContaining({ id: "333", path: "public/app.js", line: 5, side: "right" }),
      expect.objectContaining({ id: "334", path: "old.js", line: 7, side: "left" }),
    ]);
    expect(decoded.comments.map((comment) => [comment.id, comment.kind])).toEqual([
      ["285:1", "issue-comment"],
      ["285:2", "issue-comment"],
      ["333:1", "review-comment"],
      ["334:1", "review-comment"],
    ]);
  });
});

describe("reviewDecisionOf", () => {
  const reviewer = (vote: number, isRequired = false) => ({
    id: String(vote),
    login: `user${vote}`,
    name: null,
    avatarUrl: null,
    vote,
    isRequired,
    isGroup: false,
  });

  it.each([
    [[reviewer(10), reviewer(-5)], "changes-requested"],
    [[reviewer(10), reviewer(0, true)], "review-required"],
    [[reviewer(5), reviewer(0)], "approved"],
    [[reviewer(0)], "review-required"],
    [[], null],
  ] as const)("reads votes %#", (reviewers, decision) => {
    expect(reviewDecisionOf(reviewers)).toBe(decision);
  });
});

describe("decodeChecks", () => {
  const evaluation = (status: string, type: string, extra: Record<string, unknown> = {}) => ({
    status,
    configuration: {
      isBlocking: true,
      isEnabled: true,
      type: { displayName: type },
      settings: {},
      ...extra,
    },
  });

  it("reads branch policies and the newest status per context", () => {
    expect(
      decodeChecks({
        collectionUrl: COLLECTION,
        project: "Demo Project",
        policyEvaluations: [
          evaluation("queued", "Minimum number of reviewers"),
          {
            ...evaluation("rejected", "Build", { settings: { displayName: "CI build" } }),
            context: { buildId: 41 },
          },
          evaluation("approved", "Work item linking"),
          evaluation("notApplicable", "Comment requirements"),
          evaluation("approved", "Path filter", { isEnabled: false }),
        ],
        statuses: [
          { id: 1, state: "pending", context: { name: "deploy", genre: "ci" } },
          { id: 2, state: "succeeded", context: { name: "deploy", genre: "ci" } },
        ],
      }),
    ).toEqual([
      {
        name: "Minimum number of reviewers",
        status: "pending",
        description: null,
        url: null,
        required: true,
      },
      {
        name: "CI build",
        status: "failure",
        description: "Build",
        url: `${COLLECTION}/Demo%20Project/_build/results?buildId=41`,
        required: true,
      },
      {
        name: "Work item linking",
        status: "success",
        description: null,
        url: null,
        required: true,
      },
      { name: "deploy", status: "success", description: null, url: null },
    ]);
  });

  it("narrows merge methods to what the merge strategy policy allows", () => {
    expect(
      decodeMergeCapabilities([
        evaluation("approved", "Require a merge strategy", { settings: { allowSquash: true } }),
      ]),
    ).toEqual({ merge: false, squash: true, rebase: false });
    expect(decodeMergeCapabilities([evaluation("queued", "Build")])).toEqual({
      merge: true,
      squash: true,
      rebase: true,
    });
  });
});

describe("decodeAccountName", () => {
  it("joins the identity's domain and account like a pull request's uniqueName", () => {
    expect(
      decodeAccountName([
        {
          id: "b5ffda4b",
          providerDisplayName: "Harry Walker",
          properties: { Domain: { $value: "ADO2022" }, Account: { $value: "hwalker" } },
        },
      ]),
    ).toBe("ADO2022\\hwalker");
  });
});

describe("mentions, edit rights and replies", () => {
  const url = `${COLLECTION}/P/_git/R/pullrequest/25`;
  const harry = "b5ffda4b-fec4-4076-8beb-cb83409a5469";
  const rows = [
    {
      id: 7,
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          content: `Can you look, @<${harry.toUpperCase()}>?`,
          publishedDate: "2026-11-11T14:00:00Z",
          author: { id: "max-id", uniqueName: "ADO2022\\max" },
        },
        {
          id: 2,
          parentCommentId: 1,
          content: "Sure.",
          publishedDate: "2026-11-11T14:01:00Z",
          author: { id: harry, uniqueName: "ADO2022\\hwalker" },
        },
      ],
    },
  ];

  it("names mentioned identities and lets the viewer edit their own comments", () => {
    const threads = decodeThreads(rows, url, harry);
    expect(mentionedIdentityIds(threads)).toEqual([harry]);
    const named = withMentionNames(
      threads,
      decodeIdentityNames([{ id: harry.toUpperCase(), providerDisplayName: "Harry Walker" }]),
    );
    expect(named.comments.map((comment) => [comment.body, comment.canEdit])).toEqual([
      ["Can you look, @Harry Walker?", false],
      ["Sure.", true],
    ]);
    expect(named.overviewThreads[0]?.comments[0]?.body).toBe("Can you look, @Harry Walker?");
  });

  // The editor gets names, so saving an edit must not turn a mention into plain text.
  it("restores the mentions a comment had before its edit, by name and in order", () => {
    const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
    const names = new Map([
      [id(1), "Max"],
      [id(2), "Max Beckenbach"],
      // Two people with one name.
      [id(3), "Alex Smith"],
      [id(4), "Alex Smith"],
    ]);
    const original = `Ping @<${id(2)}> and @<${id(1)}>, also @<${id(3)}> and @<${id(4)}>.`;
    expect(
      restoreMentions(
        "Ping @Max Beckenbach and @Max, also @Alex Smith and @Alex Smith, cc @Maxwell. Later @Alex Smith.",
        original,
        names,
      ),
    ).toBe(
      `Ping @<${id(2)}> and @<${id(1)}>, also @<${id(3)}> and @<${id(4)}>, cc @Maxwell. Later @Alex Smith.`,
    );
  });

  it("replies to the comment that started a thread", () => {
    expect(decodeRootCommentId(rows[0])).toBe(1);
  });
});
