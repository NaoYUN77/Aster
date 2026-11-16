import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Asterisk, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { userFacingMessage } from "@/api/errors";
import { USE_MOCK } from "@/lib/env";
import { platformLabel } from "@/lib/platform";
import { useAuthStore } from "@/store/auth";
import { useConnectionStore } from "@/store/connection";

const MOCK_PASSWORD = "aster-demo";

export function LoginPage() {
  const status = useAuthStore((state) => state.status);
  const login = useAuthStore((state) => state.login);
  const needsServer = useConnectionStore((state) => state.needsServer);
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (needsServer) return <Navigate to="/setup" replace />;
  if (status === "authenticated") return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (loginError) {
      setError(userFacingMessage(loginError));
      setPassword("");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-background px-5 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -top-24 size-72 rounded-full bg-primary/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -right-16 size-72 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Asterisk className="size-6" strokeWidth={2.5} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Aster</h1>
          <p className="mt-1 text-sm text-muted-foreground">单 owner 自托管聊天</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border border-border bg-card p-5 shadow-xl shadow-black/5 dark:shadow-black/30"
        >
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            密码
          </label>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入访问密码"
              autoComplete="current-password"
              autoFocus
              className="pl-9 pr-10"
              disabled={pending}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {error && (
            <p className="mt-2.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" className="mt-4 w-full" disabled={pending || password === ""}>
            {pending ? <Spinner /> : null}
            {pending ? "登录中…" : "登录"}
          </Button>

          {USE_MOCK && (
            <p className="mt-3 rounded-md bg-warning/10 px-2.5 py-1.5 text-center text-[11px] leading-relaxed text-warning">
              Mock 模式：密码为 <code className="font-mono">{MOCK_PASSWORD}</code>
              ，未连接真实后端。
            </p>
          )}
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[11px] text-muted-foreground">
          <span>{platformLabel()}</span>
          <span className="text-border">·</span>
          <span className="max-w-[16rem] truncate font-mono" title={baseUrl}>
            {baseUrl || "未配置服务器"}
          </span>
          {platformLabel() !== "Web" && (
            <>
              <span className="text-border">·</span>
              <button
                type="button"
                onClick={() => navigate("/setup")}
                className="underline underline-offset-2 hover:text-foreground"
              >
                更换服务器
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
