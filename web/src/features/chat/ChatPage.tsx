import { userFacingMessage } from "@/api/errors";
import { useModelsQuery } from "@/features/models/use-models";
import { useChatStore } from "@/store/chat";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useRetryMessage, useSendMessage, useStopRequest } from "./use-chat-actions";
import { useDisplayMessages } from "./use-display-messages";
import { flattenHistory, useHistoryQuery } from "./use-history";

export function ChatPage() {
  const history = useHistoryQuery();
  const models = useModelsQuery();
  const historyMessages = flattenHistory(history.data);
  const messages = useDisplayMessages(historyMessages);

  const activeStatus = useChatStore((state) => state.activeStatus);
  const sseState = useChatStore((state) => state.sseState);

  const send = useSendMessage();
  const stop = useStopRequest();
  const retry = useRetryMessage();

  const current = models.data?.current;
  const activeModelLabel = current ? current.name || current.label : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader />
      <main className="min-h-0 flex-1">
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
      <Composer
        onSend={send}
        onStop={() => void stop()}
        activeStatus={activeStatus}
      />
    </div>
  );
}
