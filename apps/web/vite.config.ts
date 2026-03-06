import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Regex for stripping the /terminal-rpc prefix when proxying to the terminal service. */
const TERMINAL_RPC_PREFIX = /^\/terminal-rpc/;
const webPort = Number(process.env.WEB_PORT ?? "3001");
const serverPort = Number(process.env.PORT ?? "3000");
const terminalPort = Number(process.env.TERMINAL_PORT ?? "3002");

export default defineConfig({
	plugins: [tailwindcss(), tanstackRouter({}), react()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	server: {
		port: webPort,
		fs: { strict: false },
		proxy: {
			"/rpc": {
				target: `http://localhost:${serverPort}`,
				ws: true,
			},
			"/terminal-rpc": {
				target: `http://localhost:${terminalPort}`,
				rewrite: (p) => p.replace(TERMINAL_RPC_PREFIX, "/rpc"),
			},
			"/terminal": {
				target: `http://localhost:${terminalPort}`,
				ws: true,
			},
		},
	},
	worker: {
		format: "es",
	},
	optimizeDeps: {
		exclude: ["@livestore/adapter-web"],
	},
});
