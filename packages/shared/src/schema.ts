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

export const workspaces = State.SQLite.table({
	name: "workspaces",
	columns: {
		id: State.SQLite.text({ primaryKey: true }),
		projectId: State.SQLite.text(),
		taskSource: State.SQLite.text({ nullable: true }),
		branchName: State.SQLite.text(),
		worktreePath: State.SQLite.text(),
		port: State.SQLite.integer(),
		status: State.SQLite.text({ default: "creating" }),
		createdAt: State.SQLite.text(),
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

export const workspaceCreated = Events.synced({
	name: "v1.WorkspaceCreated",
	schema: Schema.Struct({
		id: Schema.String,
		projectId: Schema.String,
		taskSource: Schema.NullOr(Schema.String),
		branchName: Schema.String,
		worktreePath: Schema.String,
		port: Schema.Number,
		status: Schema.String,
		createdAt: Schema.String,
	}),
});

export const workspaceStatusChanged = Events.synced({
	name: "v1.WorkspaceStatusChanged",
	schema: Schema.Struct({
		id: Schema.String,
		status: Schema.String,
	}),
});

export const workspaceDestroyed = Events.synced({
	name: "v1.WorkspaceDestroyed",
	schema: Schema.Struct({
		id: Schema.String,
	}),
});

export const events = {
	projectCreated,
	projectRemoved,
	workspaceCreated,
	workspaceStatusChanged,
	workspaceDestroyed,
};

// ---------------------------------------------------------------------------
// Materializers
// ---------------------------------------------------------------------------

const materializers = State.SQLite.materializers(events, {
	"v1.ProjectCreated": ({ id, repoPath, name, rlphConfig }) =>
		projects.insert({ id, repoPath, name, rlphConfig }),
	"v1.ProjectRemoved": ({ id }) => projects.delete().where({ id }),
	"v1.WorkspaceCreated": ({
		id,
		projectId,
		taskSource,
		branchName,
		worktreePath,
		port,
		status,
		createdAt,
	}) =>
		workspaces.insert({
			id,
			projectId,
			taskSource,
			branchName,
			worktreePath,
			port,
			status,
			createdAt,
		}),
	"v1.WorkspaceStatusChanged": ({ id, status }) =>
		workspaces.update({ status }).where({ id }),
	"v1.WorkspaceDestroyed": ({ id }) => workspaces.delete().where({ id }),
});

// ---------------------------------------------------------------------------
// Tables export
// ---------------------------------------------------------------------------

export const tables = { projects, workspaces };

// ---------------------------------------------------------------------------
// State & Schema
// ---------------------------------------------------------------------------

const state = State.SQLite.makeState({ tables, materializers });

export const schema = makeSchema({ events, state });
