import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../../shared/serverDefinition.ts";

import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";
import * as AzureDevOpsServerHttp from "./AzureDevOpsServerHttp.ts";
import * as AzureDevOpsServerPullRequestProvider from "./AzureDevOpsServerPullRequestProvider.ts";
import * as AzureDevOpsServerSourceControlProvider from "./AzureDevOpsServerSourceControlProvider.ts";

const services = AzureDevOpsServerApi.layer.pipe(Layer.provideMerge(AzureDevOpsServerHttp.layer));

const makeInstance = Effect.all({
  sourceControl: AzureDevOpsServerSourceControlProvider.make,
  discovery: AzureDevOpsServerSourceControlProvider.makeDiscovery,
  pullRequests: AzureDevOpsServerPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
