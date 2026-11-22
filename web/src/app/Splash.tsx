import asterIdleUrl from "@/assets/companion/aster-idle.png";

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <img
          src={asterIdleUrl}
          alt="Aster"
          className="size-16 animate-pulse select-none object-contain"
          draggable={false}
        />
        <p className="text-xs text-muted-foreground">正在启动…</p>
      </div>
    </div>
  );
}
