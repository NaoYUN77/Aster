import type { CapacitorConfig } from "@capacitor/cli";

/**
 * 手机壳：只加载同一份 web/dist，不复制 UI。
 * 服务器地址由应用内设置页写入 Preferences。
 */
const config: CapacitorConfig = {
  appId: "com.aster.mobile",
  appName: "Aster",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
