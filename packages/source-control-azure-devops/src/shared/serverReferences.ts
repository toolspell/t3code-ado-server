import type {
  ReferenceAutolink,
  SourceControlMediaUrl,
} from "@t3tools/source-control-core/shared/definition";

// `#12` names a work item and `!12` a pull request, as Azure DevOps renders them.
const REFERENCE = /(?<![\w&/-])([#!])([1-9]\d*)(?![\w])/gu;
const ATTACHMENT_PATH =
  /^\/(?:[^/]+\/)+_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/attachments\/([^/]+)$/iu;

/** `{collection}/{project}` of a repository URL, or null when it names no `_git` repository. */
function projectUrl(
  repositoryUrl: string,
): { readonly project: string; readonly repository: string } | null {
  const url = URL.parse(repositoryUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const git = segments.map((segment) => segment.toLowerCase()).lastIndexOf("_git");
  const repository = segments[git + 1];
  if (git < 1 || repository === undefined) return null;
  const base = `${url.origin}/${segments.slice(0, git).join("/")}`;
  // `{collection}/_git/{repo}` names the project after its repository.
  return {
    project: git === 1 ? `${base}/${repository}` : base,
    repository: `${url.origin}/${segments.slice(0, git + 2).join("/")}`,
  };
}

export function serverReferenceAutolinks(
  text: string,
  repositoryUrl: string,
): ReadonlyArray<ReferenceAutolink> {
  if (!text.includes("#") && !text.includes("!")) return [];
  const urls = projectUrl(repositoryUrl);
  if (urls === null) return [];
  return [...text.matchAll(REFERENCE)].map((match) => ({
    index: match.index,
    text: match[0],
    label: match[0],
    url:
      match[1] === "#"
        ? `${urls.project}/_workitems/edit/${match[2]}`
        : `${urls.repository}/pullrequest/${match[2]}`,
    kind: "reference" as const,
  }));
}

/** An image or file attached to a pull request, which the server serves only with a token. */
export function serverMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const name = ATTACHMENT_PATH.exec(url.pathname)?.[1];
  if (name === undefined) return null;
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {}
  return {
    fetchUrl: `${url.origin}${url.pathname}`,
    fileName: decoded.replace(/[^\w.-]+/gu, "_").slice(-120) || "attachment",
  };
}
