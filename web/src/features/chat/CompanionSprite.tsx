import asterIdleUrl from "@/assets/companion/aster-idle.png";
import asterTypingSheetUrl from "@/assets/companion/aster-typing-sheet.png";
import asterEyeBlinkIdleUrl from "@/assets/companion/aster-eye-blink-idle.png";
import asterEyeBlinkLaptopUrl from "@/assets/companion/aster-eye-blink-laptop.png";
import asterEyeSquintLaptopUrl from "@/assets/companion/aster-eye-squint-laptop.png";

export type CompanionMode = "idle" | "working" | "busy";

export function deriveCompanionMode(
  activeStatus: "queued" | "running" | null,
  queueLength: number,
  activeSubagents = 0,
): CompanionMode {
  if ((activeStatus === "running" || activeSubagents > 0) && queueLength > 0) return "busy";
  if (activeStatus === "running" || activeStatus === "queued" || activeSubagents > 0) return "working";
  return "idle";
}

const MODE_LABEL: Record<CompanionMode, string> = {
  idle: "闲置",
  working: "工作中",
  busy: "忙碌",
};

/**
 * 顶部独立 3D 透明虚拟形象：
 * - 无圆形底板、无状态胶囊、保持原始比例 object-fit: contain；
 * - 闲置：脚底锚定轻呼吸 + 自然眨眼；
 * - 工作/忙碌：16 帧笔记本敲键盘 GPU 雪碧图 + 独立眨眼与专注微眯眼贴片层。
 */
export function CompanionSprite({
  mode,
  size,
}: {
  mode: CompanionMode;
  size: number;
}) {
  const label = MODE_LABEL[mode];
  const speed = mode === "busy" ? "busy" : "work";

  return (
    <div className="flex shrink-0 flex-col items-center" style={{ overflow: "visible" }}>
      <div
        className="pointer-events-auto relative shrink-0"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          aspectRatio: "1 / 1",
          overflow: "visible",
        }}
        role="img"
        aria-label={`Aster 当前状态：${label}`}
      >
        {mode === "idle" ? (
          <div className="aster-idle-breathe relative size-full">
            <img
              src={asterIdleUrl}
              alt={`Aster ${label}`}
              className="aster-sprite-layer block select-none"
              decoding="sync"
              draggable={false}
            />
            <img
              src={asterEyeBlinkIdleUrl}
              alt=""
              aria-hidden
              className="aster-sprite-layer aster-expr-blink-idle block select-none"
              decoding="sync"
              draggable={false}
            />
          </div>
        ) : (
          <>
            <div className="size-full overflow-hidden">
              <img
                src={asterTypingSheetUrl}
                alt={`Aster ${label}`}
                className={`aster-typing-strip aster-typing-${speed} select-none`}
                style={{ width: `${size * 16}px`, height: `${size}px` }}
                decoding="sync"
                draggable={false}
              />
            </div>
            <img
              src={asterEyeBlinkLaptopUrl}
              alt=""
              aria-hidden
              className={`aster-sprite-layer aster-expr-blink-${speed} block select-none`}
              decoding="sync"
              draggable={false}
            />
            <img
              src={asterEyeSquintLaptopUrl}
              alt=""
              aria-hidden
              className={`aster-sprite-layer aster-expr-squint-${speed} block select-none`}
              decoding="sync"
              draggable={false}
            />
          </>
        )}
      </div>
    </div>
  );
}
