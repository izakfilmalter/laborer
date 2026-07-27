export const assertAgentCompleted = (
  result: { readonly completionSignal?: string },
  context: string
) => {
  if (result.completionSignal === undefined) {
    throw new Error(
      `Agent did not emit its completion signal during ${context}.`
    );
  }
};

export const assertNewWorkAfterAcceptedHead = (
  acceptedHead: string,
  completedHead: string,
  context: string
) => {
  if (completedHead === acceptedHead) {
    throw new Error(
      `${context} completed without work after its accepted head.`
    );
  }
};

export const classifyBranchRecovery = (
  acceptedHead: string,
  currentHead: string,
  completedHead: string | undefined,
  progressHead: string | undefined
) => {
  if (currentHead === acceptedHead) {
    return "build" as const;
  }
  if (currentHead === completedHead) {
    return "publish" as const;
  }
  if (currentHead === progressHead) {
    return "verify" as const;
  }
  throw new Error(
    `Branch contains unrecorded commits after accepted head ${acceptedHead}.`
  );
};
