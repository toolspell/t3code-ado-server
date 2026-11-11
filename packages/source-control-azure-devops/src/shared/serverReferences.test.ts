import { describe, expect, it } from "vite-plus/test";

import { serverMediaUrl, serverReferenceAutolinks } from "./serverReferences.ts";

const REPOSITORY = "https://tfs.corp/DefaultCollection/Payments/_git/Api";

describe("serverReferenceAutolinks", () => {
  it("links work items and pull requests as Azure DevOps renders them", () => {
    expect(
      serverReferenceAutolinks("Fixes #15, stacked on !21. Not a&#33; or page#3.", REPOSITORY).map(
        (link) => [link.text, link.url],
      ),
    ).toEqual([
      ["#15", "https://tfs.corp/DefaultCollection/Payments/_workitems/edit/15"],
      ["!21", "https://tfs.corp/DefaultCollection/Payments/_git/Api/pullrequest/21"],
    ]);
  });

  it("names the project after the repository in a short repository URL", () => {
    expect(
      serverReferenceAutolinks("#7", "https://tfs.corp/DefaultCollection/_git/Api")[0]?.url,
    ).toBe("https://tfs.corp/DefaultCollection/Api/_workitems/edit/7");
  });
});

describe("serverMediaUrl", () => {
  it("claims pull request attachments and names them safely", () => {
    expect(
      serverMediaUrl(
        new URL(
          "https://ado2022.fritz.box/DefaultCollection/a8beb27b/_apis/git/repositories/6010aac1/pullRequests/33/attachments/my%20screen%2F..png?download=true",
        ),
      ),
    ).toEqual({
      fetchUrl:
        "https://ado2022.fritz.box/DefaultCollection/a8beb27b/_apis/git/repositories/6010aac1/pullRequests/33/attachments/my%20screen%2F..png",
      fileName: "my_screen_..png",
    });
    expect(serverMediaUrl(new URL(`${REPOSITORY}/pullrequest/33`))).toBeNull();
  });
});
