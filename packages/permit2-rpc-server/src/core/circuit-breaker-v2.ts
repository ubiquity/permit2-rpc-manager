export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

export interface CircuitBreakerV2Options {
  threshold?: number;
  timeoutMs?: number;
  halfOpenTestLimit?: number;
  now?: () => number;
}

export interface ErrorClassificationLike {
  reason?: string;
  isProviderIssue?: boolean;
}

interface CircuitInfo {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  halfOpenSuccesses: number;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HALF_OPEN_TEST_LIMIT = 3;

const PROVIDER_FAULT_REASONS = new Set<string>([
  "rate_limit",
  "quota_exceeded",
  "server_error",
  "timeout",
  "network_error",
  "provider_error",
  "forbidden",
  "unauthorized",
  "auth_error",
  "billing_error",
  "stale_head",
  "syncing_empty",
]);

function countsAsProviderFailure(classification: ErrorClassificationLike | undefined): boolean {
  if (!classification) return false;
  if (classification.isProviderIssue) return true;
  const reason = classification.reason?.trim().toLowerCase();
  if (!reason) return false;
  return PROVIDER_FAULT_REASONS.has(reason);
}

export class CircuitBreakerV2 {
  private states = new Map<string, CircuitInfo>();
  private threshold: number;
  private timeoutMs: number;
  private halfOpenTestLimit: number;
  private now: () => number;

  constructor(options: CircuitBreakerV2Options = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.halfOpenTestLimit = options.halfOpenTestLimit ?? DEFAULT_HALF_OPEN_TEST_LIMIT;
    this.now = options.now ?? Date.now;
  }

  canRequest(rpcUrl: string): boolean {
    const circuit = this.states.get(rpcUrl);
    if (!circuit) return true;

    const now = this.now();

    switch (circuit.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        if (now - circuit.lastFailure > this.timeoutMs) {
          circuit.state = CircuitState.HALF_OPEN;
          circuit.halfOpenSuccesses = 0;
          this.states.set(rpcUrl, circuit);
          return true;
        }
        return false;
      }

      case CircuitState.HALF_OPEN:
        return circuit.halfOpenSuccesses < this.halfOpenTestLimit;
    }
  }

  recordResult(rpcUrl: string, classification: ErrorClassificationLike | undefined, success: boolean): void {
    const circuit = this.states.get(rpcUrl) ?? {
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailure: 0,
      halfOpenSuccesses: 0,
    };

    // Treat non-provider errors as "success" for circuit health (provider is reachable).
    const providerFailure = !success && countsAsProviderFailure(classification);
    const effectiveSuccess = success || !providerFailure;

    if (effectiveSuccess) {
      if (circuit.state === CircuitState.HALF_OPEN) {
        circuit.halfOpenSuccesses++;
        if (circuit.halfOpenSuccesses >= this.halfOpenTestLimit) {
          this.states.set(rpcUrl, {
            state: CircuitState.CLOSED,
            failures: 0,
            lastFailure: 0,
            halfOpenSuccesses: 0,
          });
          return;
        }
      } else if (circuit.state === CircuitState.CLOSED) {
        circuit.failures = 0;
      }

      this.states.set(rpcUrl, circuit);
      return;
    }

    // Provider-fault failure
    circuit.failures++;
    circuit.lastFailure = this.now();

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.OPEN;
      circuit.halfOpenSuccesses = 0;
    } else if (circuit.state === CircuitState.CLOSED && circuit.failures >= this.threshold) {
      circuit.state = CircuitState.OPEN;
    }

    this.states.set(rpcUrl, circuit);
  }

  getState(rpcUrl: string): CircuitState {
    return this.states.get(rpcUrl)?.state ?? CircuitState.CLOSED;
  }
}
