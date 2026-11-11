import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as AzureDevOpsServer from "@t3tools/source-control-azure-devops/shared/serverDefinition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as CursorOrigin from "@t3tools/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * Some hosts claim URLs first because GitHub, Forgejo and Azure DevOps accept their routes on any
 * hostname. Remote recognition needs its own order because host labels can overlap.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    CursorOrigin.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
    AzureDevOpsServer.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      AzureDevOpsServer.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      // A `_git` path is surer than hostname labels such as `gitea` or `gitlab`.
      AzureDevOpsServer.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
