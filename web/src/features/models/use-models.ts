import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listModels, selectModel, selectPrimaryModel } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { ModelsResponse } from "@/api/types";
import { useAuthStore } from "@/store/auth";
import { useConnectionStore } from "@/store/connection";
import { markLocalSelection } from "./selection-origin";

export type ModelSelectionInput =
  | { action: "select"; modelId: string }
  | { action: "primary" };

export function modelsQueryKey(baseUrl: string) {
  return ["models", baseUrl] as const;
}

export function useModelsQuery() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const status = useAuthStore((state) => state.status);

  return useQuery({
    queryKey: modelsQueryKey(baseUrl),
    queryFn: listModels,
    enabled: status === "authenticated" && baseUrl !== "",
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 1,
  });
}

export function useModelSelection() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const key = modelsQueryKey(baseUrl);

  return useMutation({
    mutationFn: async (input: ModelSelectionInput) =>
      input.action === "select" ? selectModel(input.modelId) : selectPrimaryModel(),
    onMutate: () => {
      markLocalSelection();
    },
    onSuccess: (data) => {
      const { effective, ...models } = data;
      queryClient.setQueryData<ModelsResponse>(key, models);
      const description =
        effective === "next_request"
          ? "当前回复继续使用原模型，下一次回复生效"
          : "下一次回复生效";
      toast.success(
        data.current.kind === "primary"
          ? `已切回主模型：${data.current.label}`
          : `已切换到 ${data.current.label}`,
        { description },
      );
    },
  });
}
