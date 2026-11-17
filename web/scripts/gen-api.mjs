import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 正式契约合并进 feat/三端联通 后优先使用；未合并期间用 web/ 里固定的官方快照。
const official = path.resolve(webRoot, "../docs/api/three-client-v1.openapi.yaml");
const snapshot = path.resolve(webRoot, "openapi/three-client-v1.official.yaml");
const draft = path.resolve(webRoot, "openapi/three-client-v1.draft.yaml");
const output = path.resolve(webRoot, "src/api/schema.d.ts");

const input = existsSync(official) ? official : existsSync(snapshot) ? snapshot : draft;
const source = input === official
  ? "Dev 1 正式契约"
  : input === snapshot
    ? "官方契约快照（Dev 1 PR #81，提交 4f4e99b）"
    : "前端 draft";
const cli = path.resolve(webRoot, "node_modules/openapi-typescript/bin/cli.js");

console.log(`[gen-api] 使用${source}：${path.relative(webRoot, input)}`);

execFileSync(process.execPath, [cli, input, "-o", output], {
  stdio: "inherit",
  cwd: webRoot,
});

console.log(`[gen-api] 已生成 ${path.relative(webRoot, output)}`);
