import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect } from "effect";
import {
  makeLaborerMemoryMcpServer,
  publishLaborerMemoryMcpReadiness,
  recordLaborerMemoryDiagnostic,
} from "./memory-mcp.ts";

const root = process.env.LABORER_MEMORY_ROOT;
const workspaceId = process.env.LABORER_MEMORY_WORKSPACE_ID;
const serverName = process.env.LABORER_MEMORY_SERVER_NAME;
const authorityGuard = process.env.LABORER_MEMORY_AUTHORITY_GUARD;
const readinessNonce = process.env.LABORER_MEMORY_REGISTRATION_NONCE;
const readinessPath = process.env.LABORER_MEMORY_READY_PATH;

if (root === undefined || workspaceId === undefined) {
  process.stderr.write(
    "[laborer-memory] fixed workspace configuration missing\n"
  );
  process.exitCode = 1;
} else {
  const program = Effect.gen(function* () {
    const runReadiness = Effect.runPromiseWith(yield* Effect.context<never>());
    if (process.env.LABORER_MEMORY_TEST_FAIL_STARTUP === "1") {
      return yield* Effect.die(
        new Error("Injected memory MCP startup failure")
      );
    }
    const server = yield* makeLaborerMemoryMcpServer({
      ...(authorityGuard === undefined ? {} : { authorityGuard }),
      root,
      ...(serverName === undefined ? {} : { serverName }),
      workspaceId,
    });
    if (
      serverName !== undefined &&
      readinessNonce !== undefined &&
      readinessPath !== undefined
    ) {
      server.server.oninitialized = () => {
        runReadiness(
          publishLaborerMemoryMcpReadiness({
            ...(authorityGuard === undefined ? {} : { authorityGuard }),
            nonce: readinessNonce,
            path: readinessPath,
            root,
            serverName,
            workspaceId,
          })
        ).catch(() => {
          process.stderr.write(
            "[laborer-memory] registration readiness failed\n"
          );
          process.exitCode = 1;
        });
      };
    }
    yield* Effect.promise(() => server.connect(new StdioServerTransport()));
  });
  Effect.runPromise(program).catch(async () => {
    await Effect.runPromise(
      recordLaborerMemoryDiagnostic({
        ...(authorityGuard === undefined ? {} : { authorityGuard }),
        code: "startup-failed",
        root,
        workspaceId,
      })
    );
    process.stderr.write("[laborer-memory] server startup failed\n");
    process.exitCode = 1;
  });
}
