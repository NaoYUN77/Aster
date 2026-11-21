import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { playCue } from "@/lib/sound";
import { useSoundStore } from "@/store/sound";

/** 提示音开关；开启时播放一次成功音，兼作试听。 */
export function SoundToggle({ className }: { className?: string }) {
  const muted = useSoundStore((state) => state.muted);
  const toggle = useSoundStore((state) => state.toggle);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-pressed={!muted}
      aria-label={muted ? "开启提示音" : "关闭提示音"}
      title={muted ? "提示音已关闭" : "提示音已开启"}
      onClick={() => {
        const willUnmute = muted;
        toggle();
        if (willUnmute) playCue("success");
      }}
    >
      {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
    </Button>
  );
}
