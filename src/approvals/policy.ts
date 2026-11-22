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
const BENIGN_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "NUL", "nul"]);

const READONLY_SHELL_COMMANDS = new Set([
  "cd", "ls", "ll", "dir", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag",
  "stat", "file", "du", "df", "which", "where", "whoami", "id", "date", "uname", "env", "printenv",
  "echo", "printf", "sort", "uniq", "cut", "tr", "awk", "jq", "tree", "realpath", "dirname",
  "basename", "readlink", "test", "[", "true", "false", "ps", "uptime",
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "describe",
]);

function extractStringField(args: unknown, keys: readonly string[]): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function stripQuotes(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

/** Split a shell string into top-level command segments on `&&`, `||`, `;`, `|`, `\n` outside quotes. */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      i++;
      continue;
    }
    if (ch === "|" && command[i - 1] !== ">") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments;
}

/** Tokenize a single shell command segment respecting single and double quotes. */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Extract candidate destination file/directory paths written by a shell command. */
export function extractShellWriteTargets(command: string): string[] {
  const targets: string[] = [];

  // 1. Output redirections: >, >>, 1>, 2>, &>, &>>, >|
  const redirectRegex = /(?:^|[\s;&|()])(?:\d*&?>{1,2}\|?|&>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>]+))/g;
  for (const match of command.matchAll(redirectRegex)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw === "" || raw.startsWith("&") || BENIGN_REDIRECT_TARGETS.has(raw)) continue;
    targets.push(raw);
  }

  // 2. Per-segment write commands (tee, cp, mv, install, ln, touch, mkdir, truncate, dd, sed -i, rm)
  for (const segment of splitShellSegments(command)) {
    const rawTokens = tokenizeSegment(segment);
    // Skip leading env assignments (KEY=VALUE)
    let start = 0;
    while (start < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[start]!)) start++;
    const tokens = rawTokens.slice(start);
    const cmd = tokens[0];
    if (cmd === undefined) continue;

    if (cmd === "tee") {
      for (const tok of tokens.slice(1)) {
        if (tok.startsWith("-")) continue;
        if (!BENIGN_REDIRECT_TARGETS.has(tok)) targets.push(tok);
      }
      continue;
    }

    if (cmd === "cp" || cmd === "mv" || cmd === "install" || cmd === "ln") {
      let explicitDir: string | undefined;
      const positionals: string[] = [];
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok === "-t" && tokens[i + 1] !== undefined) {
          explicitDir = tokens[++i]!;
          continue;
        }
        if (tok.startsWith("--target-directory=")) {
          explicitDir = tok.slice("--target-directory=".length);
          continue;
        }
        if (tok.startsWith("-")) continue;
        positionals.push(tok);
      }
      if (explicitDir !== undefined) targets.push(explicitDir);
      else if (positionals.length >= 2) targets.push(positionals[positionals.length - 1]!);
      continue;
    }

    if (cmd === "touch" || cmd === "mkdir" || cmd === "truncate" || cmd === "rm") {
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (cmd === "truncate" && (tok === "-s" || tok === "--size")) {
          i++;
          continue;
        }
        if (tok.startsWith("-")) continue;
        targets.push(tok);
      }
      continue;
    }

    if (cmd === "dd") {
      for (const tok of tokens.slice(1)) {
        if (tok.startsWith("of=")) {
          const dest = tok.slice(3);
          if (dest !== "" && !BENIGN_REDIRECT_TARGETS.has(dest)) targets.push(dest);
        }
      }
      continue;
    }

    if (cmd === "sed") {
      const hasInPlace = tokens.some((tok) => tok === "-i" || tok.startsWith("-i") || tok === "--in-place");
      if (hasInPlace) {
        const positionals = tokens.slice(1).filter((tok) => !tok.startsWith("-"));
        // First positional is usually the sed script unless -e was used; check trailing file args.
        const hasDashE = tokens.includes("-e");
        const fileArgs = hasDashE ? positionals : positionals.slice(1);
        for (const file of fileArgs) targets.push(file);
      }
      continue;
    }

    // Inline script one-liners writing to explicit external paths (e.g. python3 -c "open('/tmp/x','w')...")
    if (/^(?:python3?|node|perl|ruby)$/.test(cmd) && /(?:write|open\(|Path\(|fs\.)/.test(segment)) {
      const pathLiteralRegex = /['"]((?:\/|\.\.[/\\]|~[/\\])[^'"]+)['"]/g;
      for (const match of segment.matchAll(pathLiteralRegex)) {
        const p = match[1]?.trim();
        if (p && !BENIGN_REDIRECT_TARGETS.has(p)) targets.push(p);
      }
    }
  }

  return targets.map(stripQuotes);
}

/** True when a shell command is strictly composed of safe read-only operations (no writes/redirections). */
export function isSafeReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  // Disallow command substitution or backticks.
  if (trimmed.includes("$(") || trimmed.includes("`")) return false;
  // Disallow any output redirection other than benign fd/null redirects like 2>/dev/null or 2>&1.
  const strippedBenign = trimmed
    .replace(/\b\d*>&\d+\b/g, "")
    .replace(/\b\d*&?>{1,2}\s*(?:\/dev\/null|\/dev\/stderr|\/dev\/stdout|NUL)\b/gi, "");
  if (/>/.test(strippedBenign)) return false;

  const segments = splitShellSegments(strippedBenign);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    const rawTokens = tokenizeSegment(segment);
    let start = 0;
    while (start < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[start]!)) start++;
    const tokens = rawTokens.slice(start);
    const cmd = tokens[0];
    if (cmd === undefined) return false;

    if (cmd === "find") {
      const unsafeFindFlags = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);
      if (tokens.some((tok) => unsafeFindFlags.has(tok))) return false;
      continue;
    }

    if (cmd === "git") {
      const sub = tokens[1];
      if (sub === undefined) return false;
      if (READONLY_GIT_SUBCOMMANDS.has(sub)) continue;
      if (sub === "branch" && !tokens.some((tok) => /^-[dDmM]$/.test(tok) || tok === "--delete" || tok === "--move")) {
        continue;
      }
      return false;
    }

    if (!READONLY_SHELL_COMMANDS.has(cmd)) return false;
  }

  return true;
}

/** True when `targetPath` resolves strictly outside `workspace`. */
export function isOutsideWorkspace(workspace: string, cwd: string | undefined, targetPath: string): boolean {
  const trimmed = targetPath.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") || trimmed.startsWith("$HOME") || trimmed.startsWith("${HOME}")) {
    return true;
  }
  const root = resolve(workspace);
  const base = cwd === undefined ? root : resolve(cwd);
  const resolved = resolve(base, trimmed);
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
  // 1. Destructive shell commands & shell workspace-escape writes (always checked first for bash).
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
      for (const targetPath of extractShellWriteTargets(command)) {
        if (isOutsideWorkspace(context.workspace, context.cwd, targetPath)) {
          return {
            sensitive: true,
            rule: "workspace_escape",
            reason: `Shell 命令试图写入工作区 (${context.workspace}) 之外的路径：${targetPath}`,
            categoryKey: "bash:workspace_escape",
            summary: `bash -> ${targetPath}`,
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
    // Allow strictly read-only shell commands (e.g. ls, cat, find, git status) without noisy prompts.
    const command = toolName === "bash" ? extractStringField(args, ["command", "cmd", "script"]) : undefined;
    if (toolName !== "bash" || command === undefined || !isSafeReadOnlyShellCommand(command)) {
      return {
        sensitive: true,
        rule: "subagent_write_escalation",
        reason: `Sub-agent (${context.caller.subagentId}) 未获得工作区写权限或写锁，尝试执行 ${toolName}`,
        categoryKey: `subagent:${toolName}:write_escalation`,
        summary: `${toolName} (subagent ${context.caller.subagentId})`,
      };
    }
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
