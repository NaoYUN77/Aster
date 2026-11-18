import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModelSelectionService } from "../src/model-control.js";
import { createModelSwitchStore } from "../src/model-failover.js";
import { resolveModelChain } from "../src/providers.js";
import type { HistoryPage, UiMessage } from "../src/http/projection.js";
import type { WebAgent } from "../src/http/worker.js";

/** Fixture catalog only: these ids exist in the test double, never in production code. */
export const FIXTURE_MODELS = [
  { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, input: ["text" as const] },
  { id: "opencode-go/glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 200_000, input: ["text" as const] },
  { id: "commandcode/deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (latest)", contextWindow: 1_000_000, input: ["text" as const] },
  { id: "commandcode/google/gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_000_000, input: ["text" as const] },
  { id: "commandcode/deepseek/deepseek-v4.1-flash-fast", name: "DeepSeek Flash Fast", contextWindow: 1_000_000, input: ["text" as const] },
  { id: "commandcode/claude-haiku-5-5", name: "Claude Haiku", contextWindow: 200_000, input: ["text" as const] },
];

export async function fixtureSelection() {
  const directory = await mkdtemp(join(tmpdir(), "aster-http-"));
  const faux = fauxProvider({ provider: "magpie", models: FIXTURE_MODELS });
  const models = createModels();
  models.setProvider(faux.provider);
  const chain = resolveModelChain(models, { provider: "magpie", modelId: "opencode-go/deepseek-v4.1-flash" }, [
    { provider: "magpie", modelId: "commandcode/deepseek/deepseek-v4.1-flash" },
  ]) as Model<Api>[];
  const state = createModelSwitchStore(join(directory, "model-selection.json"), { log: () => {} });
  const service = createModelSelectionService({ provider: "magpie", models, chain, state, log: () => {} });
  return { directory, models, chain, state, service };
}

export function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: "1",
    role: "assistant",
    text: "hello",
    createdAt: 1,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
    ...overrides,
  };
}

export function fakeAgent(options: {
  reply: (request: { requestId: string; text: string }, signal: AbortSignal) => Promise<string>;
  steer?: (request: { requestId: string; text: string }) => Promise<{
    steerId: string;
    done: Promise<UiMessage | undefined>;
    submission: {
      status(): Promise<"queued" | "placed" | "done" | "unanswered">;
      abort(): Promise<"aborted" | "already_placed" | "settled">;
    };
  }>;
  history?: (options?: { before?: string; limit?: number }) => Promise<HistoryPage>;
  service: WebAgent["modelService"];
  abort?: () => Promise<void>;
}): WebAgent {
  return {
    reply: (request, signal) => options.reply(request, signal),
    steer: options.steer ?? (async (request) => {
      throw Object.assign(new Error(`No request is running for ${request.requestId}`), { code: "NO_ACTIVE_REQUEST" });
    }),
    abort: options.abort ?? (async () => {}),
    history: options.history ?? (async () => ({ messages: [], nextCursor: null, hasMore: false })),
    modelService: options.service,
  };
}

/** A steer result whose durable submission defaults to "already settled". */
export function steerHandle(
  steerId: string,
  done: Promise<UiMessage | undefined>,
  submission: Partial<{
    status(): Promise<"queued" | "placed" | "done" | "unanswered">;
    abort(): Promise<"aborted" | "already_placed" | "settled">;
  }> = {},
) {
  return {
    steerId,
    done,
    submission: {
      status: submission.status ?? (async () => "done" as const),
      abort: submission.abort ?? (async () => "settled" as const),
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
