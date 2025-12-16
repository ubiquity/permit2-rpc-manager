export const HEDGE_ABORT_REASON = "hedged-loser";

export interface HedgeConfig {
  enabled: boolean;
  maxHedges: number;
  delayMs: number;
  quantile?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export class HedgedNonRetryableError extends Error {
  constructor(public override readonly cause: unknown) {
    super("Non-retryable error during hedged request");
    this.name = "HedgedNonRetryableError";
  }
}

type AttemptOutcome<T> =
  | { type: "success"; rpcUrl: string; value: T }
  | { type: "error"; rpcUrl: string; error: unknown; aborted: boolean; abortReason?: unknown };

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HedgedRequester {
  constructor(private readonly now: () => number = Date.now) {}

  async execute<T>(
    candidates: string[],
    requestFn: (rpcUrl: string, signal: AbortSignal) => Promise<T>,
    policy: { maxHedges: number; delayMs: number },
  ): Promise<T> {
    const urls = candidates.filter((c) => typeof c === "string" && c.length > 0);
    if (urls.length === 0) {
      throw new Error("No candidates provided to hedged requester");
    }

    if (urls.length === 1 || policy.maxHedges <= 0) {
      const controller = new AbortController();
      return await requestFn(urls[0], controller.signal);
    }

    const concurrencyLimit = Math.max(1, 1 + policy.maxHedges);
    const controllers: AbortController[] = [];
    const inFlight = new Map<number, Promise<AttemptOutcome<T>>>();
    let nextIndex = 0;
    let lastError: unknown;

    const startAttempt = (index: number) => {
      const rpcUrl = urls[index];
      const controller = new AbortController();
      controllers[index] = controller;

      const promise = (async (): Promise<AttemptOutcome<T>> => {
        try {
          const value = await requestFn(rpcUrl, controller.signal);
          return { type: "success", rpcUrl, value };
        } catch (error) {
          return {
            type: "error",
            rpcUrl,
            error,
            aborted: controller.signal.aborted,
            abortReason: controller.signal.reason,
          };
        }
      })();

      inFlight.set(index, promise);
    };

    // Start primary.
    startAttempt(nextIndex);
    nextIndex++;
    let nextHedgeAt = this.now() + Math.max(0, policy.delayMs);

    const abortAllExcept = (winnerIndex: number | null) => {
      for (let i = 0; i < controllers.length; i++) {
        if (winnerIndex !== null && i === winnerIndex) continue;
        const controller = controllers[i];
        if (!controller || controller.signal.aborted) continue;
        controller.abort(HEDGE_ABORT_REASON);
      }
    };

    while (inFlight.size > 0) {
      // If we have capacity and time has passed, start another hedge.
      const canStartMore = nextIndex < urls.length && inFlight.size < concurrencyLimit;

      const delayMs = canStartMore ? Math.max(0, nextHedgeAt - this.now()) : Number.POSITIVE_INFINITY;
      const delayPromise = canStartMore ? sleep(delayMs).then(() => ({ type: "delay" as const })) : null;

      const raced = await Promise.race([
        ...[...inFlight.entries()].map(async ([index, promise]) => ({ index, ...(await promise) })),
        ...(delayPromise ? [delayPromise] : []),
      ]);

      if ("type" in raced && raced.type === "delay") {
        if (nextIndex < urls.length && inFlight.size < concurrencyLimit) {
          startAttempt(nextIndex);
          nextIndex++;
          nextHedgeAt = this.now() + Math.max(0, policy.delayMs);
        }
        continue;
      }

      const { index, type } = raced as { index: number } & AttemptOutcome<T>;
      inFlight.delete(index);

      if (type === "success") {
        abortAllExcept(index);
        return (raced as any).value as T;
      }

      const error = (raced as any).error as unknown;
      const aborted = (raced as any).aborted as boolean;
      const abortReason = (raced as any).abortReason as unknown;

      if (aborted && abortReason === HEDGE_ABORT_REASON) {
        // Expected cancellation of a losing hedge.
        continue;
      }

      if (error instanceof HedgedNonRetryableError) {
        abortAllExcept(null);
        throw error.cause instanceof Error ? error.cause : new Error(String(error.cause));
      }

      lastError = error;

      // On error, opportunistically start the next candidate immediately if we have capacity.
      if (nextIndex < urls.length && inFlight.size < concurrencyLimit) {
        startAttempt(nextIndex);
        nextIndex++;
        nextHedgeAt = this.now() + Math.max(0, policy.delayMs);
      }

      // Loop continues; other in-flight requests may still succeed.
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All hedged attempts failed"));
  }
}
