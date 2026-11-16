import { Navigate, useNavigate } from "react-router-dom";
import { Asterisk, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { platform, platformLabel } from "@/lib/platform";
import { useAuthStore } from "@/store/auth";
import { useConnectionStore } from "@/store/connection";
import { ServerAddressForm } from "./ServerAddressForm";

export function SetupPage() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const status = useAuthStore((state) => state.status);
  const navigate = useNavigate();

  const goBack = () => {
    navigate(status === "authenticated" ? "/" : "/login", { replace: true });
  };

  // Web 同源，不提供服务器地址输入（架构文档 5.4）。
  if (platform() === "web") {
    return <Navigate to={status === "authenticated" ? "/" : "/login"} replace />;
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center gap-2">
          {baseUrl !== "" && (
            <Button variant="ghost" size="icon-sm" onClick={goBack} aria-label="返回">
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Asterisk className="size-5" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">连接 Aster 服务器</h1>
            <p className="text-[11px] text-muted-foreground">
              {platformLabel()} · 配置你自己的自托管地址
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/5 dark:shadow-black/30">
          <ServerAddressForm
            initialUrl={baseUrl}
            submitLabel="保存并继续"
            onSaved={() => navigate(status === "authenticated" ? "/" : "/login", { replace: true })}
          />
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          地址只保存在本机；不会写进构建产物。Web 端默认同源，不显示此页。
        </p>
      </div>
    </div>
  );
}
