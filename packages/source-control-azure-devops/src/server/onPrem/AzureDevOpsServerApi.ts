import { requireSettingsSecretLiteral } from "@t3tools/contracts";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  normalizeSourceControlServerUrl,
  parseGitRemoteHost,
  readSourceControlHostSettings,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerDefinition from "../../shared/serverDefinition.ts";
import { matchServerRepository, type ServerRepositoryRef } from "./azureDevOpsServerConnections.ts";
import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";

/** Azure DevOps Server 2022 and newer serve 7.0; an older server says it is out of range. */
const API_VERSION = "7.0";
/** ConnectionData and policy evaluations were never released, only previewed. */
const API_PREVIEW_VERSION = "7.0-preview";

const TIMEOUT = Duration.seconds(30);
const MAX_REDIRECTS = 3;
const MAX_DETAIL = 300;

export const AzureDevOpsServerFailure = Schema.Literals([
  "not-configured",
  "unauthenticated",
  "forbidden",
  "not-found",
  "rate-limited",
  "untrusted-certificate",
  "unreachable",
  "unsupported-server",
  "failed",
]);
export type AzureDevOpsServerFailure = typeof AzureDevOpsServerFailure.Type;

export class AzureDevOpsServerApiError extends Schema.TaggedError<AzureDevOpsServerApiError>()(
  "AzureDevOpsServerApiError",
  {
    server: Schema.String,
    operation: Schema.String,
    status: Schema.NullOr(Schema.Int),
    reason: AzureDevOpsServerFailure,
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Azure DevOps Server ${this.operation} failed on ${this.server}: ${this.detail}`;
  }
}

export interface AzureDevOpsServerRequest {
  readonly server: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below the collection URL, path segments already encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly preview?: boolean;
  /** Overrides the token saved for `server`, for checking one before it is saved. */
  readonly token?: string;
}

export class AzureDevOpsServerApi extends Context.Service<
  AzureDevOpsServerApi,
  {
    /** The configured collection URLs that have a token. */
    readonly servers: Effect.Effect<ReadonlyArray<string>>;
    readonly resolveRepository: (input: {
      readonly host: string;
      readonly path: string;
    }) => Effect.Effect<ServerRepositoryRef, AzureDevOpsServerApiError>;
    /** The configured server and repository a checkout's Azure DevOps Server remote names. */
    readonly resolveCheckout: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
    }) => Effect.Effect<
      {
        readonly target: ServerRepositoryRef;
        readonly remote: { readonly name: string; readonly url: string };
      },
      AzureDevOpsServerApiError
    >;
    /** The response body as text. */
    readonly requestText: (
      input: AzureDevOpsServerRequest,
    ) => Effect.Effect<string, AzureDevOpsServerApiError>;
    /** The response's JSON, or null for an empty body. */
    readonly request: (
      input: AzureDevOpsServerRequest,
    ) => Effect.Effect<unknown, AzureDevOpsServerApiError>;
    /** The `value` array of a list response. */
    readonly requestList: (
      input: AzureDevOpsServerRequest,
    ) => Effect.Effect<ReadonlyArray<unknown>, AzureDevOpsServerApiError>;
  }
>()("@t3tools/source-control-azure-devops/server/onPrem/AzureDevOpsServerApi") {}

export const encodePath = (...segments: ReadonlyArray<string | number>) =>
  segments.map((segment) => encodeURIComponent(String(segment))).join("/");

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The first error code anywhere in a cause chain, such as Node's TLS and socket codes. */
function errorCode(cause: unknown): string | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

export function transportFailure(cause: unknown): {
  readonly reason: AzureDevOpsServerFailure;
  readonly detail: string;
} {
  const code = errorCode(cause);
  if (code !== null && TLS_ERROR_CODES.has(code)) {
    return {
      reason: "untrusted-certificate",
      detail: `The server's certificate is not trusted (${code}). Add its CA certificate to the certificate store of the machine running T3 Code, or point NODE_EXTRA_CA_CERTS at it.`,
    };
  }
  return {
    reason: "unreachable",
    detail:
      code === null
        ? "Could not reach the server."
        : `Could not reach the server (${code}). Check the URL and that this machine can reach it.`,
  };
}

const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Azure's own errors start with a code such as `TF401027:` and say what to change; anything else
 * may be a proxy's page, so it stays in the cause and the reader gets a fixed sentence. URLs keep
 * only their origin and path, as a query can carry a signature.
 */
function boundedDetail(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line || !/^(?:TF|VS)\d+:/u.test(line)) return undefined;
  const safe = line.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (url) => {
    const parsed = URL.parse(url);
    return parsed === null ? "" : `${parsed.origin}${parsed.pathname}`;
  });
  return safe.length > MAX_DETAIL ? `${safe.slice(0, MAX_DETAIL)}…` : safe;
}

function statusFailure(
  status: number,
  text: string,
): { readonly reason: AzureDevOpsServerFailure; readonly detail: string } {
  const raw = Option.getOrUndefined(decodeErrorBody(text))?.message;
  const message = boundedDetail(raw);
  if (status === 401) {
    return {
      reason: "unauthenticated",
      detail: "The server refused the personal access token. It may be wrong, expired or revoked.",
    };
  }
  if (status === 403) {
    return {
      reason: "forbidden",
      detail: message ?? "The personal access token lacks a scope or permission this needs.",
    };
  }
  if (status === 404) return { reason: "not-found", detail: message ?? "Not found." };
  if (status === 429 || status === 503) {
    return { reason: "rate-limited", detail: message ?? "The server asked to slow down." };
  }
  if (status === 400 && raw !== undefined && /\bout of range\b/iu.test(raw)) {
    const latest = /supports is (\d+\.\d+)/iu.exec(raw)?.[1];
    return {
      reason: "unsupported-server",
      detail: `T3 Code needs Azure DevOps Server 2022 or newer${latest === undefined ? "" : `; this server's REST API goes up to ${latest}`}.`,
    };
  }
  return { reason: "failed", detail: message ?? `The server answered HTTP ${status}.` };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const http = yield* AzureDevOpsServerHttp.AzureDevOpsServerHttp;
  const kind = ServerDefinition.definition.kind;

  const readTokens = host.settings.getWithSecrets(kind).pipe(
    Effect.map((settings) => ({
      tokens: readSourceControlHostSettings(
        ServerDefinition.settings,
        settings.sourceControlHosts[kind],
      ).tokens,
      secretProviders: settings.secretProviders,
    })),
    Effect.orElseSucceed(() => ({ tokens: {}, secretProviders: {} })),
  );

  const servers = readTokens.pipe(
    Effect.map(({ tokens }) =>
      Object.entries(tokens).flatMap(([server, token]) => {
        const normalized = normalizeSourceControlServerUrl(server);
        return normalized !== null && token !== "" ? [normalized] : [];
      }),
    ),
  );

  const tokenFor = (server: string, operation: string) =>
    readTokens.pipe(
      Effect.flatMap(({ tokens, secretProviders }) => {
        const saved = Object.entries(tokens).find(
          ([key]) => normalizeSourceControlServerUrl(key) === server,
        )?.[1];
        return requireSettingsSecretLiteral(saved, secretProviders).pipe(
          Effect.mapError(
            (cause) =>
              new AzureDevOpsServerApiError({
                server,
                operation,
                status: null,
                reason: "unauthenticated",
                detail: cause.message,
                cause,
              }),
          ),
        );
      }),
      Effect.filterOrFail(
        (token) => token.trim().length > 0,
        () =>
          new AzureDevOpsServerApiError({
            server,
            operation,
            status: null,
            reason: "not-configured",
            detail: `Add ${server} in Settings → Source control → Azure DevOps Server.`,
          }),
      ),
    );

  const resolveRepository = Effect.fn("AzureDevOpsServerApi.resolveRepository")(function* (input: {
    readonly host: string;
    readonly path: string;
  }) {
    const configured = yield* servers;
    const match = matchServerRepository(configured, input.host, input.path);
    if (match !== null) return match;
    return yield* new AzureDevOpsServerApiError({
      server: input.host,
      operation: "resolveRepository",
      status: null,
      reason: "not-configured",
      detail: `No Azure DevOps Server in Settings serves ${input.host}/${input.path}. Add its collection URL in Settings → Source control → Azure DevOps Server.`,
    });
  });

  const checkoutFailure = (cwd: string, detail: string, cause?: unknown) =>
    new AzureDevOpsServerApiError({
      server: cwd,
      operation: "resolveCheckout",
      status: null,
      reason: "not-configured",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const resolveCheckout = Effect.fn("AzureDevOpsServerApi.resolveCheckout")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
  }) {
    const remote =
      input.context?.provider.kind === kind
        ? { name: input.context.remoteName, url: input.context.remoteUrl }
        : yield* host.git.remotes(input.cwd).pipe(
            Effect.flatten,
            Effect.mapError((cause) =>
              checkoutFailure(input.cwd, "The checkout's remotes could not be read.", cause),
            ),
            Effect.map((listed) =>
              listed.remotes.find(
                (candidate) =>
                  recognizeRemoteWith(ServerDefinition.definition, candidate.url) !== null,
              ),
            ),
            Effect.flatMap((found) =>
              found === undefined
                ? Effect.fail(
                    checkoutFailure(
                      input.cwd,
                      "No remote of this checkout is on an Azure DevOps Server.",
                    ),
                  )
                : Effect.succeed({ name: found.name, url: found.url }),
            ),
          );
    const remoteHost = parseGitRemoteHost(remote.url);
    const path = SourceControlProvider.repositoryPathFromRemoteUrl(remote.url);
    if (remoteHost === null || path === null) {
      return yield* checkoutFailure(
        input.cwd,
        "The remote names no Azure DevOps Server repository.",
      );
    }
    const target = yield* resolveRepository({ host: remoteHost.hostname, path });
    return { target, remote };
  });

  const requestText = Effect.fn("AzureDevOpsServerApi.request")(function* (
    input: AzureDevOpsServerRequest,
  ) {
    const fail = (fields: {
      readonly status: number | null;
      readonly reason: AzureDevOpsServerFailure;
      readonly detail: string;
      readonly retryAt?: number | undefined;
      readonly cause?: unknown;
    }) =>
      new AzureDevOpsServerApiError({
        server: input.server,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    const token = input.token ?? (yield* tokenFor(input.server, input.operation));
    const client = yield* http.client;
    const method = input.method ?? "GET";
    const base = new URL(`${input.server}/${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) base.searchParams.set(key, String(value));
    }
    base.searchParams.set(
      "api-version",
      input.preview === true ? API_PREVIEW_VERSION : API_VERSION,
    );
    yield* Effect.annotateCurrentSpan({
      "azure_devops_server.operation": input.operation,
      "http.request.method": method,
    });
    const authorization = `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
    const send = Effect.fn("AzureDevOpsServerApi.send")(
      function* (url: string) {
        const outgoing = HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.setHeaders({
            authorization,
            accept: "application/json",
            "user-agent": "t3code",
            // Without it, an unauthenticated request is answered with a sign-in page.
            "x-tfs-fedauthredirect": "Suppress",
          }),
        );
        const response = yield* client
          .execute(
            input.body === undefined
              ? outgoing
              : outgoing.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
          )
          // Spans would expose branch names in query strings.
          .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        return {
          status: response.status,
          location: response.headers.location,
          retryAfter: response.headers["retry-after"],
          text: yield* response.text,
        };
      },
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) => fail({ status: null, ...transportFailure(cause), cause })),
    );
    // Redirects stay within the collection: the token must not reach another origin or app.
    const collectionPath = new URL(input.server).pathname.toLowerCase().replace(/\/+$/u, "");
    let url = base.href;
    let response = yield* send(url);
    for (let hop = 0; hop < MAX_REDIRECTS && REDIRECTS.has(response.status); hop++) {
      const target = response.location === undefined ? null : URL.parse(response.location, url);
      const targetPath = target?.pathname.toLowerCase() ?? "";
      if (
        target === null ||
        target.origin !== base.origin ||
        (targetPath !== collectionPath && !targetPath.startsWith(`${collectionPath}/`)) ||
        (method !== "GET" && response.status !== 307 && response.status !== 308)
      ) {
        break;
      }
      url = target.href;
      response = yield* send(url);
    }
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
    if (response.status >= 200 && response.status < 300) return response.text;
    const now = yield* Clock.currentTimeMillis;
    const failure = REDIRECTS.has(response.status)
      ? {
          reason: "unauthenticated" as const,
          detail: "The server redirected to a sign-in page instead of accepting the token.",
        }
      : statusFailure(response.status, response.text);
    return yield* fail({
      status: response.status,
      ...failure,
      ...(failure.reason === "rate-limited"
        ? { retryAt: retryAtFromHeader(response.retryAfter, now) }
        : {}),
    });
  });

  const request = (input: AzureDevOpsServerRequest) =>
    requestText(input).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(null)
          : decodeJson(text).pipe(
              Effect.mapError(
                (cause) =>
                  new AzureDevOpsServerApiError({
                    server: input.server,
                    operation: input.operation,
                    status: null,
                    reason: "failed",
                    detail: "The server answered with something other than JSON.",
                    cause,
                  }),
              ),
            ),
      ),
    );

  const requestList = (input: AzureDevOpsServerRequest) =>
    request(input).pipe(
      Effect.map((body) =>
        typeof body === "object" && body !== null && "value" in body && Array.isArray(body.value)
          ? (body.value as ReadonlyArray<unknown>)
          : [],
      ),
    );

  return AzureDevOpsServerApi.of({
    servers,
    resolveRepository,
    resolveCheckout,
    requestText,
    request,
    requestList,
  });
});

export const layer = Layer.effect(AzureDevOpsServerApi, make);
