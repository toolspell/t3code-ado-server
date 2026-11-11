import {
  isSecretReference,
  type EnvironmentId,
  type SettingsSecretValue,
  type SourceControlCheckServerError,
  type SourceControlCheckServerResult,
  type SourceControlProviderAuth,
} from "@t3tools/contracts";
import {
  normalizeSourceControlServerUrl,
  readServerCredentialSettings,
  type SourceControlDefinition,
  type SourceControlServers,
} from "@t3tools/client-runtime/source-control-clients";
import * as Cause from "effect/Cause";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import {
  savedServers,
  serverDraftProblem,
  serverTokenPatch,
  type SavedServer,
} from "./SourceControlServerSettings.logic";

/** Every check but `idle` names the draft it tested, so an answer for an older draft is ignored. */
type CheckState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly draft: string }
  | { readonly kind: "ok"; readonly draft: string; readonly result: SourceControlCheckServerResult }
  | {
      readonly kind: "failed";
      readonly draft: string;
      readonly detail: string;
      readonly suggestions: ReadonlyArray<string>;
    };

const IDLE: CheckState = { kind: "idle" };

function checkFailure(
  draft: string,
  cause: Cause.Cause<unknown>,
): Extract<CheckState, { kind: "failed" }> {
  const error = Cause.squash(cause) as Partial<SourceControlCheckServerError> | undefined;
  return {
    kind: "failed",
    draft,
    detail:
      typeof error?.detail === "string" ? error.detail : "Could not check the server right now.",
    suggestions: error?.suggestions ?? [],
  };
}

/** A list of servers the user adds by URL, each with its own token, as `definition.servers` asks. */
export function SourceControlServerSettings({
  environmentId,
  definition,
  servers,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly servers: SourceControlServers;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const { tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readServerCredentialSettings(settings, definition.kind),
  );
  const saved = savedServers(tokens);
  const [editing, setEditing] = useState<{ readonly server: SavedServer | null } | null>(null);
  const statusOf = (url: string) => auth.accounts?.find((account) => account.host === url);
  const requiredScopes = servers.tokenScopes.filter((scope) => scope.required);

  return (
    <div className="grid gap-3">
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Add each {definition.label} collection whose repositories you work with, with a{" "}
        {servers.tokenLabel.toLowerCase()} that has{" "}
        {requiredScopes.map((scope, index) => (
          <span key={scope.scope}>
            {index > 0 ? " and " : null}
            <span className="font-medium text-foreground">{scope.scope}</span>
          </span>
        ))}
        . Tokens are stored as secrets on this environment.
      </p>
      {saved.length === 0 ? (
        <p className="text-xs text-muted-foreground">No servers added yet.</p>
      ) : (
        <ul className="grid divide-y divide-border rounded-lg border border-border">
          {saved.map((server) => {
            const status = statusOf(server.url);
            return (
              <li key={server.url} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-foreground">{server.url}</p>
                  <p
                    className={
                      status?.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                    }
                  >
                    {status === undefined
                      ? "Not checked yet. Rescan to check."
                      : status.authenticated
                        ? `Signed in as ${status.account}`
                        : (status.error ?? "Not signed in.")}
                  </p>
                </div>
                {isSecretReference(server.token) ? (
                  <Badge variant="outline" size="sm">
                    Secret reference
                  </Badge>
                ) : null}
                <Button size="xs" variant="outline" onClick={() => setEditing({ server })}>
                  Edit
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button size="xs" variant="outline" onClick={() => setEditing({ server: null })}>
          <PlusIcon aria-hidden className="size-3.5" />
          Add server
        </Button>
      </div>
      {editing === null ? null : (
        <ServerEditor
          key={editing.server?.url ?? "new"}
          environmentId={environmentId}
          definition={definition}
          servers={servers}
          server={editing.server}
          saved={saved}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function ServerEditor({
  environmentId,
  definition,
  servers,
  server,
  saved,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly servers: SourceControlServers;
  readonly server: SavedServer | null;
  readonly saved: ReadonlyArray<SavedServer>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const urlId = useId();
  const tokenId = useId();
  const sources = useSecretSources(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} server`,
  });
  const checkServer = useAtomCommand(sourceControlEnvironment.checkServer, {
    label: `check ${definition.label} server`,
    reportFailure: false,
  });
  const [url, setUrl] = useState(server?.url ?? "");
  const [token, setToken] = useState<SettingsSecretValue>(
    server !== null && isSecretReference(server.token) ? server.token : "",
  );
  const [validToken, setValidToken] = useState(true);
  const [latestCheck, setCheck] = useState<CheckState>(IDLE);
  const canCheck = useAtomValue(sourceControlEnvironment.checkServer.permissionAtom(environmentId));
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const normalizedUrl = normalizeSourceControlServerUrl(url);
  const tokenEntered = typeof token === "string" ? token.trim() : token;
  const changedToken =
    server === null ||
    (typeof tokenEntered === "string" ? tokenEntered !== "" : tokenEntered !== server.token);
  const problem = !validToken
    ? "Enter a valid secret reference."
    : serverDraftProblem({
        url,
        token: changedToken ? tokenEntered : "",
        editing: server?.url ?? null,
        saved,
      });

  const draft = JSON.stringify([normalizedUrl, changedToken ? tokenEntered : null]);
  const check = latestCheck.kind !== "idle" && latestCheck.draft === draft ? latestCheck : IDLE;

  const runCheck = async () => {
    if (normalizedUrl === null) return;
    const tested = draft;
    setCheck({ kind: "checking", draft: tested });
    const result = await checkServer({
      environmentId,
      input: {
        provider: definition.kind,
        url: normalizedUrl,
        ...(changedToken && tokenEntered !== "" ? { token: tokenEntered } : {}),
      },
    });
    setCheck(
      result._tag === "Success"
        ? { kind: "ok", draft: tested, result: result.value }
        : checkFailure(tested, result.cause),
    );
  };

  const save = async (target: string, value: SettingsSecretValue) => {
    setBusy(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: serverTokenPatch(definition.kind, target, value) },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && normalizedUrl !== null && !busy)
              void save(normalizedUrl, tokenEntered);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {server === null ? `Add ${definition.label}` : `Edit ${definition.label}`}
            </DialogTitle>
            <DialogDescription>
              The server running this environment signs in with the token. Clients never see it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1.5 text-sm">
              <label htmlFor={urlId} className="block">
                {servers.urlLabel}
              </label>
              <Input
                id={urlId}
                autoFocus={server === null}
                required
                type="url"
                autoComplete="off"
                placeholder={servers.urlPlaceholder}
                value={url}
                disabled={busy || server !== null}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setCheck(IDLE);
                }}
              />
              <p className="text-xs text-muted-foreground">{servers.urlHint}</p>
              {normalizedUrl?.startsWith("http:") ? (
                <p className="text-xs text-warning-foreground">
                  This URL uses http, so the token travels unencrypted.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5 text-sm">
              <label htmlFor={tokenId} className="block">
                {servers.tokenLabel}
              </label>
              <SecretSourceInput
                id={tokenId}
                aria-label={servers.tokenLabel}
                autoFocus={server !== null}
                configured={server !== null && typeof server.token === "string"}
                value={token}
                sources={sources}
                disabled={busy}
                onValidityChange={setValidToken}
                onChange={(event) => {
                  setToken(event.target.value);
                  setCheck(IDLE);
                }}
                onSecretChange={(secret) => {
                  setToken(secret ?? "");
                  setCheck(IDLE);
                }}
              />
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p>
                Create the token on the server with these scopes:{" "}
                {normalizedUrl === null ? null : (
                  <InlineButton
                    render={
                      <a
                        href={servers.newTokenUrl(normalizedUrl)}
                        target="_blank"
                        rel="noreferrer noopener"
                      />
                    }
                  >
                    Create a token
                    <ExternalLinkIcon aria-hidden className="size-3" />
                  </InlineButton>
                )}
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {servers.tokenScopes.map((scope) => (
                  <li key={scope.scope}>
                    <span className="font-medium text-foreground">{scope.scope}</span>
                    {scope.required ? "" : " (optional)"}: {scope.usedFor}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={
                  busy ||
                  !canCheck ||
                  normalizedUrl === null ||
                  !validToken ||
                  check.kind === "checking"
                }
                onClick={() => void runCheck()}
              >
                {check.kind === "checking" ? <Spinner size="xs" /> : null}
                Test connection
              </Button>
              {check.kind === "ok" ? (
                <span className="text-muted-foreground">Connected as {check.result.account}.</span>
              ) : check.kind === "failed" ? (
                <span className="text-destructive" role="alert">
                  {check.detail}
                </span>
              ) : null}
            </div>
            {check.kind === "failed" && check.suggestions.length > 0 && server === null ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Use
                {check.suggestions.map((suggestion) => (
                  <InlineButton
                    key={suggestion}
                    onClick={() => {
                      setUrl(suggestion);
                      setCheck(IDLE);
                    }}
                  >
                    {suggestion}
                  </InlineButton>
                ))}
              </div>
            ) : null}
            {problem !== null && url.trim() !== "" && (server === null || changedToken) ? (
              <p className="text-xs text-muted-foreground">{problem}</p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {server === null ? null : (
              <div className="sm:mr-auto">
                <Button
                  type="button"
                  variant="destructive-outline"
                  disabled={busy || !canSave}
                  onClick={() => void save(server.url, "")}
                >
                  Remove server
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !canSave || problem !== null}>
              {busy ? <Spinner size="xs" /> : null}
              {server === null ? "Add server" : "Save token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
