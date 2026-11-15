import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelCommandHandler, parseModelCommand } from "../src/model-command.js";
import { createModelSwitchStore } from "../src/model-failover.js";
import { isSelectableModel, selectableModels, supplierOf } from "../src/model-policy.js";
import { resolveModelChain } from "../src/providers.js";

const MODELS = [
  { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash 1017", input: ["text" as const, "image" as const] },
  { id: "opencode-go/glm-5.3-flash", name: "GLM-5.3-Flash", input: ["text" as const, "image" as const] },
  { id: "commandcode/deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (latest)", input: ["text" as const, "image" as const] },
  { id: "commandcode/deepseek/deepseek-v4.1-flash-fast", name: "DeepSeek V4.1 Flash Fast (latest)", input: ["text" as const] },
  { id: "commandcode/z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", input: ["text" as const] },
  { id: "commandcode/google/gemini-3.8-flash", name: "Gemini 3.8 Flash", input: ["text" as const, "image" as const] },
  { id: "commandcode/claude-haiku-5-5", name: "Claude Haiku 5.5", input: ["text" as const, "image" as const] },
  { id: "opencode-go/gpt-6-luna", name: "GPT-6 Luna", input: ["text" as const, "image" as const] },
  { id: "auto/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · routing group", input: ["text" as const] },
];

function harness() {
  const faux = fauxProvider({ provider: "magpie", models: MODELS });
  const models = createModels();
  models.setProvider(faux.provider);
  const chain = resolveModelChain(models, { provider: "magpie", modelId: "opencode-go/deepseek-v4.1-flash" }, [
    { provider: "magpie", modelId: "commandcode/deepseek/deepseek-v4.1-flash" },
  ]) as Model<Api>[];
  return { models, chain };
}

test("the parser only accepts the exact $model token and whole-message phrases", () => {
  assert.deepEqual(parseModelCommand("$model"), { kind: "status" });
  assert.deepEqual(parseModelCommand("  $model  "), { kind: "status" });
  assert.deepEqual(parseModelCommand("$model list"), { kind: "list" });
  assert.deepEqual(parseModelCommand("$model list opencode"), { kind: "list", supplier: "opencode" });
  assert.deepEqual(parseModelCommand("$model list commandcode"), { kind: "list", supplier: "commandcode" });
  assert.deepEqual(parseModelCommand("$model primary"), { kind: "primary" });
  assert.deepEqual(parseModelCommand("$model opencode-go/glm-5.3-flash"), { kind: "select", target: "opencode-go/glm-5.3-flash" });
  assert.deepEqual(parseModelCommand("切回主模型。"), { kind: "primary" });
  assert.deepEqual(parseModelCommand("  切回默认模型？ "), { kind: "primary" });

  assert.equal(parseModelCommand("$modelx"), undefined);
  assert.equal(parseModelCommand("你好，$model"), undefined);
  assert.equal(parseModelCommand("请帮我切回主模型"), undefined);
  assert.equal(parseModelCommand("切回主模型 顺便看下今天的日程"), undefined);
  assert.equal(parseModelCommand(""), undefined);

  assert.equal(parseModelCommand("$model list elsewhere")?.kind, "invalid");
  assert.equal(parseModelCommand("$model primary now")?.kind, "invalid");
  assert.equal(parseModelCommand("$model a b")?.kind, "invalid");
});

test("the manual scope is OpenCode/Command Code DeepSeek, GLM and Gemini Flash only, without speed variants", () => {
  const { models } = harness();
  const ids = selectableModels(models, "magpie").map((model) => model.id);
  assert.deepEqual(ids, [
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/glm-5.3-flash",
    "commandcode/deepseek/deepseek-v4.1-flash",
    "commandcode/google/gemini-3.8-flash",
    "commandcode/z-ai/glm-5.3-flash",
  ]);
  const all = models.getModels("magpie");
  const byId = (id: string) => all.find((model) => model.id === id)!;
  assert.equal(isSelectableModel(byId("commandcode/claude-haiku-5-5")), false);
  assert.equal(isSelectableModel(byId("opencode-go/gpt-6-luna")), false);
  assert.equal(isSelectableModel(byId("commandcode/deepseek/deepseek-v4.1-flash-fast")), false);
  assert.equal(isSelectableModel(byId("auto/deepseek-v4.1-flash")), false);
  assert.equal(supplierOf("opencode-go/deepseek-v4.1-flash"), "opencode");
  assert.equal(supplierOf("commandcode/deepseek/deepseek-v4.1-flash"), "commandcode");
  assert.equal(supplierOf("auto/deepseek-v4.1-flash"), undefined);
});

test("status and list describe the live scope without switching anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-command-"));
  const path = join(directory, "model-selection.json");
  const { models, chain } = harness();
  const state = createModelSwitchStore(path, { log: () => {} });
  const command = createModelCommandHandler({ provider: "magpie", models, chain, state, log: () => {} });
  try {
    const status = command("$model")!;
    assert.match(status, /当前模型：magpie\/opencode-go\/deepseek-v4\.1-flash/);
    assert.match(status, /默认链：magpie\/opencode-go\/deepseek-v4\.1-flash → magpie\/commandcode\/deepseek\/deepseek-v4\.1-flash/);

    const list = command("$model list")!;
    assert.match(list, /opencode-go\/glm-5\.3-flash/);
    assert.match(list, /commandcode\/google\/gemini-3\.8-flash/);
    assert.doesNotMatch(list, /claude/i);
    assert.doesNotMatch(list, /gpt/i);
    assert.doesNotMatch(list, /-fast/i);
    assert.doesNotMatch(list, /auto\//);

    const opencode = command("$model list opencode")!;
    assert.match(opencode, /opencode-go\/deepseek-v4\.1-flash/);
    assert.doesNotMatch(opencode, /commandcode\//);
    assert.equal(state.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a valid selection is manual and sticky; primary and phrases clear it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-command-select-"));
  const path = join(directory, "model-selection.json");
  const { models, chain } = harness();
  const state = createModelSwitchStore(path, { log: () => {} });
  const command = createModelCommandHandler({ provider: "magpie", models, chain, state, log: () => {} });
  try {
    assert.match(command("$model commandcode/google/gemini-3.8-flash")!, /已切换到/);
    assert.deepEqual(state.active(), {
      provider: "magpie",
      modelId: "commandcode/google/gemini-3.8-flash",
      kind: "manual",
    });
    assert.match(command("$model")!, /手动指定/);
    assert.match(command("$model commandcode/google/gemini-3.8-flash")!, /已经手动指定/);

    // Aliases mean the configured supplier default, and clear a manual pick as well.
    assert.match(command("$model commandcode")!, /deepseek-v4\.1-flash/);
    assert.equal(state.active()?.modelId, "commandcode/deepseek/deepseek-v4.1-flash");
    assert.match(command("切回主模型！")!, /已切回主模型/);
    assert.equal(state.active(), undefined);

    command("$model commandcode");
    assert.match(command("$model primary")!, /已切回主模型/);
    assert.equal(state.active(), undefined);

    // Selecting the primary by id is the same as clearing.
    command("$model commandcode");
    assert.match(command("$model opencode-go/deepseek-v4.1-flash")!, /已切回主模型/);
    assert.equal(state.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("out-of-scope, speed and unknown ids are refused without changing the selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-command-refuse-"));
  const path = join(directory, "model-selection.json");
  const { models, chain } = harness();
  const state = createModelSwitchStore(path, { log: () => {} });
  const command = createModelCommandHandler({ provider: "magpie", models, chain, state, log: () => {} });
  try {
    command("$model commandcode/google/gemini-3.8-flash");
    const before = state.active();

    assert.match(command("$model commandcode/claude-haiku-5-5")!, /不在可切范围内/);
    assert.match(command("$model opencode-go/gpt-6-luna")!, /不在可切范围内/);
    assert.match(command("$model commandcode/deepseek/deepseek-v4.1-flash-fast")!, /不在可切范围内/);
    assert.match(command("$model auto/deepseek-v4.1-flash")!, /不在可切范围内/);
    assert.match(command("$model not/a-model")!, /没有找到模型/);
    assert.deepEqual(state.active(), before);

    assert.match(command("$model list elsewhere")!, /list 只接受/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
