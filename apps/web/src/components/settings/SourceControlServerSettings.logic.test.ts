import { SecretProviderId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  savedServers,
  serverDraftProblem,
  serverTokenPatch,
} from "./SourceControlServerSettings.logic";

const reference = { provider: SecretProviderId.make("op"), reference: "op://vault/ado/token" };

describe("savedServers", () => {
  it("lists servers with a token and drops removed ones", () => {
    expect(
      savedServers({
        "https://tfs.b/c": "••••••",
        "https://tfs.a/c": reference,
        "https://removed/c": "",
      }),
    ).toEqual([
      { url: "https://tfs.a/c", token: reference },
      { url: "https://tfs.b/c", token: "••••••" },
    ]);
  });
});

describe("serverDraftProblem", () => {
  const saved = [{ url: "https://tfs.corp/defaultcollection", token: "••••••" }];

  it.each([
    ["tfs.corp/DefaultCollection", "pat", null, "Enter an http or https URL."],
    [
      "https://TFS.corp/DefaultCollection/",
      "pat",
      null,
      "This server is already added. Edit it to replace its token.",
    ],
    ["https://other/c", " ", null, "Enter a personal access token."],
    ["https://tfs.corp/defaultcollection", "", saved[0]!.url, "Enter a new token to save."],
    ["https://other/c", "pat", null, null],
    ["https://tfs.corp/defaultcollection", "new-pat", saved[0]!.url, null],
  ])("checks %s", (url, token, editing, problem) => {
    expect(serverDraftProblem({ url, token, editing, saved })).toBe(problem);
  });
});

describe("serverTokenPatch", () => {
  // The server merges tokens per URL, so sending one leaves the other servers' secrets alone.
  it("sends only the server being saved or removed", () => {
    expect(serverTokenPatch("azure-devops-server", "https://tfs.corp/c", "")).toEqual({
      sourceControlHosts: { "azure-devops-server": { tokens: { "https://tfs.corp/c": "" } } },
    });
  });
});
