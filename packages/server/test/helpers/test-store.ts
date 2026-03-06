import { schema } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Layer } from "effect";
import { LaborerStore } from "../../src/services/laborer-store.js";

const makeTestStore = Effect.gen(function* () {
	const adapter = makeAdapter({ storage: { type: "in-memory" } });
	const store = yield* createStore({
		schema,
		storeId: `test-${crypto.randomUUID()}`,
		adapter,
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});

	return { store };
}).pipe(provideOtel({}));

export const TestLaborerStore: Layer.Layer<LaborerStore> = Layer.scoped(
	LaborerStore,
	makeTestStore
).pipe(Layer.orDie);
