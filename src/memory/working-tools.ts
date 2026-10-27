// Durable adapter of the Working Module: the two native tools the model uses.
//
// The model names what changed; the host supplies conversation identity, the operation id, and the
// clock. `working_update` is replay-safe because the module's receipt makes a rerun return the
// original result: the document, the anchor entry, and the receipt share one commit, so a crash
// between them is impossible. A crash after that commit but before the tool result is saved reruns
// the same operation id, reads the stored receipt, and changes nothing.
//
// Model-visible results are text plus a bounded structured value; neither carries memory prose
// beyond what the model itself just wrote. A rejected update returns `isError` so the model can
// correct it; it never fails the request.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  activeTask,
  applyWorkingUpdate,
  readWorking,
  type Committer,
} from "./working.js";
import { MEMORY_LIMITS, MemoryError, WorkingUpdateArgsSchema, type WorkingState } from "./contracts.js";

/** The state a model may see: identifiers, revision, and text it wrote itself. */
function renderState(state: WorkingState): string {
  const task = activeTask(state);
  const lines = [`revision: ${state.revision}`];
  if (task === undefined) {
    lines.push("task: none");
  } else {
    lines.push(`task: ${task.goal}`);
    if (task.scope !== null) lines.push(`scope: ${task.scope}`);
    if (task.constraints.length > 0) lines.push(`constraints: ${task.constraints.join("; ")}`);
    if (task.blockers.length > 0) lines.push(`blockers: ${task.blockers.join("; ")}`);
    if (task.nextStep !== null) lines.push(`next step: ${task.nextStep}`);
    lines.push(`progress: ${task.progress.length === 0 ? "none" : task.progress.map((item) => `[${item.status}] ${item.text}`).join("; ")}`);
  }
  const preferences = state.preferences.filter((preference) => preference.expiresAt === null || preference.expiresAt > Date.now());
  lines.push(`preferences: ${preferences.length === 0 ? "none" : preferences.map((preference) => `${preference.id}: ${preference.text} (${preference.scope})`).join("; ")}`);
  return lines.join("\n");
}

const structuredStateSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    task: Type.Union([Type.Literal("none"), Type.String({ maxLength: MEMORY_LIMITS.goal })]),
    preferences: Type.Array(
      Type.Object(
        { id: Type.String({ maxLength: MEMORY_LIMITS.identifier }), text: Type.String({ maxLength: MEMORY_LIMITS.text }) },
        { additionalProperties: false },
      ),
      { maxItems: MEMORY_LIMITS.preferences },
    ),
  },
  { additionalProperties: false },
);

function structuredState(state: WorkingState) {
  const task = activeTask(state);
  return {
    revision: state.revision,
    task: task === undefined ? ("none" as const) : task.goal,
    preferences: state.preferences.map((preference) => ({ id: preference.id, text: preference.text })),
  };
}

/** Working tools bound to the calling conversation; no parameter can select another one. */
export function workingTools(): ToolRegistration[] {
  const read = defineTool({
    name: "working_read",
    description:
      "Read the current working state: the active task, its progress and blockers, and the preferences that outlive it. Call it before updating so the revision you pass is current.",
    parameters: Type.Object({}, { additionalProperties: false }),
    structuredOutputSchema: structuredStateSchema,
    replay: "safe",
    execute: async (_args, api, context) => {
      const state = await readWorking(api, api.conversationId, context);
      return {
        output: [{ type: "text", text: renderState(state) }],
        structuredOutput: structuredState(state),
      };
    },
  });

  const update = defineTool({
    name: "working_update",
    description:
      "Change the working state. Pass the revision you read and the entry ids that evidence the change. A task change needs at least one evidence entry; preferences need the entry where the user asked for them. The update is ignored when the revision is stale, and repeating the same call does not apply it twice.",
    parameters: WorkingUpdateArgsSchema,
    replay: "safe",
    execute: async (args, api, context) => {
      const now = Date.now();
      try {
        const receipt = await applyWorkingUpdate(api as unknown as Committer, {
          conversationId: api.conversationId,
          // One native call is one durable tool task, so its id is the idempotency key: stable across
          // retries and restarts, unique per call, and inside the identifier charset.
          operationId: `tool:${api.taskId}`,
          expectedRevision: args.expectedRevision,
          evidence: args.evidence,
          changes: args.changes,
          now,
        }, context);
        const state = await readWorking(api, api.conversationId, context);
        const heading = receipt.changed
          ? `working state updated to revision ${receipt.revision}`
          : `no change; working state stays at revision ${receipt.revision}`;
        return {
          output: [{ type: "text", text: `${heading}\n${renderState(state)}` }],
          structuredOutput: structuredState(state),
          details: { operationId: receipt.operationId, changed: receipt.changed },
        };
      } catch (error) {
        // Only a business rejection is correctable. A storage or Session failure is not the model's to
        // fix: rethrow it so the call fails visibly instead of looking like a rejected argument.
        if (!(error instanceof MemoryError)) throw error;
        return {
          isError: true,
          output: [{ type: "text", text: `${error.code}: ${error.message}` }],
          diagnostics: [{ severity: "warn", code: error.code, message: error.message }],
        };
      }
    },
  });

  return [read, update];
}

/** The extension registered by the application composition root. */
export const workingExtension = defineExtension({ name: "working-memory", tools: workingTools() });
