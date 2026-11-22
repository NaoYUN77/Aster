import { isAbsolute, relative, resolve } from "node:path";
import type { ToolRecord } from "../tools.js";

export type ApprovalRuleId =
  | "destructive_shell"
  | "workspace_escape"
  | "external_write"
  | "subagent_write_escalation";

export type ApprovalCaller =
  | { readonly kind: "main"; readonly conversationId: string }
  | { readonly kind: "subagent"; readonly subagentId: string; readonly task: string };

export type ApprovalPolicyContext = {
  readonly workspace: string;
  readonly cwd?: string;
  readonly caller: ApprovalCaller;
  /** For sub-agents: whether this run holds workspace write authority. Defaults to true for main. */
  readonly workspaceWriteAllowed?: boolean;
};

export type ApprovalEvaluation =
  | { readonly sensitive: false }
  | {
      readonly sensitive: true;
      readonly rule: ApprovalRuleId;
      readonly reason: string;
      readonly categoryKey: string;
      readonly summary: string;
    };

const DESTRUCTIVE_SHELL_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)\b/, label: "递归强制删除 (rm -rf)" },
  { pattern: /(?:^|[;&|]\s*)rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(?:\/|~|\$HOME|\.\.)/, label: "跨目录递归删除" },
  { pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?|\s-f\b)/, label: "强制推送 (git push --force)" },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: "强制重置工作区 (git reset --hard)" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d|\bgit\s+clean\s+-[a-zA-Z]*d[a-zA-Z]*f/, label: "强制清理未跟踪文件 (git clean -fd)" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b/, label: "远程脚本管道执行" },
  { pattern: /(?:^|[;&|]\s*)sudo\s+/, label: "提权执行 (sudo)" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\b/, label: "全局开放权限 (chmod 777)" },
  { pattern: /(?:^|[;&|]\s*)chown\s+/, label: "修改文件所有者 (chown)" },
  { pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|dd\s+if=|shutdown\b|reboot\b|halt\b|poweroff\b)/, label: "系统级破坏或重启命令" },
  { pattern: /\bRemove-Item\b[^\n;&|]*(?:-Recurse[^\n;&|]*-Force|-Force[^\n;&|]*-Recurse)/i, label: "递归强制删除 (Remove-Item -Recurse -Force)" },
  { pattern: /\b(?:del|erase)\s+\/[a-zA-Z]*s[a-zA-Z]*\b|\b(?:rd|rmdir)\s+\/[a-zA-Z]*s[a-zA-Z]*\b/i, label: "递归删除目录 (Windows)" },
];

const WORKSPACE_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

function extractStringField(args: unknown, keys: readonly string[]): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** True when `targetPath` resolves strictly outside `workspace`. */
export function isOutsideWorkspace(workspace: string, cwd: string | undefined, targetPath: string): boolean {
  const root = resolve(workspace);
  const base = cwd === undefined ? root : resolve(cwd);
  const resolved = resolve(base, targetPath);
  const rel = relative(root, resolved);
  return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/**
 * Deterministic host-enforced check for whether a tool call requires owner approval.
 * Read-only tools are never intercepted unless they fail another explicit host boundary.
 */
export function evaluateSensitiveOperation(
  toolName: string,
  args: unknown,
  record: Pick<ToolRecord, "source" | "authz">,
  context: ApprovalPolicyContext,
): ApprovalEvaluation {
  // 1. Destructive shell commands (always checked first for bash).
  if (toolName === "bash") {
    const command = extractStringField(args, ["command", "cmd", "script"]);
    if (command !== undefined) {
      for (const { pattern, label } of DESTRUCTIVE_SHELL_PATTERNS) {
        if (pattern.test(command)) {
          return {
            sensitive: true,
            rule: "destructive_shell",
            reason: `命中危险 Shell 规则：${label}`,
            categoryKey: "bash:destructive_shell",
            summary: `bash: ${command.slice(0, 120)}`,
          };
        }
      }
    }
  }

  // 2. Workspace escape on file write/edit tools.
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const targetPath = extractStringField(args, ["path", "file_path", "filePath", "target", "targetPath"]);
    if (targetPath !== undefined && isOutsideWorkspace(context.workspace, context.cwd, targetPath)) {
      return {
        sensitive: true,
        rule: "workspace_escape",
        reason: `目标路径越出允许的工作区 (${context.workspace})：${targetPath}`,
        categoryKey: `${toolName}:workspace_escape`,
        summary: `${toolName}: ${targetPath}`,
      };
    }
  }

  // 3. Sub-agent workspace write escalation (no workspace write authority / mutex).
  if (
    context.caller.kind === "subagent"
    && context.workspaceWriteAllowed === false
    && WORKSPACE_MUTATING_TOOLS.has(toolName)
  ) {
    return {
      sensitive: true,
      rule: "subagent_write_escalation",
      reason: `Sub-agent (${context.caller.subagentId}) 未获得工作区写权限或写锁，尝试执行 ${toolName}`,
      categoryKey: `subagent:${toolName}:write_escalation`,
      summary: `${toolName} (subagent ${context.caller.subagentId})`,
    };
  }

  // 4. Irreversible external write operations (MCP / plugin / connector write tools).
  if (
    record.authz === "write"
    && (record.source.kind !== "builtin" || toolName.startsWith("connector_"))
  ) {
    const sourceLabel = record.source.kind === "mcp"
      ? `mcp:${record.source.server}`
      : record.source.kind === "plugin"
        ? `plugin:${record.source.plugin}`
        : `builtin:${record.source.extension}`;
    return {
      sensitive: true,
      rule: "external_write",
      reason: `外部写操作需要审批 (${sourceLabel} / ${toolName})`,
      categoryKey: `external_write:${sourceLabel}:${toolName}`,
      summary: `${toolName} (${sourceLabel})`,
    };
  }

  return { sensitive: false };
}
