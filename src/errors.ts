// Configuration problems are reported to the operator, so their messages must never include
// secret values: only variable names and expected choices.
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

// Startup state that blocks service without being a configuration mistake, such as a data directory
// bound to another identity. Its message is operator-facing and safe to log.
export class StateError extends Error {
  override name = "StateError";
}

/**
 * Channel-independent failure code for logging and for stored rows. Only codes this application
 * writes are reported: an unknown error becomes EXECUTION_ERROR instead of echoing a foreign
 * message that may embed paths, bodies or credentials.
 */
export function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "EXECUTION_ERROR";
}

export const GATE_SELFTEST_FIXTURE = "xoxb-7777777777777777777777";
