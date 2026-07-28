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

export const canRetryGateAfterIncompleteRepair = (
  result: { readonly completionSignal?: string },
  gatedHead: string,
  currentHead: string
) => result.completionSignal === undefined && currentHead === gatedHead;

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

export const assertRecordedRecoveryLineage = (
  acceptedHead: string | undefined,
  recoveryHead: string,
  isAncestor: (ancestor: string, descendant: string) => boolean
) => {
  if (acceptedHead !== undefined && !isAncestor(acceptedHead, recoveryHead)) {
    throw new Error(
      `Recovery head ${recoveryHead} does not descend from accepted head ${acceptedHead}.`
    );
  }
};

export const classifyBranchRecovery = ({
  acceptedHead,
  completedHead,
  currentHead,
  gatePassedHead,
  gatePendingHead,
  implementationHead,
  progressHead,
  uiReviewedHead,
}: {
  readonly acceptedHead: string;
  readonly completedHead: string | undefined;
  readonly currentHead: string;
  readonly gatePassedHead: string | undefined;
  readonly gatePendingHead: string | undefined;
  readonly implementationHead: string | undefined;
  readonly progressHead: string | undefined;
  readonly uiReviewedHead: string | undefined;
}) => {
  if (currentHead === completedHead) {
    return "publish" as const;
  }
  if (currentHead === gatePassedHead) {
    return "complete" as const;
  }
  if (currentHead === gatePendingHead) {
    return "gate" as const;
  }
  if (currentHead === uiReviewedHead) {
    return "code-review" as const;
  }
  if (currentHead === progressHead) {
    return "review" as const;
  }
  if (currentHead === implementationHead) {
    return "ui" as const;
  }
  if (currentHead === acceptedHead) {
    return "build" as const;
  }
  throw new Error(
    `Branch contains unrecorded commits after accepted head ${acceptedHead}.`
  );
};
