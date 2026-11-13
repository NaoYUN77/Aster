#!/usr/bin/env node
// 合并门禁的策略检查器。唯一事实源是同目录的 policy-rules.json。
//
// 设计约束(见 docs: 为 coding agent 托底的 CI 门禁设计):
//   * 零依赖,只用 Node 内置模块。因为在 pull_request_target 下运行,
//     绝不允许执行 PR 的代码 —— 连 `npm ci` 都不行(它会跑安装脚本)。
//   * 失败只输出固定错误码 + 文件位置 + 规则名,不回显值、不输出上下文,
//     免得门禁本身变成外泄通道。
//   * 只检查"这次改动碰到的文件",不对既存历史做判定。
//
// 用法:
//   node scripts/ci/gate-policy.mjs --base <ref> [--head <ref>]   # 默认 head=HEAD
//   node scripts/ci/gate-policy.mjs --staged
//   node scripts/ci/gate-policy.mjs --base origin/main --labels "a,b" --json
//   node scripts/ci/gate-policy.mjs --base origin/main --allow-protected
//
// 退出码:0 = 通过;1 = 有违规;2 = 用法/环境错误。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const RULES = JSON.parse(readFileSync(join(here, "policy-rules.json"), "utf8"));

// ---------------------------------------------------------------- 工具

/** 规则里的正则统一按多行编译;允许写 "(?m)" 前缀,JS 本身不支持内联修饰符。 */
function compile(pattern) {
  const m = /^\(\?m\)/.exec(pattern);
  return new RegExp(m ? pattern.slice(4) : pattern, m ? "m" : "");
}

function git(args) {
  return execFileSync(
    "git",
    ["-c", "core.quotePath=false", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

/** 变更文件列表。返回 [{status, path, from?}] ,status 为 A/M/D/R 等单字母。 */
function changedFiles(...diffArgs) {
  const out = git(["diff", "--name-status", "--find-renames", "-z", ...diffArgs]);
  const parts = out.split("\0").filter((s) => s.length > 0);
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (/^[RC]\d+$/.test(st)) {
      const from = parts[i++];
      const to = parts[i++];
      files.push({ status: st[0], path: to, from });
    } else {
      files.push({ status: st[0][0], path: parts[i++] });
    }
  }
  return files;
}

/** 新增行的行号与内容:{ path -> [{n, text}] } */
function addedLines(...diffArgs) {
  const out = git(["diff", "-U0", "--no-color", "--find-renames", ...diffArgs]);
  const map = new Map();
  let path = null;
  let n = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (path && !map.has(path)) map.set(path, []);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -\S+ \+(\d+)/.exec(line);
      if (m) n = Number(m[1]);
      continue;
    }
    if (path && line.startsWith("+") && !line.startsWith("+++")) {
      map.get(path).push({ n, text: line.slice(1) });
      n += 1;
    }
  }
  return map;
}

function fileAt(ref, path) {
  return gitSafe(["show", `${ref}:${path}`]);
}

function listFilesAt(ref, glob) {
  const out = gitSafe(["ls-tree", "-r", "--name-only", ref]) ?? "";
  const rx = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return out.split("\n").filter((p) => p && rx.test(p));
}

function pathMatches(path, prefix) {
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const o = { base: null, head: "HEAD", staged: false, labels: [], json: false, allowProtected: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") o.base = argv[++i];
    else if (a === "--head") o.head = argv[++i];
    else if (a === "--staged") o.staged = true;
    else if (a === "--labels") o.labels = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--json") o.json = true;
    else if (a === "--allow-protected") o.allowProtected = true;
    else if (a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!o.staged && !o.base) { console.error("either --base <ref> or --staged is required"); process.exit(2); }
  return o;
}

function printHelp() {
  console.log(`usage: gate-policy.mjs --base <ref> [--head <ref>] [options]

  --base <ref>          range base (required unless --staged)
  --head <ref>          range head (default: HEAD)
  --staged              check the index instead of a commit range
  --labels <a,b>        PR labels already present (for protected-path rule)
  --allow-protected     skip the protected-path rule (local runs)
  --json                emit a machine-readable summary`);
}

// ---------------------------------------------------------------- 检查

const violations = [];
function fail(code, detail, extra) {
  violations.push({ code, detail, ...(extra ? { rule: extra } : {}) });
}

function checkProtectedPaths(files, opts) {
  if (opts.allowProtected) return;
  const rule = RULES.protectedPaths;
  if (opts.labels.includes(rule.label)) return;
  for (const f of files) {
    if (rule.paths.some((p) => pathMatches(f.path, p) || (f.from && pathMatches(f.from, p)))) {
      fail(rule.code, f.path, `needs label "${rule.label}"`);
    }
  }
}

function checkWorkflows(files, head, added) {
  const rule = RULES.workflow;
  for (const f of files) {
    if (!f.path.startsWith(rule.dir) || !f.path.endsWith(".yml")) continue;
    if (f.status === "D") continue;
    const text = fileAt(head, f.path);
    if (text === null) continue;

    for (const r of rule.forbidden) {
      const rx = compile(r.regex);
      text.split("\n").forEach((line, i) => {
        if (rx.test(line)) fail(r.code, `${f.path}:${i + 1}`, r.why);
      });
    }

    // 权限必须恰好是 contents: read。注意用 [ \t] 而不是 \s —— \s 会吃换行,
    // 让单行与块形式两条正则同时命中,同一处违规报两遍。
    const perms = [...text.matchAll(/^\s*permissions[ \t]*:[ \t]*([^\n]+)$/gm)].map((m) => m[1].trim());
    for (const p of perms) {
      if (!rule.permissions.allowed.includes(p)) fail(rule.permissions.code, f.path, `permissions: ${p}`);
    }
    // 块形式(permissions: 换行 + 缩进键)
    const blockPerms = [...text.matchAll(/^\s*permissions[ \t]*:[ \t]*\n((?:[ \t]+\S.*\n?)+)/gm)].map((m) => m[1]);
    for (const b of blockPerms) {
      for (const line of b.split("\n")) {
        const t = line.trim();
        if (!t || !t.includes(":")) continue;
        const [k, v] = t.split(":").map((s) => s.trim());
        if (!(k === "contents" && v === "read")) fail(rule.permissions.code, f.path, `permissions.${k}: ${v}`);
      }
    }

    // uses: 必须钉 40 位 SHA。
    const usesRx = new RegExp(rule.pinUses.regex, "gm");
    for (const m of text.matchAll(usesRx)) {
      const ref = m[1].replace(/["']/g, "");
      if (rule.pinUses.allowedRefs.some((p) => ref.startsWith(p))) continue;
      const at = ref.split("@")[1] ?? "";
      if (!/^[0-9a-f]{40}$/.test(at)) fail(rule.pinUses.code, f.path, ref);
    }

    // pull_request_target 只允许出现在白名单文件里。
    if (!rule.allowPullRequestTarget.includes(f.path)) {
      for (const { n, text: t } of added.get(f.path) ?? []) {
        if (/pull_request_target/.test(t)) fail("GATE_WORKFLOW_WEAKENED", `${f.path}:${n}`, "pull_request_target 未在白名单");
      }
    }
  }
}

function checkTests(base, head, added, files, opts) {
  const rule = RULES.tests;
  const approved = opts.labels.includes(RULES.protectedPaths.label);
  const isTest = (p) => /^test\/.*\.test\.ts$/.test(p);

  const atBase = listFilesAt(base, rule.glob).length;
  const atHead = listFilesAt(head, rule.glob).length;
  const deletedTestFiles = files.filter((f) => isTest(f.path) && f.status === "D").map((f) => f.path);
  // 盯"删除事件",不是盯"文件数"——删一个补一个就能骗过计数,盯事件骗不过。
  if (!approved) {
    if (deletedTestFiles.length > 0) {
      fail(rule.countCode, deletedTestFiles.join(", "), `删除测试文件 (需 "${RULES.protectedPaths.label}" 标签)`);
    } else if (atHead < atBase) {
      fail(rule.countCode, rule.glob, `base=${atBase} head=${atHead} (需 "${RULES.protectedPaths.label}" 标签)`);
    }
  }

  let weakened = false;
  for (const [path, lines] of added) {
    if (!isTest(path)) continue;
    for (const { n, text } of lines) {
      for (const r of rule.forbidden) {
        if (compile(r.regex).test(text)) { fail(r.code, `${path}:${n}`, r.why); weakened = true; }
      }
    }
  }

  return { deletedTestFiles, deleted: deletedTestFiles.length > 0, weakened };
}

function checkCompose(files, head) {
  const rule = RULES.compose;
  const changed = new Set(files.filter((f) => f.status !== "D").map((f) => f.path));

  if (changed.has(rule.baseFile)) {
    const text = fileAt(head, rule.baseFile) ?? "";
    for (const r of rule.requiredInBase) {
      if (!compile(r.regex).test(text)) fail(r.code, rule.baseFile, r.why);
    }
  }
  const overlayRx = new RegExp("^" + rule.overlayGlob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  for (const path of changed) {
    if (path !== rule.baseFile && !overlayRx.test(path)) continue;
    const text = fileAt(head, path);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      for (const r of rule.forbiddenInAny) {
        if (compile(r.regex).test(line)) fail(r.code, `${path}:${i + 1}`, r.why);
      }
    });
  }
}

function checkDependencies(files, head) {
  const rule = RULES.dependencies;
  const touchedManifest = files.some((f) => f.path === rule.manifest);
  if (!touchedManifest) return;
  const touchedLock = files.some((f) => f.path === rule.lockfile);
  if (!touchedLock) fail(rule.lockCode, rule.lockfile, "package.json 变了但 lockfile 没变");

  const text = fileAt(head, rule.manifest);
  if (text === null) return;
  let pkg;
  try { pkg = JSON.parse(text); } catch { fail(rule.code, rule.manifest, "package.json 不是合法 JSON"); return; }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec !== "string") continue;
      if (/^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|\d+\.\d+\.\d+\+[0-9A-Za-z.-]+)$/.test(spec)) continue;
      // 允许 file:/link:/git+ 这类显式来源,但必须写全。
      if (/^(file:|link:|workspace:|git\+|https:\/\/)/.test(spec)) continue;
      fail(rule.code, rule.manifest, `${field}.${name} = ${spec}`);
    }
  }
}

function checkTestScript(files, base, head, opts) {
  const rule = RULES.tests;
  if (!rule.scriptCode) return;
  if (!files.some((f) => f.path === "package.json")) return;
  if (opts.labels.includes(RULES.protectedPaths.label)) return;
  const testScriptAt = (ref) => {
    const t = fileAt(ref, "package.json");
    if (t === null) return null;
    try { return JSON.parse(t).scripts?.test ?? null; } catch { return null; }
  };
  const b = testScriptAt(base), h = testScriptAt(head);
  if (b === null && h === null) return;
  if (b !== h) fail(rule.scriptCode, "package.json scripts.test", `已变更 (需 "${RULES.protectedPaths.label}" 标签)`);
}

function checkSecrets(added) {
  const rule = RULES.secrets;
  const compiled = rule.patterns.map((p) => ({ name: p.name, rx: new RegExp(p.regex) }));
  for (const [path, lines] of added) {
    for (const { n, text } of lines) {
      for (const { name, rx } of compiled) {
        if (rx.test(text)) fail(rule.code, `${path}:${n}`, name);
      }
    }
  }
}

function checkDocsAsFix(files, testFindings) {
  // 只认"改文档 + 削弱测试"这个组合。仅仅"碰了文档也碰了测试"是绝大多数 PR 的常态,
  // 拿它报警只会把这条规则淹成噪声。
  const rule = RULES.docsAsFix;
  const docsTouched = files.some((f) => rule.docsPaths.some((p) => pathMatches(f.path, p)));
  if (!docsTouched) return;
  if (testFindings.deleted) fail(rule.code, testFindings.deletedTestFiles[0], "改文档同时删测试文件");
  else if (testFindings.weakened) fail(rule.code, RULES.tests.glob, "改文档同时弱化测试");
}

// ---------------------------------------------------------------- 主流程

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const diffArgs = opts.staged ? ["--cached"] : [`${opts.base}...${opts.head}`];

  const files = changedFiles(...diffArgs);
  const added = addedLines(...diffArgs);
  const head = opts.staged ? "HEAD" : opts.head;

  if (!opts.staged) checkProtectedPaths(files, opts);
  checkWorkflows(files, head, added);
  const testFindings = checkTests(opts.staged ? "HEAD" : opts.base, head, added, files, opts);
  checkCompose(files, head);
  checkDependencies(files, head);
  checkTestScript(files, opts.staged ? "HEAD" : opts.base, head, opts);
  checkSecrets(added);
  checkDocsAsFix(files, testFindings);

  if (opts.json) {
    console.log(JSON.stringify({
      status: violations.length === 0 ? "pass" : "fail",
      checksRun: ["protected-paths", "workflow", "tests", "compose", "dependencies", "test-script", "secrets", "docs-as-fix"],
      violations,
    }, null, 2));
  } else if (violations.length === 0) {
    console.log("gate-policy: pass");
  } else {
    for (const v of violations) {
      console.log(`${v.code}\t${v.detail}${v.rule ? `\t(${v.rule})` : ""}`);
    }
    console.log(`\ngate-policy: fail (${violations.length} violation(s))`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
