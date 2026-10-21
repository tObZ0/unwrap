/** Typed, user-safe errors. `message` is always safe to show publicly. */
export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "UNKNOWN_NETWORK"
  | "NETWORK_DISABLED"
  | "CHAIN_ID_MISMATCH"
  | "NETWORK_UNAVAILABLE"
  | "NO_CONTRACT_CODE"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "AI_NOT_CONFIGURED"
  | "AI_FAILED"
  | "STORAGE_ERROR"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_ADDRESS: 400,
  UNKNOWN_NETWORK: 400,
  NETWORK_DISABLED: 400,
  CHAIN_ID_MISMATCH: 502,
  NETWORK_UNAVAILABLE: 503,
  NO_CONTRACT_CODE: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  AI_NOT_CONFIGURED: 503,
  AI_FAILED: 502,
  STORAGE_ERROR: 503,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
