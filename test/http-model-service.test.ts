import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createModelSelectionService, ModelSelectionError } from "../src/model-control.js";
import { selectableModels } from "../src/model-policy.js";
import { createModelSwitchStore } from "../src/model-failover.js";
import { fixtureSelection } from "./http-testkit.js";

test("the HTTP catalog uses the live directory and the same scope as $model", async () => {
  const fixture = await fixtureSelection();
  try {
    const catalog = fixture.service.catalog();
    const expected = selectableModels(fixture.models, "magpie").map((model) => model.id);
    assert.deepEqual(catalog.selectable.map((model) => model.id), expected);
    assert.ok(expected.includes("opencode-go/deepseek-v4.1-flash"));
    assert.ok(expected.includes("commandcode/google/gemini-3.8-flash"));
    assert.ok(!expected.includes("commandcode/claude-haiku-5-5"), "outside family is excluded");
    assert.ok(!expected.includes("commandcode/deepseek/deepseek-v4.1-flash-fast"), "speed variant is excluded");
    assert.equal(catalog.canSelect, true);
    assert.equal(catalog.current.kind, "primary");
    assert.equal(catalog.current.id, "opencode-go/deepseek-v4.1-flash");
    assert.deepEqual(catalog.chain.map((model) => model.id), [
      "opencode-go/deepseek-v4.1-flash",
      "commandcode/deepseek/deepseek-v4.1-flash",
    ]);
    assert.deepEqual(catalog.scope, {
      suppliers: ["opencode", "commandcode"],
      families: ["deepseek", "glm", "gemini-flash"],
      excludesSpeedVariants: true,
    });
    assert.equal(catalog.selectable[0]?.supplier, "opencode");
    assert.equal(catalog.selectable[0]?.family, "deepseek");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("selecting a model persists manual sticky state; primary clears it", async () => {
  const fixture = await fixtureSelection();
  try {
    const result = fixture.service.select("commandcode/google/gemini-3.8-flash");
    assert.equal(result.unchanged, false);
    assert.deepEqual(fixture.state.active(), {
      provider: "magpie",
      modelId: "commandcode/google/gemini-3.8-flash",
      kind: "manual",
    });
    assert.equal(fixture.service.catalog().current.kind, "manual");

    const again = fixture.service.select("commandcode/google/gemini-3.8-flash");
    assert.equal(again.unchanged, true);

    const back = fixture.service.primary();
    assert.equal(back.cleared, true);
    assert.equal(fixture.state.active(), undefined);
    assert.equal(fixture.service.catalog().current.kind, "primary");

    const already = fixture.service.primary();
    assert.equal(already.unchanged, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("selecting the primary by id is the same as switching back", async () => {
  const fixture = await fixtureSelection();
  try {
    fixture.service.select("opencode-go/glm-5.3-flash");
    assert.equal(fixture.state.active()?.kind, "manual");
    const result = fixture.service.select("opencode-go/deepseek-v4.1-flash");
    assert.equal(result.cleared, true);
    assert.equal(fixture.state.active(), undefined);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("unknown, out-of-scope and disabled selections are refused with stable codes", async () => {
  const fixture = await fixtureSelection();
  try {
    const codeOf = (work: () => unknown): string => {
      try {
        work();
        return "none";
      } catch (error) {
        return error instanceof ModelSelectionError ? error.code : "wrong-error";
      }
    };
    assert.equal(codeOf(() => fixture.service.select("magpie/nope")), "MODEL_NOT_FOUND");
    assert.equal(codeOf(() => fixture.service.select("commandcode/claude-haiku-5-5")), "MODEL_OUT_OF_SCOPE");
    assert.equal(codeOf(() => fixture.service.select("commandcode/deepseek/deepseek-v4.1-flash-fast")), "MODEL_OUT_OF_SCOPE");

    const readOnly = createModelSelectionService({
      provider: "magpie",
      models: fixture.models,
      chain: fixture.chain,
      log: () => {},
    });
    assert.equal(readOnly.catalog().canSelect, false);
    assert.equal(readOnly.catalog().selectable.length, selectableModels(fixture.models, "magpie").length);
    assert.equal(codeOf(() => readOnly.select("opencode-go/glm-5.3-flash")), "MODEL_SWITCH_DISABLED");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed selection write leaves the previous state in effect", async () => {
  const directory = await fixtureSelection();
  try {
    // A regular file where the parent directory should be makes every write fail.
    const blockingPath = join(directory.directory, "blocked");
    await writeFile(blockingPath, "not a directory");
    const state = createModelSwitchStore(join(blockingPath, "model-selection.json"), { log: () => {} });
    const service = createModelSelectionService({
      provider: "magpie",
      models: directory.models,
      chain: directory.chain,
      state,
      log: () => {},
    });
    assert.throws(() => service.select("opencode-go/glm-5.3-flash"), (error: unknown) =>
      error instanceof ModelSelectionError && error.code === "SELECTION_WRITE_FAILED");
    assert.equal(service.catalog().current.kind, "primary");
  } finally {
    await rm(directory.directory, { recursive: true, force: true });
  }
});
