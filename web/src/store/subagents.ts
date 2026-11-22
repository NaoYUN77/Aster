import { create } from "zustand";
import type { SubagentSnapshot } from "@/api/subagents";

const RECEIPT_LINGER_MS = 3_000;

export function isSubagentActive(item: SubagentSnapshot): boolean {
  return item.status === "running" || item.status === "waiting_approval";
}

type SubagentState = {
  items: SubagentSnapshot[];
  setAll: (items: SubagentSnapshot[]) => void;
  upsert: (item: SubagentSnapshot) => void;
  clear: () => void;
};

let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function cancelFadeTimer() {
  if (fadeTimer !== null) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
}

export const useSubagentStore = create<SubagentState>((set) => ({
  items: [],
  setAll: (items) => {
    cancelFadeTimer();
    set({ items });
  },
  upsert: (item) => {
    cancelFadeTimer();
    let nextItems: SubagentSnapshot[] = [];
    set((state) => {
      const exists = state.items.some((existing) => existing.id === item.id);
      nextItems = exists
        ? state.items.map((existing) => (existing.id === item.id ? item : existing))
        : [...state.items, item];
      return { items: nextItems };
    });

    const hasActive = nextItems.some(isSubagentActive);
    if (!hasActive && nextItems.length > 0) {
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        set((state) => (state.items.some(isSubagentActive) ? state : { items: [] }));
      }, RECEIPT_LINGER_MS);
    }
  },
  clear: () => {
    cancelFadeTimer();
    set({ items: [] });
  },
}));
