/**
 * Durable identities for remote PTC. The job id is derived from the conversation and the codemode
 * tool call so a recovered task attaches to the same persistent workspace; the RPC session id is
 * fresh per execution because a runner is never resumed across control-plane processes.
 */

import { createHash, randomBytes } from "node:crypto";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { OutputRef } from "../execution/ptc-protocol.js";

export const PTC_JOB_KIND = "aster.ptc.job";
export const PTC_OUTPUT_KIND = "aster.ptc.output";
export const PTC_DOC_VERSION = 1;

export type PtcJobRecord = {
  readonly jobId: string;
  /** Committed only after the execution agent confirmed the workspace exists. */
  workspaceReady: boolean;
  readonly createdAt: number;
  updatedAt: number;
};

export type PtcOutputRecord = {
  readonly jobId: string;
  readonly sessionId: string;
  readonly callId: number;
  readonly outputRef: OutputRef;
  readonly recordedAt: number;
};

/** Session-scoped because a workspace is owned by the control-plane instance's data directory. */
export const PtcJobDoc = defineDocFamily({
  kind: PTC_JOB_KIND,
  version: PTC_DOC_VERSION,
  family: true,
  scope: "session",
  initial: (seed: PtcJobRecord): PtcJobRecord => seed,
});

/**
 * One immutable output-reference record per session and script call id. A content-addressed blob
 * may be shared, but a reference is never rewritten: replay must see the same path, hash and size.
 */
export const PtcOutputDoc = defineDocFamily({
  kind: PTC_OUTPUT_KIND,
  version: PTC_DOC_VERSION,
  family: true,
  scope: "session",
  initial: (seed: PtcOutputRecord): PtcOutputRecord => seed,
});

/**
 * Stable across retries of the same durable task: conversation and task identify the logical PTC
 * job, so a restart remounts `<workspaceRoot>/<jobId>/workspace` instead of starting empty.
 */
export function derivePtcJobId(conversationId: number, taskId: number): string {
  const digest = createHash("sha256")
    .update(`remote-ptc-sandbox\0${conversationId}\0${taskId}`)
    .digest("hex");
  return `ptc-${digest.slice(0, 32)}`;
}

export function createPtcSessionId(): string {
  return randomBytes(8).toString("hex");
}

export function ptcOutputKey(jobId: string, sessionId: string, callId: number): string {
  return `${jobId}:${sessionId}:${callId}`;
}
