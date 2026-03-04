/**
 * Laborer Server — Entry Point
 *
 * Bun server running Effect TS services. Manages all side effects:
 * process spawning, PTY management, git operations, file system access,
 * and port allocation. Exposes an Effect RPC API and serves as the
 * LiveStore sync backend.
 *
 * Future issues will add:
 * - Effect runtime initialization (Issue #11)
 * - Health check RPC endpoint (Issue #12)
 * - Environment validation (Issue #15)
 * - LiveStore server adapter (Issue #16)
 * - Effect RPC router (Issue #19)
 * - Effect services (WorkspaceProvider, TerminalManager, DiffService, etc.)
 */

const PORT = 3000;

const server = Bun.serve({
	port: PORT,
	fetch(_req) {
		return new Response("Laborer server is running", {
			status: 200,
			headers: { "Content-Type": "text/plain" },
		});
	},
});

console.log(`Laborer server listening on http://localhost:${server.port}`);
