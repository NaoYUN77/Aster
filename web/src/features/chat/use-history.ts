import { useInfiniteQuery } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { listMessages } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { MessagePage, UiMessage } from "@/api/types";
import { useAuthStore } from "@/store/auth";
import { useConnectionStore } from "@/store/connection";

const PAGE_SIZE = 30;

export function useHistoryQuery() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const status = useAuthStore((state) => state.status);

  return useInfiniteQuery({
    queryKey: ["messages", baseUrl] as const,
    queryFn: ({ pageParam }) => listMessages(pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: MessagePage) =>
      lastPage.hasMore ? lastPage.nextCursor ?? undefined : undefined,
    enabled: status === "authenticated" && baseUrl !== "",
    staleTime: 5_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 1,
  });
}

/** pages[0] 是最新一页；按时间顺序展开为旧 → 新。 */
export function flattenHistory(
  data: InfiniteData<MessagePage> | undefined,
): UiMessage[] {
  if (!data) return [];
  // 不用 flatMap（ES2019）：旧 Android WebView 可能没有。
  return [...data.pages]
    .reverse()
    .reduce<UiMessage[]>((all, page) => all.concat(page.messages), []);
}
