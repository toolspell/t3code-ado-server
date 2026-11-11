import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestAuthorityOfProject,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
  remoteWebOrigin,
  serverCredentialSettingsFields,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

// Every server path has a collection in front of `_git`; a virtual directory may precede it.
const CHANGE_REQUEST_PATH = /^\/((?:[^/]+\/)+_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/((?:[^/]+\/)+_git\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;

const KIND = SourceControlProviderKind.make("azure-devops-server");

/** Azure DevOps Services, which the `azure-devops` host reads through `az`. */
export function isAzureDevOpsServicesHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "dev.azure.com" ||
    host.endsWith(".dev.azure.com") ||
    host.endsWith(".visualstudio.com")
  );
}

/**
 * `{collection}/{project}/_git/{repo}` or `{collection}/_git/{repo}`, with any virtual directory in
 * front. `_git` is a route only Azure DevOps and Team Foundation Server serve.
 */
function isServerRepositoryPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2)?.toLowerCase() === "_git";
}

function parseChangeRequestUrl(url: URL) {
  if (isAzureDevOpsServicesHost(url.hostname)) return null;
  const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
  // Servers on different ports are different servers, so a port stays in the link.
  return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
}

export const settings = makeProviderSettingsSchema(serverCredentialSettingsFields);
export type AzureDevOpsServerSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Azure DevOps Server",
  pickerLabel: "Azure DevOps Server",
  icon,
  searchKeywords: ["tfs", "team foundation server", "on-premises", "personal access token"],
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "collection/project/_git/repository",
  publicHost: null,
  publishDescription: "your Azure DevOps Server",
  publishHost: (signedInHost) => signedInHost ?? "your Azure DevOps Server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pullrequest/${number}`)
      : `${remoteWebOrigin(host, remoteUrl)}/${repository}/pullrequest/${number}`,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url) =>
    isAzureDevOpsServicesHost(url.hostname) ? null : parseCommitPath(url, COMMIT_PATH),
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
    "delete-branch",
  ] as const),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  hardLineBreaks: true,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (value) => {
    const url = URL.parse(value);
    return url !== null && parseChangeRequestUrl(url) !== null;
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl, hostname }) => {
    if (isAzureDevOpsServicesHost(hostname)) return null;
    const repository = parseGitRemoteRepository(remoteUrl);
    return repository !== null && isServerRepositoryPath(repository.path)
      ? { kind: KIND, name: "Azure DevOps Server", baseUrl: remoteWebOrigin(hostname, remoteUrl) }
      : null;
  },
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestAuthorityOfProject(identity, link) &&
    identity.canonicalKey.toLowerCase() === `${link.host}/${link.repository}`.toLowerCase(),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  servers: {
    urlLabel: "Collection URL",
    urlPlaceholder: "https://tfs.example.com/DefaultCollection",
    urlHint:
      "The address up to and including the collection, as clone URLs show it before the project.",
    tokenLabel: "Personal access token",
    newTokenUrl: (serverUrl) => `${serverUrl.replace(/\/+$/u, "")}/_usersSettings/tokens`,
    tokenScopes: [
      {
        scope: "Code: Read & write",
        usedFor: "pull requests, diffs, comments, votes and branch policies",
        required: true,
      },
      { scope: "Identity: Read", usedFor: "your account name and reviewers", required: true },
    ],
  },
  settings,
});
