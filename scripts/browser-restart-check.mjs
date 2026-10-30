// Host orchestrator; the operator restarts the dedicated browser in another terminal.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
const scripts = fileURLToPath(new URL(".", import.meta.url));
const input = createInterface({ input: process.stdin, output: process.stdout });
const child = spawn("docker", ["run", "--rm", "-i", "--network", "aster-browser-v1-check", "--env", "BROWSER_CDP_URL=http://aster-browser:9222",
  "--mount", "type=volume,source=aster-browser-v1-check,target=/data/browser", "--mount", `type=bind,source=${scripts},target=/app/scripts,readonly`,
  "--entrypoint", "node", "aster:browser-v1", "scripts/browser-restart-worker.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let pending = "";
let prompted = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending = (pending + chunk.toString()).slice(-4096);
  if (!prompted && pending.includes("READY_FOR_BROWSER_RESTART")) {
    prompted = true;
    input.question("Restart the dedicated aster-browser-v1-check container in another terminal; press Enter when complete: ")
      .then(() => child.stdin.end("restarted\n"))
      .catch(() => { child.kill(); process.exitCode = 1; });
  }
});
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90_000);
child.on("error", () => { clearTimeout(timeout); input.close(); process.exitCode = 1; });
child.on("exit", (code) => { clearTimeout(timeout); input.close(); if (code !== 0) process.exitCode = 1; });
