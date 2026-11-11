import {
  type SourceControlAppAccess,
  type SourceControlAppAccessInput,
  SourceControlCheckServerError,
  type SourceControlCheckServerInput,
  type SourceControlCheckServerResult,
  SourceControlSignInError,
  type SourceControlSignInInput,
  type SourceControlSignInPrompt,
  type SourceControlSignInResult,
  type SourceControlStarredInput,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

/**
 * Signs the server in to a forge, through the forge's own app or with a token for a server the user
 * adds, and reads what its account did.
 */
export class SourceControlSignIn extends Context.Service<
  SourceControlSignIn,
  {
    readonly start: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    readonly wait: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInResult, SourceControlSignInError>;
    readonly cancel: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<void, SourceControlSignInError>;
    readonly access: (input: SourceControlAppAccessInput) => Effect.Effect<SourceControlAppAccess>;
    readonly starred: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
    readonly star: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
    readonly checkServer: (
      input: SourceControlCheckServerInput,
    ) => Effect.Effect<SourceControlCheckServerResult, SourceControlCheckServerError>;
  }
>()("t3/sourceControl/SourceControlSignIn") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  const secrets = yield* SecretResolver.SecretResolver;

  const signInFor = (input: SourceControlSignInInput) => {
    const signIn = drivers.find(({ driver }) => driver.kind === input.provider)?.instance.signIn;
    return signIn === undefined
      ? Effect.fail(
          new SourceControlSignInError({
            provider: input.provider,
            host: input.host,
            reason: "unsupported",
            detail: `This server cannot sign in to ${input.provider}. Use a token or the host's CLI.`,
          }),
        )
      : Effect.succeed(signIn);
  };

  return SourceControlSignIn.of({
    start: Effect.fn("SourceControlSignIn.start")(function* (input) {
      return yield* (yield* signInFor(input)).start(input.host);
    }),
    wait: Effect.fn("SourceControlSignIn.wait")(function* (input) {
      return yield* (yield* signInFor(input)).wait(input.host);
    }),
    cancel: Effect.fn("SourceControlSignIn.cancel")(function* (input) {
      return yield* (yield* signInFor(input)).cancel(input.host);
    }),
    access: Effect.fn("SourceControlSignIn.access")(function* (input) {
      const signIn = drivers.find(({ driver }) => driver.kind === input.provider)?.instance.signIn;
      return {
        status:
          signIn === undefined ? "signed-out" : yield* signIn.access(input.host, input.repository),
      } satisfies SourceControlAppAccess;
    }),
    starred: Effect.fn("SourceControlSignIn.starred")(function* (input) {
      const isStarred = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .isRepositoryStarred;
      return isStarred === undefined ? false : yield* isStarred(input.host, input.repository);
    }),
    star: Effect.fn("SourceControlSignIn.star")(function* (input) {
      const star = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .starRepository;
      return star === undefined ? false : yield* star(input.host, input.repository);
    }),
    checkServer: Effect.fn("SourceControlSignIn.checkServer")(function* (input) {
      const checkServer = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .checkServer;
      if (checkServer === undefined) {
        return yield* new SourceControlCheckServerError({
          provider: input.provider,
          url: input.url,
          reason: "unsupported",
          detail: `${input.provider} has no servers to add.`,
        });
      }
      const token =
        input.token === undefined
          ? undefined
          : yield* requireSettingsSecret(secrets, input.token).pipe(
              Effect.mapError(
                (cause) =>
                  new SourceControlCheckServerError({
                    provider: input.provider,
                    url: input.url,
                    reason: "unauthenticated",
                    detail: `Could not read the token from the secret provider "${cause.provider}". Unlock or fix it in Settings, then try again.`,
                    cause,
                  }),
              ),
            );
      return yield* checkServer({ url: input.url, token });
    }),
  });
});

export const layer = Layer.effect(SourceControlSignIn, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);
