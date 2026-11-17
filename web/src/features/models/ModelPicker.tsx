import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Cpu,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle, SheetContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toApiError, errorText } from "@/api/errors";
import type { ModelKind, ModelsResponse, SelectableModel } from "@/api/types";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn, formatContextWindow } from "@/lib/utils";
import { useChatStore } from "@/store/chat";
import { ModelBadge } from "./ModelBadge";
import { useModelSelection, useModelsQuery } from "./use-models";

const SUPPLIER_LABEL: Record<string, string> = {
  opencode: "OpenCode",
  commandcode: "Command Code",
};

const FAMILY_LABEL: Record<string, string> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  "gemini-flash": "Gemini Flash",
};

type Group = {
  supplier: string;
  label: string;
  families: Array<{ family: string; label: string; items: SelectableModel[] }>;
};

function groupSelectable(models: ModelsResponse): Group[] {
  const suppliers =
    models.scope.suppliers.length > 0
      ? models.scope.suppliers
      : [...new Set(models.selectable.map((model) => model.supplier))];

  const groups: Group[] = [];
  for (const supplier of suppliers) {
    const supplierItems = models.selectable.filter((model) => model.supplier === supplier);
    if (supplierItems.length === 0) continue;

    const families =
      models.scope.families.length > 0
        ? models.scope.families
        : [...new Set(supplierItems.map((model) => model.family))];

    const familyGroups: Group["families"] = [];
    for (const family of families) {
      const items = supplierItems.filter((model) => model.family === family);
      if (items.length === 0) continue;
      familyGroups.push({
        family,
        label: FAMILY_LABEL[family] ?? family,
        items,
      });
    }

    groups.push({
      supplier,
      label: SUPPLIER_LABEL[supplier] ?? supplier,
      families: familyGroups,
    });
  }
  return groups;
}

function KindHint({ kind }: { kind: ModelKind }) {
  if (kind === "primary") {
    return <span className="text-[11px] text-muted-foreground">当前使用默认链的首个模型</span>;
  }
  if (kind === "manual") {
    return <span className="text-[11px] text-muted-foreground">已手动指定；失败时按默认链降级</span>;
  }
  return <span className="text-[11px] text-muted-foreground">自动降级后的粘性选择</span>;
}

type PickerBodyProps = {
  data: ModelsResponse | undefined;
  loading: boolean;
  queryError: boolean;
  onReload: () => void;
  onSelect: (modelId: string) => void;
  onPrimary: () => void;
  pendingModelId: string | null;
  pendingPrimary: boolean;
  mutationError: string | null;
  activeReply: boolean;
  onClose: () => void;
};

function PickerBody({
  data,
  loading,
  queryError,
  onReload,
  onSelect,
  onPrimary,
  pendingModelId,
  pendingPrimary,
  mutationError,
  activeReply,
}: PickerBodyProps) {
  const groups = useMemo(() => (data ? groupSelectable(data) : []), [data]);

  if (loading && !data) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }

  if (queryError && !data) {
    return (
      <div className="space-y-3 p-5 text-center">
        <p className="text-sm text-muted-foreground">模型目录加载失败</p>
        <Button variant="outline" size="sm" onClick={onReload}>
          <RefreshCw className="size-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (!data) {
    return <div className="p-5 text-center text-sm text-muted-foreground">没有模型信息</div>;
  }

  const current = data.current;
  const canSelect = data.canSelect && data.selectable.length > 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pt-3">
        <div>
          <h2 className="text-sm font-semibold">模型</h2>
          <p className="text-[11px] text-muted-foreground">实时目录 · 与 $model 共用同一策略</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onReload}
          disabled={loading}
          aria-label="刷新模型列表"
          title="刷新"
        >
          {loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-4 pt-3">
          <div className="rounded-lg border border-border bg-muted/35 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {current.name || current.label}
              </span>
              <ModelBadge kind={current.kind} />
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={current.id}>
              {current.id}
            </p>
            <div className="mt-1.5">
              <KindHint kind={current.kind} />
            </div>
          </div>

          {!canSelect && (
            <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              当前配置未启用模型切换
            </p>
          )}

          {data.chain.length > 0 && (
            <section className="mt-4">
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                默认链
              </h3>
              <ol className="space-y-1">
                {data.chain.map((model, index) => {
                  const isCurrent = model.id === current.id;
                  return (
                    <li
                      key={`${model.provider}/${model.id}/${index}`}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                        isCurrent ? "bg-primary/8 text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{model.name || model.label}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
                          {model.id}
                        </span>
                      </span>
                      {isCurrent && <span className="size-1.5 rounded-full bg-primary" title="当前" />}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {canSelect && (
            <section className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  可选模型
                </h3>
                <span className="text-[11px] text-muted-foreground/70">
                  {data.selectable.length} 个
                </span>
              </div>

              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.supplier}>
                    <p className="mb-1 px-1 text-[11px] font-medium text-foreground/80">
                      {group.label}
                    </p>
                    <div className="space-y-2">
                      {group.families.map((family) => (
                        <div key={family.family}>
                          <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                            {family.label}
                          </p>
                          <div className="space-y-1">
                            {family.items.map((model) => {
                              const isCurrentItem = model.id === current.id;
                              const isPending = pendingModelId === model.id;
                              return (
                                <button
                                  key={`${model.provider}/${model.id}`}
                                  type="button"
                                  disabled={pendingPrimary || pendingModelId !== null}
                                  onClick={() => onSelect(model.id)}
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                                    isCurrentItem
                                      ? "border-primary/30 bg-primary/8"
                                      : "border-transparent hover:border-border hover:bg-accent/60",
                                    "disabled:cursor-not-allowed disabled:opacity-60",
                                  )}
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium">
                                      {model.name || model.label}
                                    </span>
                                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                      {model.id}
                                    </span>
                                  </span>
                                  {model.contextWindow !== undefined && (
                                    <Badge variant="outline" className="shrink-0">
                                      {formatContextWindow(model.contextWindow)}
                                    </Badge>
                                  )}
                                  {isPending ? (
                                    <Spinner className="size-3.5 shrink-0" />
                                  ) : isCurrentItem ? (
                                    <Check className="size-4 shrink-0 text-primary" />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {mutationError && (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {mutationError}
            </p>
          )}

          {activeReply && canSelect && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              当前回复进行中，切换会在下一次回复生效。
            </p>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border/70 p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!canSelect || current.kind === "primary" || pendingPrimary || pendingModelId !== null}
          onClick={onPrimary}
        >
          {pendingPrimary ? <Spinner className="size-3.5" /> : <RotateCcw className="size-3.5" />}
          切回主模型
        </Button>
        <p className="mt-2 text-center text-[10px] text-muted-foreground/80">
          选择只改变后续回复，不产生聊天消息，也不调用模型。
        </p>
      </div>
    </div>
  );
}

export function ModelPicker() {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const models = useModelsQuery();
  const mutation = useModelSelection();
  const activeStatus = useChatStore((state) => state.activeStatus);

  const current = models.data?.current;
  const label = current ? current.name || current.label : models.isLoading ? "加载模型…" : "模型";

  const pendingModelId =
    mutation.isPending && mutation.variables?.action === "select"
      ? mutation.variables.modelId
      : null;
  const pendingPrimary =
    mutation.isPending && mutation.variables?.action === "primary";

  const mutationError = mutation.error
    ? errorText(toApiError(mutation.error).code, toApiError(mutation.error).message)
    : null;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      mutation.reset();
      void models.refetch();
    }
  };

  const select = (modelId: string) => {
    mutation.mutate(
      { action: "select", modelId },
      { onSuccess: () => setOpen(false) },
    );
  };

  const primary = () => {
    mutation.mutate({ action: "primary" }, { onSuccess: () => setOpen(false) });
  };

  const body = (
    <PickerBody
      data={models.data}
      loading={models.isFetching}
      queryError={models.isError}
      onReload={() => void models.refetch()}
      onSelect={select}
      onPrimary={primary}
      pendingModelId={pendingModelId}
      pendingPrimary={pendingPrimary}
      mutationError={mutationError}
      activeReply={activeStatus !== null}
      onClose={() => setOpen(false)}
    />
  );

  const triggerButton = (onClick?: () => void) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-9 max-w-[13.5rem] gap-1.5 rounded-full px-3"
      aria-label="模型选择"
      onClick={onClick}
    >
      <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[7.5rem] truncate text-xs font-medium sm:max-w-[10rem]">
        {label}
      </span>
      {current ? (
        <ModelBadge kind={current.kind} />
      ) : (
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      )}
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
    </Button>
  );

  if (!isDesktop) {
    return (
      <>
        {triggerButton(() => changeOpen(true))}
        <Dialog open={open} onOpenChange={changeOpen}>
          <SheetContent>
            <DialogTitle className="sr-only">模型</DialogTitle>
            <div className="flex h-[min(34rem,82vh)] min-h-0 flex-col">{body}</div>
          </SheetContent>
        </Dialog>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{triggerButton()}</PopoverTrigger>
      <PopoverContent className="w-[23rem] overflow-hidden" align="end">
        <div className="h-[min(32rem,75vh)]">{body}</div>
      </PopoverContent>
    </Popover>
  );
}
