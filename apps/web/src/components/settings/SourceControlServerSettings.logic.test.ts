import { SecretProviderId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { savedServers, serverDraftProblem } from "./SourceControlServerSettings.logic";

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
    [
      "http://tfs.corp:8080/defaultcollection",
      "pat",
      null,
      "This collection is already added under another port or scheme.",
    ],
    ["https://other/c", " ", null, "Enter a personal access token."],
    ["https://tfs.corp/defaultcollection", "", saved[0]!.url, "Enter a new token to save."],
    ["https://other/c", "pat", null, null],
    ["https://tfs.corp/defaultcollection", "new-pat", saved[0]!.url, null],
  ])("checks %s", (url, token, editing, problem) => {
    expect(serverDraftProblem({ url, token, editing, saved })).toBe(problem);
  });
});
