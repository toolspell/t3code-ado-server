export interface ServerRepositoryRef {
  /** The configured collection URL, as `normalizeSourceControlServerUrl` keys it. */
  readonly server: string;
  readonly project: string;
  readonly repository: string;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
}

/**
 * The configured server a repository on `hostname`, at `path` below the host, lives on. A remote
 * names no collection boundary and an SSH remote no web port, so the configured collection URLs
 * decide: hostname and leading path segments must match, and the longest match wins.
 */
export function matchServerRepository(
  servers: ReadonlyArray<string>,
  hostname: string,
  path: string,
): ServerRepositoryRef | null {
  const segments = segmentsOf(path);
  const gitIndex = segments.length - 2;
  const repository = segments.at(-1);
  if (gitIndex < 1 || segments[gitIndex]?.toLowerCase() !== "_git" || repository === undefined) {
    return null;
  }
  let best: (ServerRepositoryRef & { readonly depth: number }) | null = null;
  for (const server of servers) {
    const url = URL.parse(server);
    if (url === null || url.hostname.toLowerCase() !== hostname.toLowerCase()) continue;
    const prefix = segmentsOf(url.pathname).map((segment) => segment.toLowerCase());
    if (prefix.length === 0 || prefix.length > gitIndex) continue;
    if (!prefix.every((segment, index) => segments[index]?.toLowerCase() === segment)) continue;
    const between = segments.slice(prefix.length, gitIndex);
    if (between.length > 1) continue;
    // `{collection}/_git/{repo}` names the project after its repository.
    const project = between[0] ?? repository;
    if (best === null || prefix.length > best.depth) {
      best = { server, project, repository, depth: prefix.length };
    }
  }
  return best === null
    ? null
    : { server: best.server, project: best.project, repository: best.repository };
}
