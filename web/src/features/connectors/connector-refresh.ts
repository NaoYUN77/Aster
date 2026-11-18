import type { QueryClient } from "@tanstack/react-query";
import { connectorsQueryKey } from "@/api/connectors";

/**
 * `connector.changed` 到达时只重新拉列表，不信任事件字段。
 *
 * 绝不程序化关闭系统浏览器：授权页关不关由用户决定。
 */
export async function refreshConnectorsFromServer(
  queryClient: QueryClient,
  baseUrl: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: connectorsQueryKey(baseUrl),
  });
}
