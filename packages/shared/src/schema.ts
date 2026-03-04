import { Events, makeSchema, Schema, State } from "@livestore/livestore";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const projects = State.SQLite.table({
	name: "projects",
	columns: {
		id: State.SQLite.text({ primaryKey: true }),
		repoPath: State.SQLite.text(),
		name: State.SQLite.text(),
		rlphConfig: State.SQLite.text({ nullable: true }),
	},
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const projectCreated = Events.synced({
	name: "v1.ProjectCreated",
	schema: Schema.Struct({
		id: Schema.String,
		repoPath: Schema.String,
		name: Schema.String,
		rlphConfig: Schema.NullOr(Schema.String),
	}),
});

export const projectRemoved = Events.synced({
	name: "v1.ProjectRemoved",
	schema: Schema.Struct({
		id: Schema.String,
	}),
});

export const events = {
	projectCreated,
	projectRemoved,
};

// ---------------------------------------------------------------------------
// Materializers
// ---------------------------------------------------------------------------

const materializers = State.SQLite.materializers(events, {
	"v1.ProjectCreated": ({ id, repoPath, name, rlphConfig }) =>
		projects.insert({ id, repoPath, name, rlphConfig }),
	"v1.ProjectRemoved": ({ id }) => projects.delete().where({ id }),
});

// ---------------------------------------------------------------------------
// Tables export
// ---------------------------------------------------------------------------

export const tables = { projects };

// ---------------------------------------------------------------------------
// State & Schema
// ---------------------------------------------------------------------------

const state = State.SQLite.makeState({ tables, materializers });

export const schema = makeSchema({ events, state });
