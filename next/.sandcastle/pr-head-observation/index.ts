export class PrHeadObservationError extends Error {
  override readonly name = "PrHeadObservationError";
}

export const waitForExpectedPrHead = async (options: {
  readonly expectedHead: string;
  readonly now: () => number;
  readonly pause: () => Promise<void>;
  readonly readHead: () => string;
  readonly timeoutMs: number;
}) => {
  const deadline = options.now() + options.timeoutMs;
  let currentHead = options.readHead();
  while (currentHead !== options.expectedHead && options.now() < deadline) {
    await options.pause();
    currentHead = options.readHead();
  }
  if (currentHead !== options.expectedHead) {
    throw new PrHeadObservationError(
      `PR head mismatch after bounded observation: expected ${options.expectedHead}, received ${currentHead}.`
    );
  }
};
