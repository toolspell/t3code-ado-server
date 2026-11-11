import type { ServerSettingsPatch, SettingsSecretValue } from "@t3tools/contracts";
import { normalizeSourceControlServerUrl } from "@t3tools/client-runtime/source-control-clients";

export interface SavedServer {
  readonly url: string;
  readonly token: SettingsSecretValue;
}

const hasToken = (token: SettingsSecretValue | undefined): token is SettingsSecretValue =>
  typeof token === "string" ? token.length > 0 : token !== undefined;

/** Servers with a token, in URL order. A removed server keeps an empty entry until it is reused. */
export function savedServers(
  tokens: Readonly<Record<string, SettingsSecretValue>>,
): ReadonlyArray<SavedServer> {
  return Object.entries(tokens)
    .flatMap(([url, token]) => (hasToken(token) ? [{ url, token }] : []))
    .toSorted((left, right) => left.url.localeCompare(right.url));
}

/** Why a server cannot be saved as entered, or null. */
export function serverDraftProblem(input: {
  readonly url: string;
  readonly token: SettingsSecretValue;
  readonly editing: string | null;
  readonly saved: ReadonlyArray<SavedServer>;
}): string | null {
  const url = normalizeSourceControlServerUrl(input.url);
  if (url === null) return "Enter an http or https URL.";
  if (input.editing === null && input.saved.some((server) => server.url === url)) {
    return "This server is already added. Edit it to replace its token.";
  }
  if (typeof input.token === "string" && input.token.trim() === "") {
    return input.editing === null ? "Enter a personal access token." : "Enter a new token to save.";
  }
  return null;
}

/** Only `url` is sent; the server merges tokens per URL, so the others keep their secrets. */
export function serverTokenPatch(
  kind: string,
  url: string,
  token: SettingsSecretValue,
): ServerSettingsPatch {
  return { sourceControlHosts: { [kind]: { tokens: { [url]: token } } } };
}
