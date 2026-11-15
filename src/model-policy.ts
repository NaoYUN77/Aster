import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Which catalog models a chat command may select by hand.
 *
 * The automatic chain is configured separately (MODEL_ID + MODEL_FALLBACKS). This policy is only
 * about the `$model` command: Jay restricted it to the two upstreams the deployment already uses and
 * to the DeepSeek, GLM and Gemini Flash families, so a typo cannot move the session onto an
 * unrelated (and possibly much more expensive) model.
 */
export type SelectableSupplier = "opencode" | "commandcode";

const SUPPLIER_PREFIXES: readonly (readonly [string, SelectableSupplier])[] = [
  ["opencode-go/", "opencode"],
  ["commandcode/", "commandcode"],
];

export function supplierOf(modelId: string): SelectableSupplier | undefined {
  return SUPPLIER_PREFIXES.find(([prefix]) => modelId.startsWith(prefix))?.[1];
}

/**
 * Fast, Ultra Fast, HighSpeed and UltraSpeed variants stay out of the manual scope, matching the
 * first-batch rule for Command Code. "Flash" is a model family, not a speed suffix, so it is
 * deliberately not matched here.
 */
export function isSpeedVariant(model: Pick<Model<Api>, "id" | "name">): boolean {
  const pattern = /fast|ultra.?speed|high.?speed/i;
  return pattern.test(model.id) || pattern.test(model.name);
}

export type SelectableFamily = "deepseek" | "glm" | "gemini-flash";

export function selectableFamily(model: Pick<Model<Api>, "id">): SelectableFamily | undefined {
  if (/deepseek/i.test(model.id)) return "deepseek";
  if (/glm/i.test(model.id)) return "glm";
  if (/gemini/i.test(model.id) && /flash/i.test(model.id)) return "gemini-flash";
  return undefined;
}

/** One place for the command's scope, used by the parser, the store validation and the wrapper. */
export function isSelectableModel(model: Pick<Model<Api>, "id" | "name">): boolean {
  return supplierOf(model.id) !== undefined
    && !isSpeedVariant(model)
    && selectableFamily(model) !== undefined;
}

export function selectableModels(
  models: { getModels(provider?: string): readonly Model<Api>[] },
  provider: string,
): Model<Api>[] {
  return models.getModels(provider)
    .filter(isSelectableModel)
    .sort((left, right) => {
      const leftSupplier = supplierOf(left.id);
      const rightSupplier = supplierOf(right.id);
      const rank = (supplier: SelectableSupplier | undefined) => supplier === "opencode" ? 0 : supplier === "commandcode" ? 1 : 2;
      return rank(leftSupplier) - rank(rightSupplier) || left.id.localeCompare(right.id);
    });
}
