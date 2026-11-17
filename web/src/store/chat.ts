import { create } from "zustand";
import type { SseState } from "@/api/sse";
import type { ModelUsage, UiMessage } from "@/api/types";

export type OutgoingStatus = "sending" | "queued" | "running" | "done" | "failed" | "aborted";

export type OutgoingMessage = {
  clientMessageId: string;
  requestId?: string;
  text: string;
  createdAt: number;
  status: OutgoingStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type RequestFailure = {
  code: string | null;
  message: string | null;
};

type ChatState = {
  outgoing: OutgoingMessage[];
  live: Record<string, UiMessage>;
  usage: Record<string, ModelUsage>;
  failures: Record<string, RequestFailure>;
  activeRequestId: string | null;
  activeClientMessageId: string | null;
  activeStatus: "queued" | "running" | null;
  sseState: SseState;
  lastEventAt: number | null;
  modelVersion: number;

  addOutgoing: (text: string) => string;
  updateOutgoing: (clientMessageId: string, patch: Partial<OutgoingMessage>) => void;
  updateByRequestId: (requestId: string, patch: Partial<OutgoingMessage>) => void;
  removeOutgoing: (clientMessageId: string) => void;
  setActive: (
    requestId: string | null,
    status: "queued" | "running" | null,
    clientMessageId?: string | null,
  ) => void;
  addLiveMessage: (message: UiMessage) => void;
  setUsage: (messageId: string, usage: ModelUsage) => void;
  setFailure: (requestId: string, failure: RequestFailure) => void;
  setSseState: (state: SseState) => void;
  bumpModelVersion: () => void;
  reset: () => void;
};

function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cmid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const initial = {
  outgoing: [] as OutgoingMessage[],
  live: {} as Record<string, UiMessage>,
  usage: {} as Record<string, ModelUsage>,
  failures: {} as Record<string, RequestFailure>,
  activeRequestId: null,
  activeClientMessageId: null,
  activeStatus: null,
  sseState: "closed" as SseState,
  lastEventAt: null,
  modelVersion: 0,
};

export const useChatStore = create<ChatState>((set) => ({
  ...initial,

  addOutgoing: (text) => {
    const clientMessageId = newClientMessageId();
    set((state) => ({
      outgoing: [
        ...state.outgoing,
        {
          clientMessageId,
          text,
          createdAt: Date.now(),
          status: "sending",
        },
      ],
    }));
    return clientMessageId;
  },

  updateOutgoing: (clientMessageId, patch) => {
    set((state) => ({
      outgoing: state.outgoing.map((item) =>
        item.clientMessageId === clientMessageId ? { ...item, ...patch } : item,
      ),
    }));
  },

  updateByRequestId: (requestId, patch) => {
    set((state) => ({
      outgoing: state.outgoing.map((item) =>
        item.requestId === requestId ? { ...item, ...patch } : item,
      ),
    }));
  },

  removeOutgoing: (clientMessageId) => {
    set((state) => ({
      outgoing: state.outgoing.filter((item) => item.clientMessageId !== clientMessageId),
    }));
  },

  setActive: (requestId, status, clientMessageId) => {
    set((state) => ({
      activeRequestId: requestId,
      activeStatus: status,
      activeClientMessageId:
        clientMessageId === undefined ? state.activeClientMessageId : clientMessageId,
    }));
  },

  addLiveMessage: (message) => {
    set((state) => ({ live: { ...state.live, [message.id]: message } }));
  },

  setUsage: (messageId, usage) => {
    set((state) => ({ usage: { ...state.usage, [messageId]: usage } }));
  },

  setFailure: (requestId, failure) => {
    set((state) => ({ failures: { ...state.failures, [requestId]: failure } }));
  },

  setSseState: (sseState) => {
    set({ sseState, lastEventAt: Date.now() });
  },

  bumpModelVersion: () => {
    set((state) => ({ modelVersion: state.modelVersion + 1 }));
  },

  reset: () => {
    set({ ...initial });
  },
}));
