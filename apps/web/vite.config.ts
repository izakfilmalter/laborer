import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), tanstackRouter({}), react()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	server: {
		port: 3001,
		fs: { strict: false },
		proxy: {
			"/rpc": {
				target: "http://localhost:3000",
				ws: true,
			},
			"/terminal": {
				target: "http://localhost:3000",
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
