import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Vite injects env vars on `import.meta.env` at build time.
// The env package is compiled with Node types, so `import.meta.env` is not
// typed. We use a runtime-safe access pattern and cast for type safety.
const runtimeEnv = (
	import.meta as unknown as { env?: Record<string, string | undefined> }
).env;

export const env = createEnv({
	clientPrefix: "VITE_",
	client: {
		VITE_SERVER_URL: z.string().url().default("http://localhost:3000"),
	},
	runtimeEnv: {
		VITE_SERVER_URL: runtimeEnv?.VITE_SERVER_URL,
	},
	emptyStringAsUndefined: true,
});
