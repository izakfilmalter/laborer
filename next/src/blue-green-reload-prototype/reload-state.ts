export type GenerationPhase = "active" | "draining" | "prepared" | "released";

export interface Generation {
  readonly id: string;
  readonly inFlight: readonly string[];
  readonly phase: GenerationPhase;
}

export interface ReloadState {
  readonly activeGenerationId: string;
  readonly candidateGenerationId: string | null;
  readonly generations: readonly Generation[];
  readonly queuedWork: readonly string[];
}

const initialState = (): ReloadState => ({
  activeGenerationId: "blue",
  candidateGenerationId: null,
  generations: [{ id: "blue", inFlight: [], phase: "active" }],
  queuedWork: [],
});

const generationById = (
  state: ReloadState,
  id: string
): Generation | undefined =>
  state.generations.find((generation) => generation.id === id);

const replaceGeneration = (
  state: ReloadState,
  replacement: Generation
): ReloadState => ({
  ...state,
  generations: state.generations.map((generation) =>
    generation.id === replacement.id ? replacement : generation
  ),
});

const assertInvariant = (state: ReloadState): void => {
  const owners = state.generations.filter(
    (generation) =>
      generation.phase === "active" || generation.phase === "draining"
  );
  if (owners.length !== 1 || owners[0]?.id !== state.activeGenerationId) {
    throw new Error("exactly one generation must own runtime state");
  }
  if (
    state.candidateGenerationId !== null &&
    generationById(state, state.candidateGenerationId)?.phase !== "prepared"
  ) {
    throw new Error("the candidate must remain prepared until cutover");
  }
};

export class BlueGreenReloadPrototype {
  private state: ReloadState = initialState();

  snapshot(): ReloadState {
    return structuredClone(this.state);
  }

  reset(): string {
    this.state = initialState();
    return "reset with blue active";
  }

  prepare(id: string, succeeds = true): string {
    if (generationById(this.state, id) !== undefined) {
      return `ignored: generation ${id} already exists`;
    }
    if (!succeeds) {
      return `preparation failed: ${id}; active generation unchanged`;
    }
    this.state = {
      ...this.state,
      generations: [
        ...this.state.generations,
        { id, inFlight: [], phase: "prepared" },
      ],
    };
    assertInvariant(this.state);
    return `prepared ${id} without runtime ownership`;
  }

  beginReload(candidateId: string): string {
    const candidate = generationById(this.state, candidateId);
    if (candidate?.phase !== "prepared") {
      return `reload rejected: ${candidateId} is not prepared`;
    }
    if (this.state.candidateGenerationId !== null) {
      return `reload rejected: ${this.state.candidateGenerationId} is already pending`;
    }
    const active = generationById(this.state, this.state.activeGenerationId);
    if (active?.phase !== "active") {
      return "reload rejected: active generation is not accepting work";
    }
    this.state = replaceGeneration(
      {
        ...this.state,
        candidateGenerationId: candidateId,
      },
      { ...active, phase: "draining" }
    );
    const cutover = this.cutOverIfDrained();
    assertInvariant(this.state);
    return cutover
      ? `reloaded immediately to ${candidateId}`
      : `${active.id} is draining for ${candidateId}`;
  }

  submitWork(workId: string): string {
    if (this.hasWork(workId)) {
      return `ignored duplicate work: ${workId}`;
    }
    const active = generationById(this.state, this.state.activeGenerationId);
    if (active?.phase === "draining") {
      this.state = {
        ...this.state,
        queuedWork: [...this.state.queuedWork, workId],
      };
      assertInvariant(this.state);
      return `queued ${workId} durably while ${active.id} drains`;
    }
    if (active?.phase !== "active") {
      throw new Error("active generation cannot accept work");
    }
    this.state = replaceGeneration(this.state, {
      ...active,
      inFlight: [...active.inFlight, workId],
    });
    assertInvariant(this.state);
    return `started ${workId} on ${active.id}`;
  }

  completeWork(workId: string): string {
    const owner = this.state.generations.find((generation) =>
      generation.inFlight.includes(workId)
    );
    if (owner === undefined) {
      return `ignored: no in-flight work named ${workId}`;
    }
    this.state = replaceGeneration(this.state, {
      ...owner,
      inFlight: owner.inFlight.filter((candidate) => candidate !== workId),
    });
    const cutover = this.cutOverIfDrained();
    assertInvariant(this.state);
    return cutover
      ? `completed ${workId}; cut over to ${this.state.activeGenerationId}`
      : `completed ${workId} on ${owner.id}`;
  }

  private cutOverIfDrained(): boolean {
    const candidateId = this.state.candidateGenerationId;
    if (candidateId === null) {
      return false;
    }
    const active = generationById(this.state, this.state.activeGenerationId);
    const candidate = generationById(this.state, candidateId);
    if (
      active?.phase !== "draining" ||
      active.inFlight.length > 0 ||
      candidate?.phase !== "prepared"
    ) {
      return false;
    }
    const queuedWork = this.state.queuedWork;
    const released = { ...active, phase: "released" as const };
    const activated = {
      ...candidate,
      inFlight: queuedWork,
      phase: "active" as const,
    };
    this.state = {
      activeGenerationId: candidateId,
      candidateGenerationId: null,
      generations: this.state.generations.map((generation) => {
        if (generation.id === released.id) {
          return released;
        }
        if (generation.id === activated.id) {
          return activated;
        }
        return generation;
      }),
      queuedWork: [],
    };
    return true;
  }

  private hasWork(workId: string): boolean {
    return (
      this.state.queuedWork.includes(workId) ||
      this.state.generations.some((generation) =>
        generation.inFlight.includes(workId)
      )
    );
  }
}
