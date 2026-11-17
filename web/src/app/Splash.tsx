import { Asterisk } from "lucide-react";

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-11 animate-pulse items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Asterisk className="size-5" strokeWidth={2.5} />
        </div>
        <p className="text-xs text-muted-foreground">正在启动…</p>
      </div>
    </div>
  );
}
