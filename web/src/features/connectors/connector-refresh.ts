import type { QueryClient } from "@tanstack/react-query";
import {
  connectorsQueryKey,
  deleteConnector,
  type ConnectorId,
} from "@/api/connectors";

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

/**
 * OAuth 启动失败后的清理：best-effort 删除刚建立的 pending 行，
 * 再拉一次列表让卡片回到「未连接」。
 *
 * 删除失败不抛错，避免覆盖用户真正需要看到的失败原因；
 * 这里也不做任何重试或浏览器操作。
 */
export async function discardFailedConnector(
  queryClient: QueryClient,
  baseUrl: string,
  id: ConnectorId,
): Promise<void> {
  try {
    await deleteConnector(id);
  } catch {
    // 行可能本来就没建成，或服务端暂时不可用；原始错误更重要。
  }
  await queryClient.invalidateQueries({
    queryKey: connectorsQueryKey(baseUrl),
  });
}
