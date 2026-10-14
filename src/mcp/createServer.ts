import { PublicationManager } from "../publication/manager.js";
/**
 * Builds the developer MCP server: read-only contract facts plus verification
 * against a running backend.
 *
 * The server is transport agnostic. A SpecStore supplies a live document, and
 * every request re-reads the file when it changed on disk. Long-running tools
 * stream MCP $/progress and honor notifications/cancelled.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MockManager } from "../mock/server.js";
import type { SpecStore } from "../spec/store.js";
import { FactError } from "../types.js";
import type { ProgressSink } from "../verify/config.js";
import { devTools, executeDevTool } from "./tools.js";
import {
  listSpecResources,
  readSpecResource,
  specResourceTemplates,
} from "./resources.js";

export interface CreateServerOptions {
  /** Trusted host-configured source root. Defaults to the specification directory. */
  projectRoot?: string;
  defaultBaseUrl?: string;
  allowHosts?: string[];
  name?: string;
  version?: string;
  /** Free-form usage instructions surfaced during MCP initialization. */
  instructions?: string;
  /** Preferred port for the first mock server when the tool omits one. */
  mockPort?: number;
  /**
   * Share one MockManager across the embedded MCP server and the host
   * application so UI-started and AI-started mocks appear in one list.
   */
  mockManager?: MockManager;
  /** Host retains ownership of a shared mock manager. */
  keepMocksOnClose?: boolean;
}

const DEFAULT_INSTRUCTIONS = [
  "Powerduck developer MCP gives you accurate, dereferenced OpenAPI facts for the backend you are implementing and verifies it against a running server.",
  "Call spec_overview and list_operations to orient yourself, then get_operation before writing each handler so parameters, request bodies, responses, and auth match the specification.",
  "Use ping_target, send_request, run_contract_tests, detect_drift, validate_scenario, and run_scenario to verify the implementation as you build it. detect_drift classifies missing, unreachable, and contract-violating operations in one pass.",
  "When a dependency is not implemented yet (payment, OTP, downstream services), start_mock_server returns a local base URL you can target; get_mock_requests shows what your implementation sent.",
  "For source-first projects, call get_code_scan_capabilities and scan_code_to_openapi to generate a contract without writing files. Review diagnostics and unresolved gaps before saving the result.",
  "Use publish_code_docs to scan source and obtain a local documentation URL. Cloud publication requires target cloud and user authorization; get_code_docs_status returns the final link.",
  "Call validate_spec after the specification changes. The document is re-read from disk on every request.",
].join(" ");

function jsonText(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: FactError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function createDevMcpServer(
  store: SpecStore,
  options: CreateServerOptions = {},
): Server {
  const publicationManager = new PublicationManager();
  const mockManager =
    options.mockManager ??
    new MockManager(
      typeof options.mockPort === "number"
        ? { preferredPort: options.mockPort }
        : {},
    );
  const server = new Server(
    {
      name: options.name ?? "powerduck-dev-mcp",
      version: options.version ?? "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: devTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args, _meta } = request.params;
    const progressToken = _meta?.progressToken;
    const sink: ProgressSink = { signal: extra.signal };
    if (progressToken !== undefined) {
      sink.report = (progress, total, message) => {
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total ? { total } : {}),
            ...(message ? { message } : {}),
          },
        });
      };
    }

    try {
      const result = await executeDevTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        store,
        sink,
        mockManager,
        { ...options, publicationManager },
      );
      return jsonText(result);
    } catch (error) {
      if (error instanceof FactError) return errorResult(error);
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(new FactError("internal_error", message));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await listSpecResources(store),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: specResourceTemplates,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      const contents = await readSpecResource(uri, store);
      return {
        contents: [
          {
            uri: contents.uri,
            mimeType: contents.mimeType,
            text: contents.text,
          },
        ],
      };
    } catch (error) {
      if (error instanceof FactError) throw error;
      throw new FactError(
        "resource_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  server.onclose = async () => {
    publicationManager.close();
    if (!options.keepMocksOnClose) await mockManager.stopAll();
  };

  return server;
}
