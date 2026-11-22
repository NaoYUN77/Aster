import { useSoundStore } from "@/store/sound";

/**
 * 本地合成提示音（Web Audio），不加载外网音频，也不使用任何现成音效文件。
 *
 * - attention：水滴感单音（凭证请求）
 * - success：两声上行短音（授权/提交完成）
 * - error：低音下行（连接或提交失败）
 *
 * 浏览器要求首次用户手势后才能出声；App 挂载时调用 initAudioUnlock()，
 * 在第一次 pointerdown / keydown / touchstart 时创建并 resume AudioContext。
 */

export type SoundCue = "attention" | "success" | "error";

type AudioContextConstructor = typeof AudioContext;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (context) return context;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext;
  if (!ctor) return null;
  try {
    context = new ctor();
  } catch {
    context = null;
  }
  return context;
}

export function initAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => {};

  const cleanup = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };

  const unlock = () => {
    const ctx = audioContext();
    if (!ctx) {
      cleanup();
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    cleanup();
  };

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock, { passive: true });
  return cleanup;
}

function tone(
  ctx: AudioContext,
  options: {
    frequency: number;
    endFrequency?: number;
    startAt: number;
    duration: number;
    gain: number;
    type?: OscillatorType;
  },
): void {
  const oscillator = ctx.createOscillator();
  const amp = ctx.createGain();

  oscillator.type = options.type ?? "sine";
  oscillator.frequency.setValueAtTime(options.frequency, options.startAt);
  if (options.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(
      options.endFrequency,
      options.startAt + options.duration,
    );
  }

  amp.gain.setValueAtTime(0.0001, options.startAt);
  amp.gain.exponentialRampToValueAtTime(
    options.gain,
    options.startAt + 0.012,
  );
  amp.gain.exponentialRampToValueAtTime(
    0.0001,
    options.startAt + options.duration,
  );

  oscillator.connect(amp);
  amp.connect(ctx.destination);
  oscillator.start(options.startAt);
  oscillator.stop(options.startAt + options.duration + 0.02);
}

export function playCue(cue: SoundCue): void {
  if (useSoundStore.getState().muted) return;

  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state !== "running") {
    // 还没有用户手势解锁时保持安静；unlock 后自然恢复。
    void ctx.resume().catch(() => {});
    return;
  }

  const now = ctx.currentTime + 0.01;

  switch (cue) {
    case "attention": {
      // 清脆双音提醒：用于敏感审批、定时提醒与凭据授权（高辨识度但不刺耳）。
      tone(ctx, {
        frequency: 987.77, // B5
        startAt: now,
        duration: 0.13,
        gain: 0.14,
      });
      tone(ctx, {
        frequency: 1318.51, // E6
        startAt: now + 0.11,
        duration: 0.22,
        gain: 0.14,
      });
      break;
    }
    case "success": {
      // 柔和短促水滴音：用于回复完成、子任务结束与操作成功。
      tone(ctx, {
        frequency: 1180,
        endFrequency: 780,
        startAt: now,
        duration: 0.14,
        gain: 0.11,
      });
      tone(ctx, {
        frequency: 1560,
        endFrequency: 1320,
        startAt: now + 0.025,
        duration: 0.07,
        gain: 0.04,
        type: "triangle",
      });
      break;
    }
    case "error": {
      // 温和低音提示：用于失败与告警。
      tone(ctx, {
        frequency: 220,
        endFrequency: 165,
        startAt: now,
        duration: 0.26,
        gain: 0.13,
        type: "triangle",
      });
      break;
    }
  }
}
