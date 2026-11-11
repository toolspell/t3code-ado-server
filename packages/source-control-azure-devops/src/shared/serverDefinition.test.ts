import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/shared/definition";
import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition as cloudDefinition } from "./definition.ts";
import { definition } from "./serverDefinition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Azure DevOps Server remotes", () => {
  it.each([
    [
      "https://ado2022.fritz.box/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
      "https://ado2022.fritz.box",
    ],
    [
      "ssh://ado2022.fritz.box:2222/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
      "https://ado2022.fritz.box",
    ],
    ["https://user@tfs.corp:8443/tfs/DefaultCollection/Payments/_git/Api", "https://tfs.corp:8443"],
    ["http://tfs:8080/tfs/DefaultCollection/_git/Api", "http://tfs:8080"],
    ["git@tfs.corp:DefaultCollection/Payments/_git/Api", "https://tfs.corp"],
  ])("claims %s", (remote, baseUrl) => {
    expect(recognizeRemoteWith(definition, remote)).toEqual({
      kind: "azure-devops-server",
      name: "Azure DevOps Server",
      baseUrl,
    });
  });

  it.each([
    "https://dev.azure.com/org/project/_git/repo",
    "git@ssh.dev.azure.com:v3/org/project/repo",
    "https://org.visualstudio.com/project/_git/repo",
    "https://github.com/acme/_git",
    "https://tfs.corp/_git/repo",
    "https://tfs.corp/DefaultCollection/Payments/_git/Api/extra",
    "/srv/git/repo",
  ])("leaves %s to other hosts", (remote) => {
    expect(recognizeRemoteWith(definition, remote)).toBeNull();
  });

  it("gives a repository the same key over SSH as over HTTPS", () => {
    const registry = makeSourceControlDefinitionRegistry([definition]);
    for (const remote of [
      "https://ado2022.fritz.box/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
      "ssh://ado2022.fritz.box:2222/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "ado2022.fritz.box/defaultcollection/demoprojecttwo/_git/demoprojecttwo",
      );
    }
  });
});

describe("Azure DevOps Server change request URLs", () => {
  it("reads a server URL and keeps a port in the authority", () => {
    expect(
      parse("https://TFS.CORP:8443/tfs/Collection/Project/_git/Repo/pullrequest/123?_a=files"),
    ).toEqual({
      host: "tfs.corp",
      authority: "tfs.corp:8443",
      repository: "tfs/collection/project/_git/repo",
      number: 123,
      repositoryUrl: "https://tfs.corp:8443/tfs/Collection/Project/_git/Repo",
    });
  });

  it("leaves Azure DevOps Services URLs to the cloud host", () => {
    expect(parse("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17")).toBeNull();
    expect(parse("https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17")).toBeNull();
  });

  it("is asked before the cloud host, which accepts the route on any hostname", () => {
    const registry = makeSourceControlDefinitionRegistry([cloudDefinition, definition], {
      claimChangeRequestUrlsFirst: [definition.kind, cloudDefinition.kind],
    });
    expect(
      registry.findByChangeRequestUrl(
        "https://ado2022.fritz.box/DefaultCollection/DemoProjectTwo/_git/DemoProjectTwo/pullrequest/26",
      )?.kind,
    ).toBe("azure-devops-server");
    expect(
      registry.findByChangeRequestUrl(
        "https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17",
      )?.kind,
    ).toBe("azure-devops");
  });

  it("builds a URL from the remote's web origin or below a web URL", () => {
    expect(
      definition.changeRequestUrl({
        host: "tfs.corp",
        repository: "tfs/DefaultCollection/Payments/_git/Api",
        number: 7,
        remoteUrl: "https://user:secret@tfs.corp:8443/tfs/DefaultCollection/Payments/_git/Api",
      }),
    ).toBe("https://tfs.corp:8443/tfs/DefaultCollection/Payments/_git/Api/pullrequest/7");
    expect(
      definition.changeRequestUrl({
        host: "tfs.corp",
        repository: "DefaultCollection/Payments/_git/Api",
        number: 8,
        webUrl: "https://tfs.corp/DefaultCollection/Payments/_git/Api/",
      }),
    ).toBe("https://tfs.corp/DefaultCollection/Payments/_git/Api/pullrequest/8");
  });

  it("matches links against the checkout's repository and server port", () => {
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey: "tfs.corp/defaultcollection/payments/_git/api",
      displayName: "DefaultCollection/Payments/_git/Api",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://tfs.corp:8443/DefaultCollection/Payments/_git/Api",
      },
    };
    const link = parse("https://tfs.corp:8443/DefaultCollection/Payments/_git/Api/pullrequest/4")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, {
        ...link,
        repository: "defaultcollection/payments/_git/web",
      }),
    ).toBe(false);
    expect(
      definition.isChangeRequestInRepository(identity, { ...link, authority: "tfs.corp:9443" }),
    ).toBe(false);
  });
});
