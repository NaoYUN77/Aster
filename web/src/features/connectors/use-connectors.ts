import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ConnectorConnectError,
  connectConnector,
  connectorErrorText,
  connectorsQueryKey,
  deleteConnector,
  listConnectors,
  requestMockCredential,
  type ConnectResult,
  type ConnectorId,
} from "@/api/connectors";
import { toApiError } from "@/api/errors";
import { playCue } from "@/lib/sound";
import { useConnectionStore } from "@/store/connection";
import { connectorName } from "./catalog";
import { discardFailedConnector } from "./connector-refresh";

export function useConnectors() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  return useQuery({
    queryKey: connectorsQueryKey(baseUrl),
    queryFn: listConnectors,
    enabled: baseUrl !== "",
    staleTime: 5_000,
    // 跨端状态：回到前台时重新拉一次，服务端仍是唯一事实来源。
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => {
      // 服务器未启用连接器是稳定状态，重试没有意义。
      if (toApiError(error).code === "CONNECTORS_DISABLED") return false;
      return failureCount < 2;
    },
  });
}

function toastFailure(error: unknown): void {
  const apiError = toApiError(error);
  toast.error(connectorErrorText(apiError.code));
}

export function useConnectConnector() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  return useMutation<ConnectResult, unknown, ConnectorId>({
    mutationFn: async (id) => {
      try {
        return await connectConnector(id);
      } catch (error) {
        // 失败不会产生可用的授权 URL：只清理由本次流程建出来的 pending 行，
        // 保证弹窗/卡片不会停在“等待授权”。已有连接不删；清理期间
        // mutation 保持 pending，避免用户立刻重试时 DELETE 误删新连接。
        if (error instanceof ConnectorConnectError && error.cleanupPending) {
          await discardFailedConnector(queryClient, baseUrl, id);
        }
        throw error;
      }
    },
    onSuccess: (result, id) => {
      // 只进入等待授权；是否已连接以 connector.changed / 重新拉列表为准。
      if (result.manualAuthUrl) {
        toast.info(`${connectorName(id)} 已请求打开授权页`, {
          description: "若浏览器没有自动打开，请点击卡片上的「打开授权页」",
        });
      } else {
        toast.info(`${connectorName(id)} 授权页已打开`, {
          description: "在浏览器完成授权后回到 App，状态会自动刷新",
        });
      }
      void queryClient.invalidateQueries({
        queryKey: connectorsQueryKey(baseUrl),
      });
    },
    onError: (error) => {
      playCue("error");
      toastFailure(error);
    },
  });
}

export function useDisconnectConnector() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  return useMutation<void, unknown, ConnectorId>({
    mutationFn: (id) => deleteConnector(id),
    onSuccess: (_result, id) => {
      playCue("success");
      toast.success(`${connectorName(id)} 已断开`, {
        description: "相关工具将不再可用，三端同时失效",
      });
      void queryClient.invalidateQueries({
        queryKey: connectorsQueryKey(baseUrl),
      });
    },
    onError: (error) => {
      playCue("error");
      toastFailure(error);
    },
  });
}

/** 等待授权时取消：DELETE 同一 slug，服务端把这条连接标成 revoked。 */
export function useCancelConnectorAuthorization() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  return useMutation<void, unknown, ConnectorId>({
    mutationFn: (id) => deleteConnector(id),
    onSuccess: (_result, id) => {
      toast.info(`${connectorName(id)} 已取消授权`);
      void queryClient.invalidateQueries({
        queryKey: connectorsQueryKey(baseUrl),
      });
    },
    onError: (error) => {
      playCue("error");
      toastFailure(error);
    },
  });
}

/** 仅本地 mock：让 mock 服务端推送一条 credential.request。 */
export function useRequestMockCredential() {
  return useMutation<void, unknown, ConnectorId>({
    mutationFn: (connectorId) => requestMockCredential(connectorId),
    onSuccess: () => {
      toast.info("已请求 mock 凭据弹窗", {
        description: "服务端会通过 SSE 推送 credential.request",
      });
    },
    onError: (error) => {
      playCue("error");
      toastFailure(error);
    },
  });
}
