import { Menu } from "lucide-react";
import { userFacingMessage } from "@/api/errors";
import { useMobileNav } from "@/app/AppShell";
import { ModelPicker } from "@/features/models/ModelPicker";
import { useModelsQuery } from "@/features/models/use-models";
import { NotificationPromptBanner } from "@/features/notifications/NotificationPromptBanner";
import { useMediaQuery } from "@/lib/use-media-query";
import { useChatStore } from "@/store/chat";
import { isSubagentActive, useSubagentStore } from "@/store/subagents";
import { CompanionSprite, deriveCompanionMode } from "./CompanionSprite";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { QueuePanel } from "./QueuePanel";
import { SubagentPanel } from "./SubagentPanel";
import {
  useQueueActions,
  useRetryMessage,
  useSendMessage,
  useStopRequest,
} from "./use-chat-actions";
import { useDisplayMessages } from "./use-display-messages";
import { flattenHistory, useHistoryQuery } from "./use-history";

export function ChatPage() {
  const { openMobileNav } = useMobileNav();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const history = useHistoryQuery();
  const models = useModelsQuery();
  const historyMessages = flattenHistory(history.data);
  const messages = useDisplayMessages(historyMessages);

  const activeStatus = useChatStore((state) => state.activeStatus);
  const sseState = useChatStore((state) => state.sseState);
  const queue = useChatStore((state) => state.queue);
  const promoting = useChatStore((state) => state.promoting);
  const subagents = useSubagentStore((state) => state.items);
  const activeSubagentCount = subagents.filter(isSubagentActive).length;

  const send = useSendMessage();
  const stop = useStopRequest();
  const retry = useRetryMessage();
  const { promote, cancel } = useQueueActions();

  const current = models.data?.current;
  const activeModelLabel = current ? current.name || current.label : undefined;
  const companionMode = deriveCompanionMode(activeStatus, queue.length, activeSubagentCount);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* Floating top-center standalone 3D companion (no redundant desktop chat header) */}
      {isDesktop ? (
        <div className="muse-top-fade pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pb-6 pt-3.5 safe-top">
          <CompanionSprite mode={companionMode} size={96} />
        </div>
      ) : (
        <div className="muse-top-fade pointer-events-none absolute inset-x-0 top-0 z-20 px-2.5 pb-5 pt-2 safe-top">
          <div className="relative flex items-start justify-center">
            <button
              type="button"
              onClick={openMobileNav}
              className="pointer-events-auto absolute left-0 top-1 flex size-11 items-center justify-center rounded-full bg-secondary text-foreground transition-colors active:scale-95"
              aria-label="打开导航"
            >
              <Menu className="size-5" />
            </button>
            <CompanionSprite mode={companionMode} size={76} />
          </div>
        </div>
      )}

      <main className="relative min-h-0 flex-1">
        <MessageList
          messages={messages}
          isLoading={history.isPending}
          isError={history.isError && messages.length === 0}
          errorMessage={history.error ? userFacingMessage(history.error) : null}
          onRetryLoad={() => void history.refetch()}
          hasMore={history.hasNextPage}
          isFetchingEarlier={history.isFetchingNextPage}
          onLoadEarlier={() => void history.fetchNextPage()}
          activeStatus={activeStatus}
          activeModelLabel={activeModelLabel}
          sseState={sseState}
          onRetryMessage={(message) => void retry(message)}
        />
      </main>

      <NotificationPromptBanner />

      <SubagentPanel />

      <QueuePanel
        items={queue}
        activeStatus={activeStatus}
        promoting={promoting}
        onPromote={promote}
        onCancel={cancel}
      />

      <Composer
        onSend={send}
        onStop={() => void stop()}
        activeStatus={activeStatus}
        leftSlot={<ModelPicker placement="composer" />}
      />
    </div>
  );
}
