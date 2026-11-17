import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  connectConnector,
  connectorsQueryKey,
  disconnectConnector,
  listConnectors,
  requestMockCredential,
  type ConnectResult,
  type Connector,
  type ConnectorId,
  type ConnectorsResponse,
} from "@/api/connectors";
import { errorText, toApiError } from "@/api/errors";
import { playCue } from "@/lib/sound";
import { useConnectionStore } from "@/store/connection";
import { connectorName } from "./catalog";

export function useConnectors() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  return useQuery({
    queryKey: connectorsQueryKey(baseUrl),
    queryFn: listConnectors,
    enabled: baseUrl !== "",
    staleTime: 5_000,
    // 跨端状态：回到前台时重新拉一次，服务端仍是唯一事实来源。
    refetchOnWindowFocus: true,
  });
}

function toastFailure(error: unknown): void {
  const apiError = toApiError(error);
  toast.error(errorText(apiError.code, apiError.message));
}

function replaceConnector(
  previous: ConnectorsResponse | undefined,
  next: Connector,
): ConnectorsResponse | undefined {
  if (!previous) return previous;
  return {
    ...previous,
    connectors: previous.connectors.map((connector) =>
      connector.id === next.id ? next : connector,
    ),
  };
}

export function useConnectConnector() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  return useMutation<ConnectResult, unknown, ConnectorId>({
    mutationFn: (id) => connectConnector(id),
    onSuccess: (result, id) => {
      if (result.status === "connected") {
        queryClient.setQueryData<ConnectorsResponse>(
          connectorsQueryKey(baseUrl),
          (previous) => replaceConnector(previous, result.connector),
        );
        playCue("success");
        toast.success(`${connectorName(id)} 已连接`, {
          description: "连接保存在服务器，三端共用同一份授权",
        });
      } else {
        toast.info("已发起授权，等待服务器确认", {
          description: "完成授权后这里会自动刷新",
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
    mutationFn: (id) => disconnectConnector(id),
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
