import { useState } from "react";
import { Bell, X } from "lucide-react";
import { toast } from "sonner";
import { playCue } from "@/lib/sound";
import { useNotificationStore } from "@/store/notifications";

/**
 * 首次进入聊天页且系统通知权限为 default 时显示的极轻 Meta Muse 引导条；
 * 由用户点击手势触发权限申请，支持一键关闭并持久化记住。
 */
export function NotificationPromptBanner() {
  const hydrated = useNotificationStore((state) => state.hydrated);
  const permission = useNotificationStore((state) => state.permission);
  const bannerDismissed = useNotificationStore((state) => state.bannerDismissed);
  const requestPermission = useNotificationStore((state) => state.requestPermission);
  const dismissBanner = useNotificationStore((state) => state.dismissBanner);
  const [requesting, setRequesting] = useState(false);

  if (!hydrated || permission !== "default" || bannerDismissed) return null;

  const handleEnable = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const next = await requestPermission();
      if (next === "granted") {
        playCue("success");
        toast.success("已开启系统提醒通知");
      } else if (next === "denied") {
        toast.info("通知权限被拒绝，可随时在浏览器或系统设置中开启");
      }
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-3xl px-3 pb-1 pt-0.5 sm:px-6">
        <div className="flex items-center justify-between gap-2.5 rounded-full border border-border/80 bg-secondary/75 py-1.5 pl-3.5 pr-2 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Bell className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="truncate">开启系统提醒，后台等待审批或定时提醒不错过</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={requesting}
              onClick={() => void handleEnable()}
              className="rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {requesting ? "申请中…" : "开启"}
            </button>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label="关闭通知引导"
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
