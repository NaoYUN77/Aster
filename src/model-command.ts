import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { modelLabel, sameModelInstance, type ModelSwitchState } from "./model-failover.js";
import {
  createModelSelectionService,
  ModelSelectionError,
  type ModelSelectionService,
} from "./model-control.js";
import { supplierOf, type SelectableSupplier } from "./model-policy.js";

/** A parsed `$model` command. `undefined` from the parser means the text is ordinary chat. */
export type ModelCommand =
  | { readonly kind: "status" }
  | { readonly kind: "list"; readonly supplier?: SelectableSupplier }
  | { readonly kind: "primary" }
  | { readonly kind: "select"; readonly target: string }
  | { readonly kind: "invalid"; readonly reason: string };

export const MODEL_COMMAND_PREFIX = "$model";

const USAGE = "用法：$model 查看状态；$model list [opencode|commandcode]；$model primary 切回主模型；$model <model id> 切到指定模型。";

/** Whole-message phrases that switch back without a prefix. Trailing sentence punctuation is allowed. */
const PRIMARY_PHRASES = new Set(["切回主模型", "切回默认模型"]);

/**
 * Recognise a command without ever guessing. Only a trimmed message that starts with the exact
 * `$model` token counts, plus a tiny set of whole-message Chinese phrases. Nothing is matched by
 * substring, so an ordinary sentence that happens to mention switching models stays a chat message.
 */
export function parseModelCommand(text: string): ModelCommand | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const phrase = trimmed.replace(/[。．.！!？?]+$/u, "").trim();
  if (PRIMARY_PHRASES.has(phrase)) return { kind: "primary" };
  if (!trimmed.startsWith(MODEL_COMMAND_PREFIX)) return undefined;
  const rest = trimmed.slice(MODEL_COMMAND_PREFIX.length);
  // "$modelx" is not the command; a command prefix must stand alone.
  if (rest !== "" && !/^\s/u.test(rest)) return undefined;
  const tokens = rest.trim() === "" ? [] : rest.trim().split(/\s+/u);
  if (tokens.length === 0) return { kind: "status" };
  const head = tokens[0]!;
  const args = tokens.slice(1);
  if (head === "list") {
    if (args.length === 0) return { kind: "list" };
    if (args.length === 1 && (args[0] === "opencode" || args[0] === "commandcode")) {
      return { kind: "list", supplier: args[0] as SelectableSupplier };
    }
    return { kind: "invalid", reason: "list 只接受 opencode 或 commandcode。" };
  }
  if (head === "primary") {
    return args.length === 0 ? { kind: "primary" } : { kind: "invalid", reason: USAGE };
  }
  if (args.length === 0) return { kind: "select", target: head };
  return { kind: "invalid", reason: USAGE };
}

export type ModelCommandOptions = {
  /** The provider every selectable model belongs to (the declared gateway, not the upstream prefix). */
  readonly provider: string;
  readonly models: Models;
  /** The configured automatic chain; its first entry is the primary. */
  readonly chain: readonly Model<Api>[];
  readonly state: ModelSwitchState;
  /** Pre-built shared service. The agent passes the same instance the HTTP routes use. */
  readonly service?: ModelSelectionService;
  readonly log?: (line: string) => void;
};

/**
 * Host-side handler. It never calls a model: a switch must keep working when the current model is
 * exactly what the user is trying to escape. Returns `undefined` when the text is not a command.
 *
 * Every decision goes through `ModelSelectionService`, the same object `GET /api/v1/models` and
 * `POST /api/v1/models/select` use, so the text command and the buttons cannot disagree about the
 * live catalog or the selectable scope.
 */
export function createModelCommandHandler(options: ModelCommandOptions): (text: string) => string | undefined {
  const log = options.log ?? ((line: string) => console.error(line));
  const primary = options.chain[0]!;
  const service = options.service ?? createModelSelectionService({
    provider: options.provider,
    models: options.models,
    chain: options.chain,
    state: options.state,
    log,
  });

  const status = (): string => {
    const current = service.current();
    const label = current.selection === undefined
      ? `${modelLabel(primary)}（主模型）`
      : `${modelLabel(current.model)}（${current.model.name}）（${current.selection.kind === "manual" ? "手动指定" : "自动降级后粘性"}）`;
    return [
      `当前模型：${label}`,
      `默认链：${options.chain.map((model) => modelLabel(model)).join(" → ")}`,
      "可切：OpenCode / Command Code 的 DeepSeek、GLM、Gemini Flash；$model list 查看。",
    ].join("\n");
  };

  const list = (supplier?: SelectableSupplier): string => {
    const all = service.selectable().filter((model) => supplier === undefined || supplierOf(model.id) === supplier);
    if (all.length === 0) return "当前目录没有可切的模型。";
    const lines = [`可切模型（实时目录，共 ${all.length} 个）：`];
    for (const model of all) {
      const tag = supplier === undefined ? `[${supplierOf(model.id)}] ` : "";
      lines.push(`${tag}${model.id}（${model.name}）`);
    }
    lines.push("发 $model <model id> 切换；$model primary 回主模型。");
    return lines.join("\n");
  };

  const select = (target: string): string => {
    const alias = service.byAlias(target);
    const id = alias?.id ?? target;
    try {
      const result = service.select(id);
      if (sameModelInstance(result.model, primary)) {
        log(`Model command: selection cleared; back on the primary ${modelLabel(primary)}`);
        return `已切回主模型：${modelLabel(primary)}。`;
      }
      if (result.unchanged) {
        return `当前已经手动指定为 ${modelLabel(result.model)}（${result.model.name}）。`;
      }
      log(`Model command: manual selection set to ${modelLabel(result.model)}`);
      const smaller = result.model.contextWindow < primary.contextWindow
        ? `它的 context window 较小（${result.model.contextWindow}），长对话可能先触发压缩。`
        : "";
      return `已切换到 ${modelLabel(result.model)}（${result.model.name}）。${smaller}它不可用时按默认链降级；回主模型发 $model primary。`;
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        if (error.code === "MODEL_NOT_FOUND") return `没有找到模型 ${id}。发 $model list 查看可切模型。`;
        if (error.code === "MODEL_OUT_OF_SCOPE") {
          return `只能切 OpenCode / Command Code 的 DeepSeek、GLM、Gemini Flash；${id} 不在可切范围内。`;
        }
        return "模型切换暂时不可用，请稍后再试。";
      }
      throw error;
    }
  };

  return (text: string): string | undefined => {
    const command = parseModelCommand(text);
    if (command === undefined) return undefined;
    switch (command.kind) {
      case "status":
        return status();
      case "list":
        return list(command.supplier);
      case "primary": {
        try {
          const result = service.primary();
          if (result.unchanged) return `当前已经是主模型：${modelLabel(primary)}。`;
          log("Model command: selection cleared; back on the primary");
          return `已切回主模型：${modelLabel(primary)}。`;
        } catch (error) {
          if (error instanceof ModelSelectionError) return "模型切换暂时不可用，请稍后再试。";
          throw error;
        }
      }
      case "select":
        return select(command.target);
      case "invalid":
        return command.reason;
    }
  };
}
