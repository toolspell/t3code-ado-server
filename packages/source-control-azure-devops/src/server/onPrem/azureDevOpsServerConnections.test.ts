import { describe, expect, it } from "vite-plus/test";

import { matchServerRepository } from "./azureDevOpsServerConnections.ts";

const servers = [
  "https://ado2022.fritz.box/defaultcollection",
  "https://tfs.corp:8443/tfs/defaultcollection",
  "https://tfs.corp:8443/tfs",
];

describe("matchServerRepository", () => {
  it.each([
    [
      "ado2022.fritz.box",
      "DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
      {
        server: "https://ado2022.fritz.box/defaultcollection",
        project: "DemoProjectTwo",
        repository: "DemoProjectTwo",
      },
    ],
    [
      "ADO2022.FRITZ.BOX",
      "defaultcollection/demoprojecttwo/_git/demoprojecttwo",
      {
        server: "https://ado2022.fritz.box/defaultcollection",
        project: "demoprojecttwo",
        repository: "demoprojecttwo",
      },
    ],
    [
      "tfs.corp",
      "tfs/DefaultCollection/Pay%20ments/_git/Api",
      {
        server: "https://tfs.corp:8443/tfs/defaultcollection",
        project: "Pay ments",
        repository: "Api",
      },
    ],
    [
      "tfs.corp",
      "tfs/DefaultCollection/_git/Api",
      { server: "https://tfs.corp:8443/tfs/defaultcollection", project: "Api", repository: "Api" },
    ],
  ])("finds the longest configured collection for %s/%s", (host, path, expected) => {
    expect(matchServerRepository(servers, host, path)).toEqual(expected);
  });

  it.each([
    ["other.host", "DefaultCollection/P/_git/R"],
    ["ado2022.fritz.box", "OtherCollection/P/_git/R"],
    ["ado2022.fritz.box", "DefaultCollection/P/extra/_git/R"],
    ["ado2022.fritz.box", "DefaultCollection/P/R"],
  ])("matches no server for %s/%s", (host, path) => {
    expect(matchServerRepository(servers, host, path)).toBeNull();
  });
});
