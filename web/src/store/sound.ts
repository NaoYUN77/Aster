import { create } from "zustand";
import { storageGet, storageSet } from "@/lib/storage";

const SOUND_MUTED_KEY = "soundMuted";

type SoundState = {
  muted: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  toggle: () => void;
};

export const useSoundStore = create<SoundState>((set, get) => ({
  muted: false,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const stored = await storageGet(SOUND_MUTED_KEY);
    // 用户在读取完成前已经手动切换时，以用户操作为准。
    if (get().hydrated) return;
    set({ muted: stored === "1", hydrated: true });
  },

  setMuted: (muted) => {
    set({ muted, hydrated: true });
    void storageSet(SOUND_MUTED_KEY, muted ? "1" : "0");
  },

  toggle: () => {
    get().setMuted(!get().muted);
  },
}));
