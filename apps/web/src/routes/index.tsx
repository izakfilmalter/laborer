import { projects, workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { createFileRoute } from "@tanstack/react-router";
import { useLaborerStore } from "@/livestore/store";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

const TITLE_TEXT = `
 ██╗      █████╗ ██████╗  ██████╗ ██████╗ ███████╗██████╗
 ██║     ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██╔════╝██╔══██╗
 ██║     ███████║██████╔╝██║   ██║██████╔╝█████╗  ██████╔╝
 ██║     ██╔══██║██╔══██╗██║   ██║██╔══██╗██╔══╝  ██╔══██╗
 ███████╗██║  ██║██████╔╝╚██████╔╝██║  ██║███████╗██║  ██║
 ╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
 `;

const allProjects$ = queryDb(projects, { label: "allProjects" });
const allWorkspaces$ = queryDb(workspaces, { label: "allWorkspaces" });

function HomeComponent() {
	const store = useLaborerStore();
	const projectList = store.useQuery(allProjects$);
	const workspaceList = store.useQuery(allWorkspaces$);

	return (
		<div className="container mx-auto max-w-3xl px-4 py-2">
			<pre className="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
			<div className="grid gap-6">
				<section className="rounded-lg border p-4">
					<h2 className="mb-2 font-medium">LiveStore Status</h2>
					<p className="text-muted-foreground text-sm">
						Projects: {projectList.length} | Workspaces: {workspaceList.length}
					</p>
				</section>
			</div>
		</div>
	);
}
