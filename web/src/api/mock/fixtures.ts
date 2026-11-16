import type { ModelRef, ModelsResponse, SelectableModel, UiMessage } from "../types";

/**
 * 仅用于 MSW mock 的 fixture。
 *
 * 这些 id 是明确虚构的（`mock/...`），只在本机 mock 模式显示；
 * 真实三端一律展示 GET /api/v1/models 返回的运行时目录（架构文档 0.2）。
 */

export const MOCK_PASSWORD = "aster-demo";
export const MOCK_OWNER_ID = "owner";

export const MOCK_PRIMARY: ModelRef = {
  provider: "mock",
  id: "mock/primary",
  name: "Mock Primary",
  label: "Mock Primary",
};

export const MOCK_FALLBACK: ModelRef = {
  provider: "mock",
  id: "mock/fallback",
  name: "Mock Fallback",
  label: "Mock Fallback",
};

export const MOCK_SELECTABLE: SelectableModel[] = [
  {
    provider: "mock",
    id: "mock/opencode-deepseek",
    name: "DeepSeek Mock",
    label: "DeepSeek Mock",
    supplier: "opencode",
    family: "deepseek",
    contextWindow: 128_000,
  },
  {
    provider: "mock",
    id: "mock/opencode-glm",
    name: "GLM Mock",
    label: "GLM Mock",
    supplier: "opencode",
    family: "glm",
    contextWindow: 200_000,
  },
  {
    provider: "mock",
    id: "mock/commandcode-deepseek-r1",
    name: "DeepSeek R1 Mock",
    label: "DeepSeek R1 Mock",
    supplier: "commandcode",
    family: "deepseek",
    contextWindow: 65_536,
  },
  {
    provider: "mock",
    id: "mock/commandcode-glm",
    name: "GLM 4.5 Mock",
    label: "GLM 4.5 Mock",
    supplier: "commandcode",
    family: "glm",
    contextWindow: 131_072,
  },
  {
    provider: "mock",
    id: "mock/commandcode-gemini-flash",
    name: "Gemini Flash Mock",
    label: "Gemini Flash Mock",
    supplier: "commandcode",
    family: "gemini-flash",
    contextWindow: 1_000_000,
  },
];

/** mock 中用于演示“手动模型不可用 → 降级”的模型。 */
export const MOCK_UNSTABLE_MODEL_ID = "mock/opencode-glm";

export function buildModelsResponse(selection: { id: string; kind: "manual" | "auto" } | null): ModelsResponse {
  const selected = selection
    ? MOCK_SELECTABLE.find((model) => model.id === selection.id)
    : undefined;

  const current = selected
    ? {
        provider: selected.provider,
        id: selected.id,
        name: selected.name,
        label: selected.label,
        kind: selection!.kind,
      }
    : {
        provider: MOCK_PRIMARY.provider,
        id: MOCK_PRIMARY.id,
        name: MOCK_PRIMARY.name ?? MOCK_PRIMARY.label,
        label: MOCK_PRIMARY.label,
        kind: "primary" as const,
      };

  return {
    canSelect: true,
    current,
    primary: MOCK_PRIMARY,
    chain: [MOCK_PRIMARY, MOCK_FALLBACK],
    selectable: MOCK_SELECTABLE,
    scope: {
      suppliers: ["opencode", "commandcode"],
      families: ["deepseek", "glm", "gemini-flash"],
      excludesSpeedVariants: true,
    },
  };
}

const SEED_TEXTS: Array<Omit<UiMessage, "id" | "createdAt">> = [
  {
    role: "assistant",
    text: "晚上好。**Mock 模式**已启动，当前没有连接真实后端。\n\n可以试试：发消息、停止回复、滚动加载更早历史、打开右上角的模型选择器。",
    status: "complete",
  },
  {
    role: "user",
    text: "帮我快速确认一下三端联调的验收项。",
    status: "complete",
  },
  {
    role: "assistant",
    text: "验收清单（节选）：\n\n1. 密码登录，错误密码被拒绝\n2. 发送文本，依次看到 **排队中 / 正在回复 / 完成**\n3. 停止正在生成的回复\n4. 刷新后历史仍在\n5. 模型选择器只使用 `/api/v1/models`\n\n> 生产 bot 不会在本轮被重启或部署。",
    status: "complete",
  },
  {
    role: "user",
    text: "$model list",
    status: "complete",
  },
  {
    role: "assistant",
    text: "可切模型（实时目录，共 5 个）：\n\n- `[opencode]` mock/opencode-deepseek（DeepSeek Mock）\n- `[opencode]` mock/opencode-glm（GLM Mock）\n- `[commandcode]` mock/commandcode-deepseek-r1（DeepSeek R1 Mock）\n- `[commandcode]` mock/commandcode-glm（GLM 4.5 Mock）\n- `[commandcode]` mock/commandcode-gemini-flash（Gemini Flash Mock）\n\n发 `$model <model id>` 切换；`$model primary` 回主模型。",
    status: "complete",
  },
  {
    role: "assistant",
    text: "我先跑一下检查。",
    status: "complete",
    tool: { name: "shell", status: "done" },
  },
  {
    role: "user",
    text: "好的，函数名用 normalizeServerUrl。",
    status: "complete",
  },
  {
    role: "assistant",
    text: "已记录。示例代码：\n\n```ts\nexport function normalizeServerUrl(input: string): string {\n  const value = input.trim();\n  return value.replace(/\\/+$/, \"\");\n}\n```\n\n行内示例：`normalizeServerUrl(\"https://a.example/\")` → `https://a.example`。",
    status: "complete",
  },
  {
    role: "user",
    text: "历史分页用 entry cursor，不要用数组下标。",
    status: "complete",
  },
  {
    role: "assistant",
    text: "收到，分页游标使用稳定的 entry id：\n\n- 初次加载最近 30 条\n- 上滚时带 `before=<cursor>` 拉更早\n- SSE 消息按服务端 id 去重\n\n| 状态 | 展示 |\n| --- | --- |\n| queued | 排队中 |\n| running | 正在回复 |\n| failed | 错误 + 重试 |",
    status: "complete",
  },
];

export function seedMessages(now = Date.now()): UiMessage[] {
  const messages: UiMessage[] = [];
  const total = 44;
  for (let index = 0; index < total; index += 1) {
    const template = SEED_TEXTS[index % SEED_TEXTS.length]!;
    const createdAt = now - (total - index) * 6 * 60_000;
    messages.push({
      id: `entry_seed_${String(index + 1).padStart(4, "0")}`,
      role: template.role,
      text: template.text,
      createdAt,
      status: "complete",
      requestId: template.role === "system" ? null : `req_seed_${Math.floor(index / 2) + 1}`,
      model:
        template.role === "assistant"
          ? { provider: MOCK_PRIMARY.provider, id: MOCK_PRIMARY.id, label: MOCK_PRIMARY.label }
          : null,
      errorCode: null,
      tool: template.tool ?? null,
    });
  }
  return messages;
}
