import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { modelLabel, sameModelInstance, type ModelSelection, type ModelSwitchState } from "./model-failover.js";
import {
  isSelectableModel,
  selectableFamily,
  selectableModels,
  supplierOf,
  type SelectableFamily,
  type SelectableSupplier,
} from "./model-policy.js";

/**
 * Shared model selection service.
 *
 * The `$model` chat command and the HTTP model routes both go through this one object. It owns the
 * scope decision (`model-policy`), the persisted sticky selection (`model-selection.json`) and the
 * catalog shape returned to the clients, so the button and the text command can never drift apart.
 *
 * It never calls a model and never writes a chat message: a selection is host-side state.
 */

export type ModelEntry = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly label: string;
};

export type CurrentModel = ModelEntry & {
  readonly kind: "primary" | "manual" | "auto";
};

export type SelectableModelEntry = ModelEntry & {
  readonly supplier: SelectableSupplier;
  readonly family: SelectableFamily;
  readonly contextWindow?: number;
};

export type ModelCatalog = {
  readonly canSelect: boolean;
  readonly current: CurrentModel;
  readonly primary: ModelEntry;
  readonly chain: readonly ModelEntry[];
  readonly selectable: readonly SelectableModelEntry[];
  readonly scope: {
    readonly suppliers: readonly SelectableSupplier[];
    readonly families: readonly SelectableFamily[];
    readonly excludesSpeedVariants: true;
  };
};

export type SelectionChange = {
  /** The model now in effect after the operation. */
  readonly model: Model<Api>;
  /** True when the requested state was already active (idempotent repeat). */
  readonly unchanged: boolean;
  /** True when the operation cleared the stored selection instead of setting one. */
  readonly cleared: boolean;
  /** The selection that was active before the operation. */
  readonly previous: ModelSelection | undefined;
};

export type ModelSelectionErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_OUT_OF_SCOPE"
  | "MODEL_SWITCH_DISABLED"
  | "SELECTION_WRITE_FAILED";

export class ModelSelectionError extends Error {
  override name = "ModelSelectionError";
  constructor(readonly code: ModelSelectionErrorCode, message: string) {
    super(message);
  }
}

export type ModelSelectionServiceOptions = {
  /** The provider whose catalog is the runtime directory (the declared gateway). */
  readonly provider: string;
  readonly models: Models;
  /** Configured chain; its first entry is the primary. */
  readonly chain: readonly Model<Api>[];
  /** Absent when no failover is configured: reads are possible, switching is disabled. */
  readonly state?: ModelSwitchState;
  readonly log?: (line: string) => void;
};

export type ModelSelectionService = {
  catalog(): ModelCatalog;
  selectable(): Model<Api>[];
  /** Resolve the `opencode` / `commandcode` aliases the text command accepts. */
  byAlias(target: string): Model<Api> | undefined;
  /** Manual selection. Throws a typed `ModelSelectionError` on refusal. */
  select(modelId: string): SelectionChange;
  /** Return to the configured primary. */
  primary(): SelectionChange;
  /** The stored selection, when it still resolves in the live catalog. */
  current(): { readonly selection: ModelSelection | undefined; readonly model: Model<Api> };
};

const SCOPE = {
  suppliers: ["opencode", "commandcode"] as const satisfies readonly SelectableSupplier[],
  families: ["deepseek", "glm", "gemini-flash"] as const satisfies readonly SelectableFamily[],
  excludesSpeedVariants: true as const,
};

function entryOf(model: Pick<Model<Api>, "provider" | "id" | "name">): ModelEntry {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    label: modelLabel(model),
  };
}

export function createModelSelectionService(options: ModelSelectionServiceOptions): ModelSelectionService {
  const log = options.log ?? ((line: string) => console.error(line));
  const primaryModel = options.chain[0]!;
  const state = options.state;

  const available = (): Model<Api>[] => selectableModels(options.models, options.provider);

  const resolveSelection = (): { selection: ModelSelection | undefined; model: Model<Api> } => {
    const selection = state?.active();
    if (selection !== undefined) {
      const resolved = options.models.getModel(selection.provider, selection.modelId);
      if (resolved !== undefined) return { selection, model: resolved };
      log(`Model selection: ${selection.provider}/${selection.modelId} is not in the live catalog; using the primary`);
    }
    return { selection: undefined, model: primaryModel };
  };

  const catalog = (): ModelCatalog => {
    const { selection, model } = resolveSelection();
    const current: CurrentModel = {
      ...entryOf(model),
      kind: selection === undefined ? "primary" : selection.kind,
    };
    return {
      canSelect: state !== undefined,
      current,
      primary: entryOf(primaryModel),
      chain: options.chain.map(entryOf),
      // The list is the live catalog filtered by the shared policy; an empty catalog stays empty.
      selectable: available().map((model) => {
        const supplier = supplierOf(model.id)!;
        const family = selectableFamily(model)!;
        return { ...entryOf(model), supplier, family, contextWindow: model.contextWindow };
      }),
      scope: SCOPE,
    };
  };

  const requireState = (): ModelSwitchState => {
    if (state === undefined) {
      throw new ModelSelectionError("MODEL_SWITCH_DISABLED", "Model switching is disabled; no failover chain is configured");
    }
    return state;
  };

  const byAlias = (target: string): Model<Api> | undefined => {
    if (target !== "opencode" && target !== "commandcode") return undefined;
    const supplier = target as SelectableSupplier;
    const preferred = options.chain.find(
      (model) => supplierOf(model.id) === supplier && /deepseek/i.test(model.id),
    );
    if (preferred !== undefined) return preferred;
    const all = available();
    return all.find((model) => supplierOf(model.id) === supplier && /deepseek/i.test(model.id))
      ?? all.find((model) => supplierOf(model.id) === supplier);
  };

  const select = (modelId: string): SelectionChange => {
    const switchState = requireState();
    const previous = switchState.active();
    const model = options.models.getModel(options.provider, modelId);
    if (model === undefined) {
      throw new ModelSelectionError("MODEL_NOT_FOUND", `No model ${modelId} in the live catalog`);
    }
    if (!isSelectableModel(model)) {
      throw new ModelSelectionError("MODEL_OUT_OF_SCOPE", `${modelId} is outside the selectable scope`);
    }
    // Choosing the primary is the same as switching back: keep no redundant file.
    if (sameModelInstance(model, primaryModel)) {
      if (previous === undefined) {
        return { model, unchanged: true, cleared: true, previous };
      }
      if (!switchState.clear()) {
        throw new ModelSelectionError("SELECTION_WRITE_FAILED", "The model selection could not be cleared");
      }
      return { model, unchanged: false, cleared: true, previous };
    }
    if (previous?.kind === "manual" && previous.provider === model.provider && previous.modelId === model.id) {
      return { model, unchanged: true, cleared: false, previous };
    }
    if (!switchState.set({ provider: model.provider, modelId: model.id, kind: "manual" })) {
      throw new ModelSelectionError("SELECTION_WRITE_FAILED", "The model selection could not be saved");
    }
    return { model, unchanged: false, cleared: false, previous };
  };

  const primary = (): SelectionChange => {
    const switchState = requireState();
    const previous = switchState.active();
    const resolved = previous === undefined
      ? undefined
      : options.models.getModel(previous.provider, previous.modelId);
    if (previous === undefined) {
      return { model: primaryModel, unchanged: true, cleared: true, previous };
    }
    if (!switchState.clear()) {
      throw new ModelSelectionError("SELECTION_WRITE_FAILED", "The model selection could not be cleared");
    }
    return { model: resolved ?? primaryModel, unchanged: false, cleared: true, previous };
  };

  return { catalog, selectable: available, byAlias, select, primary, current: resolveSelection };
}
