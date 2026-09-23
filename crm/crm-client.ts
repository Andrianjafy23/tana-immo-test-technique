import { randomUUID } from "node:crypto";

/**
 * Client for creating leads in the customer's CRM.
 *
 * Behavior:
 * - 5s timeout per attempt
 * - automatically retries on temporary errors (429, 5xx, network timeout)
 * - respects the Retry-After header on a 429 (capped at MAX_RETRY_DELAY_MS,
 *   see note in README/REPONSES)
 * - gives up immediately on a definitive error (400, 401...)
 * - an idempotency key guarantees the same lead is never created twice,
 *   even if createLead() retries several times
 * - the token never appears in an error message or a log
 */

export interface Lead {
  listingId: string;
  name: string;
  phone: string;
  email: string;
  message: string;
}

export interface CreateLeadResult {
  id: string;
  createdAt: string;
}

export interface CrmClientOptions {
  /** Bearer token used to authenticate against the CRM. */
  token: string;
  /** CRM endpoint. Defaults to DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** Injectable fetch implementation, mainly for testing. */
  fetchImpl?: typeof fetch;
  /** Max number of attempts (including the first one) before giving up. */
  maxAttempts?: number;
  /** Timeout in ms for a single attempt. */
  timeoutMs?: number;
  /** Base delay (ms) for the exponential backoff. Lowered in tests to run faster. */
  retryBaseDelayMs?: number;
}

/** CrmClientOptions with every optional field resolved to a concrete value. */
interface ResolvedConfig {
  token: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  maxAttempts: number;
  timeoutMs: number;
  retryBaseDelayMs: number;
}

/**
 * Error thrown by the CRM client.
 * `retryable` tells the caller (and the internal retry loop) whether
 * this error is worth retrying.
 */
export class CrmClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CrmClientError";
  }
}

const DEFAULT_BASE_URL = "https://crm.example.com/v1/leads";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
/** Hard cap on any retry delay, even if Retry-After asks for more. */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Creates a CRM client bound to the given options.
 * @param options - See CrmClientOptions.
 * @returns An object exposing `createLead(lead, idempotencyKey?)`.
 */
export function createCrmClient(options: CrmClientOptions) {
  const config = resolveConfig(options);
  return {
    createLead: (lead: Lead, idempotencyKey = randomUUID()) =>
      createLead(config, lead, idempotencyKey),
  };
}

/**
 * Fills in defaults for optional options and validates the token.
 * @throws {Error} If no token is provided.
 */
function resolveConfig(options: CrmClientOptions): ResolvedConfig {
  const {
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  } = options;

  if (!token) {
    throw new Error("CrmClient: missing auth token");
  }

  return {
    token,
    baseUrl,
    fetchImpl,
    maxAttempts,
    timeoutMs,
    retryBaseDelayMs,
  };
}

/**
 * Creates a lead, retrying on temporary errors up to `maxAttempts` times.
 * The same idempotency key is reused across all attempts for one lead,
 * so a retry never creates a duplicate on the CRM side.
 * @param config - Resolved client configuration.
 * @param lead - Lead data to send.
 * @param idempotencyKey - Same key reused for every retry of this lead.
 * @throws {CrmClientError} The last error, once retries are exhausted
 *   or a non-retryable error is received.
 */
async function createLead(
  config: ResolvedConfig,
  lead: Lead,
  idempotencyKey: string,
): Promise<CreateLeadResult> {
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await sendCreateLeadRequest(config, lead, idempotencyKey);
    } catch (error) {
      const canRetry =
        error instanceof CrmClientError &&
        error.retryable &&
        attempt < config.maxAttempts;
      if (!canRetry) throw error;

      await wait(
        retryDelayMs(attempt, error as CrmClientError, config.retryBaseDelayMs),
      );
    }
  }

  throw new CrmClientError("createLead: no attempt was made");
}

/**
 * Computes how long to wait before the next retry.
 * Prefers the server's Retry-After hint (on a 429) over the exponential
 * backoff, always capped at MAX_RETRY_DELAY_MS.
 */
function retryDelayMs(
  attempt: number,
  error: CrmClientError,
  baseDelayMs: number,
): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  return Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Performs a single create-lead attempt: sends the request and either
 * returns the parsed result or throws a typed CrmClientError.
 */
async function sendCreateLeadRequest(
  config: ResolvedConfig,
  lead: Lead,
  idempotencyKey: string,
): Promise<CreateLeadResult> {
  const response = await fetchWithTimeout(config, lead, idempotencyKey);

  if (response.ok) {
    return parseJsonResponse(response);
  }
  throw toCrmError(response);
}

/**
 * Sends the POST request to the CRM with an abort-based timeout.
 * Any network error or timeout is turned into a retryable CrmClientError,
 * with the original error kept as `cause` for debugging (never logs the token).
 */
async function fetchWithTimeout(
  config: ResolvedConfig,
  lead: Lead,
  idempotencyKey: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    return await config.fetchImpl(config.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(lead),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CrmClientError(
      "Network error or timeout while calling CRM",
      undefined,
      true,
      undefined,
      {
        cause: error,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parses a successful (2xx) response body as JSON.
 * A malformed body is treated as a non-retryable CrmClientError.
 */
async function parseJsonResponse(
  response: Response,
): Promise<CreateLeadResult> {
  try {
    return (await response.json()) as CreateLeadResult;
  } catch (error) {
    throw new CrmClientError(
      "CRM returned an invalid JSON response",
      response.status,
      false,
      undefined,
      {
        cause: error,
      },
    );
  }
}

/**
 * Maps an HTTP error status to a typed CrmClientError.
 * 429 and 5xx are retryable; anything else (400, 401...) is definitive.
 */
function toCrmError(response: Response): CrmClientError {
  const { status } = response;

  if (status === 429) {
    return new CrmClientError(
      "CRM rate limited",
      status,
      true,
      parseRetryAfterMs(response),
    );
  }
  if (status >= 500) {
    return new CrmClientError(`CRM temporary error (${status})`, status, true);
  }
  return new CrmClientError(
    `CRM rejected the request (${status})`,
    status,
    false,
  );
}

/**
 * Parses the Retry-After header (in seconds) into milliseconds.
 * @returns The delay in ms, or undefined if the header is missing/invalid.
 */
function parseRetryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Resolves after the given delay, in milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
