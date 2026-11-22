import { create } from "zustand";
import type { ApprovalRequestView } from "@/api/approvals";

type ApprovalState = {
  pending: ApprovalRequestView[];
  setAll: (items: ApprovalRequestView[]) => void;
  upsert: (item: ApprovalRequestView) => void;
  remove: (id: string) => void;
  clear: () => void;
};

export const useApprovalStore = create<ApprovalState>((set) => ({
  pending: [],
  setAll: (items) =>
    set({
      pending: items.filter((item) => item.status === "pending"),
    }),
  upsert: (item) =>
    set((state) => {
      if (item.status !== "pending") {
        return { pending: state.pending.filter((existing) => existing.id !== item.id) };
      }
      const exists = state.pending.some((existing) => existing.id === item.id);
      return {
        pending: exists
          ? state.pending.map((existing) => (existing.id === item.id ? item : existing))
          : [...state.pending, item],
      };
    }),
  remove: (id) =>
    set((state) => ({
      pending: state.pending.filter((existing) => existing.id !== id),
    })),
  clear: () => set({ pending: [] }),
}));
