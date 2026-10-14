/**
 * @powerduck/dev-mcp-server
 *
 * Developer-facing MCP server that gives AI coding agents accurate OpenAPI
 * facts. M0 exposes read-only contract truth over stdio; verification tools
 * (single request, contract tests, scenarios) are layered on top in later
 * releases.
 */

export { createDevMcpServer } from "./mcp/createServer.js";
export type { CreateServerOptions } from "./mcp/createServer.js";
export { startStdioServer } from "./mcp/transportStdio.js";
export type { StdioHandle, StartStdioOptions } from "./mcp/transportStdio.js";
export { startHttpServer } from "./mcp/transportHttp.js";
export type { HttpHandle, StartHttpOptions } from "./mcp/transportHttp.js";
export { devTools, executeDevTool } from "./mcp/tools.js";
export {
  listSpecResources,
  readSpecResource,
  specResourceTemplates,
} from "./mcp/resources.js";

export { SpecStore } from "./spec/store.js";
export type { SpecSnapshot } from "./spec/store.js";
export {
  overview,
  listOperations,
  getOperation,
  getSchema,
  authRequirements,
  resolvePointer,
  HTTP_METHODS,
} from "./spec/facts.js";
export type { ListOptions } from "./spec/facts.js";
export { loadDevConfig, resolveFrom } from "./config/index.js";
export type { DevConfig } from "./config/index.js";

export { pingTarget } from "./verify/ping.js";
export type { PingResult } from "./verify/ping.js";
export { sendOne } from "./verify/send.js";
export type { SendInput } from "./verify/send.js";
export { runContractSuite, contractFilterFromArgs } from "./verify/contract.js";
export type { ContractFilter, ContractSuiteResult } from "./verify/contract.js";
export { validateScenario, runScenarioTool } from "./verify/scenario.js";
export type { ScenarioValidation } from "./verify/scenario.js";
export { detectDrift } from "./verify/drift.js";
export type { DriftItem, DriftKind, DriftReport } from "./verify/drift.js";
export {
  buildRunnerConfig,
  resolveBaseUrl,
  runOverridesFromArgs,
} from "./verify/config.js";
export type { RunOverrides, ProgressSink } from "./verify/config.js";

export {
  deleteScenario,
  getScenario,
  listScenarios,
  saveScenario,
  scenarioSlug,
  scenariosDirectory,
} from "./persistence/scenarios.js";
export type {
  SavedScenarioEnvelope,
  ScenarioSummary,
} from "./persistence/scenarios.js";

export {
  MockManager,
  buildRoutes,
} from "./mock/server.js";
export type {
  MockInstance,
  MockOptions,
  MockManagerOptions,
  MockResponseOverride,
  MockRoute,
  RecordedRequest,
} from "./mock/server.js";

export {
  reconcileDataModel,
  dataModelReport,
  dataModelDeploymentScript,
  normalizeDataModelInputs,
} from "./datamodel/run.js";
export type {
  DataModelInputs,
  DataModelReport,
  DataModelDeployment,
} from "./datamodel/run.js";

export { FactError } from "./types.js";export type {
  CompactOperation,
  HeaderFact,
  MediaFact,
  OperationFact,
  OperationLocator,
  OverviewFact,
  PagedOperations,
  ParameterFact,
  RequestBodyFact,
  ResponseFact,
  SecuritySchemeFact,
  ServerFact,
  ValidationFact,
  ValidationIssue,
} from "./types.js";

export { PublicationManager } from "./publication/manager.js";
