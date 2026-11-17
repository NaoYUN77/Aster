import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  const backend = env.VITE_DEV_BACKEND ?? "http://127.0.0.1:8787";
  const mockBuild = env.VITE_USE_MOCK === "1" || process.env.VITE_USE_MOCK === "1";

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        // mockServiceWorker.js 只在开发/mock 演示构建里需要，生产包不发布。
        name: "aster-strip-mock-worker",
        apply: "build",
        closeBundle() {
          if (!mockBuild) rmSync(path.resolve(root, "dist/mockServiceWorker.js"), { force: true });
        },
      },
    ],
    resolve: {
      // 默认生产构建把 mock 模块替换为空实现，MSW 与 fixture 不进入 dist。
      // 仅显式 VITE_USE_MOCK=1 的演示构建允许打包 mock（用于壳层离线验收）。
      alias: [
        ...(mode === "production" && !mockBuild
          ? [
              {
                find: /^@\/api\/mock\/browser$/,
                replacement: path.resolve(root, "src/api/mock/browser.stub.ts"),
              },
            ]
          : []),
        { find: "@", replacement: path.resolve(root, "src") },
      ],
    },
    server: {
      host: env.VITE_DEV_HOST ?? "127.0.0.1",
      port: 5173,
      strictPort: true,
      // 本地联调走同源代理，避免在开发机上额外配置 CORS。
      proxy: {
        "/api": { target: backend, changeOrigin: false },
      },
    },
    preview: { port: 4173, strictPort: true },
    build: {
      outDir: "dist",
      sourcemap: false,
      // Vite 8 默认目标是 baseline-widely-available（Chrome 107），会把
      // class static block / 私有字段原样输出；老 Android WebView 解析即
      // SyntaxError，表现为永远停在启动页。降到 ES2017 级别的语法目标。
      target: ["chrome61", "safari12", "firefox60", "edge79"],
    },
  };
});
