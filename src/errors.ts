// Configuration problems are reported to the operator, so their messages must never include
// secret values: only variable names and expected choices.
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}
