import { Navigate, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
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
    <div className="flex min-h-full items-center justify-center bg-background px-5 py-10 safe-top safe-bottom">
      <div className="w-full max-w-sm">
        {baseUrl !== "" && (
          <div className="mb-3">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              onClick={goBack}
              aria-label="返回"
            >
              <ArrowLeft className="size-4" />
            </Button>
          </div>
        )}

        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src={asterIdleUrl}
            alt="Aster"
            className="mb-3 size-20 select-none object-contain"
            draggable={false}
          />
          <h1 className="text-xl font-semibold tracking-tight">连接 Aster 服务器</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {platformLabel()} · 配置你的自托管地址
          </p>
        </div>

        <div className="rounded-3xl bg-secondary p-5">
          <ServerAddressForm
            initialUrl={baseUrl}
            submitLabel="保存并继续"
            onSaved={() =>
              navigate(status === "authenticated" ? "/" : "/login", { replace: true })
            }
          />
        </div>
      </div>
    </div>
  );
}
