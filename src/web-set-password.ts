import { resolve, join } from "node:path";
import { hashPassword, savePasswordRecord, AUTH_FILE_NAME } from "./http/auth.js";

/**
 * `npm run web:set-password`
 *
 * Writes only the scrypt digest to DATA_DIR/web-auth.json (0600). The plaintext stays in the
 * terminal: it is never written to the environment, shell history, logs or the repository.
 */

function readAllStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolvePromise) => {
    let value = "";
    const finish = (result: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      resolvePromise(result);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          // Ctrl-C: leave nothing half-written.
          process.stderr.write("\n");
          process.exit(130);
        }
        if (character === "\u0004") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const path = join(dataDir, AUTH_FILE_NAME);

  let password: string;
  let confirmation: string | undefined;
  if (process.stdin.isTTY) {
    password = await readHidden("New web password: ");
    if (password === "") throw new Error("Password must not be empty");
    confirmation = await readHidden("Confirm web password: ");
  } else {
    // Non-interactive use (for example a provisioning script): first line is the password, an
    // optional second line confirms it. Piping is the caller's responsibility.
    const input = await readAllStdin();
    const lines = input.split(/\r?\n/);
    password = lines[0] ?? "";
    confirmation = lines[1] === undefined || lines[1] === "" ? password : lines[1];
    if (password === "") throw new Error("Password must not be empty");
  }

  if (password !== confirmation) throw new Error("Passwords do not match");
  savePasswordRecord(path, hashPassword(password));
  console.info(`Web password saved to ${path} (scrypt, mode 0600).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not set the web password");
  process.exitCode = 1;
});
