import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const official = path.resolve(webRoot, "../docs/api/three-client-v1.openapi.yaml");
const draft = path.resolve(webRoot, "openapi/three-client-v1.draft.yaml");
const output = path.resolve(webRoot, "src/api/schema.d.ts");

const input = existsSync(official) ? official : draft;
const cli = path.resolve(webRoot, "node_modules/openapi-typescript/bin/cli.js");

console.log(
  existsSync(official)
    ? `[gen-api] 使用 Dev 1 正式契约：${path.relative(webRoot, official)}`
    : "[gen-api] 正式契约不存在，暂用前端 draft：openapi/three-client-v1.draft.yaml",
);

execFileSync(process.execPath, [cli, input, "-o", output], {
  stdio: "inherit",
  cwd: webRoot,
});

console.log(`[gen-api] 已生成 ${path.relative(webRoot, output)}`);
