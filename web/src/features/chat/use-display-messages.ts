import { useMemo } from "react";
import type { UiMessage } from "@/api/types";
import { useChatStore } from "@/store/chat";
import { buildDisplayMessages } from "./display-messages";

export type { DisplayMessage, DisplayStatus } from "./display-messages";

export function useDisplayMessages(history: UiMessage[]) {
  const live = useChatStore((state) => state.live);
  const outgoing = useChatStore((state) => state.outgoing);
  const usage = useChatStore((state) => state.usage);
  const failures = useChatStore((state) => state.failures);

  return useMemo(
    () => buildDisplayMessages(history, { live, outgoing, usage, failures }),
    [history, live, outgoing, usage, failures],
  );
}
