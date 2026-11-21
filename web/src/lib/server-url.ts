export type ServerUrlValidation =
  | { ok: true; url: string }
  | { ok: false; message: string };

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** 去尾部斜杠；缺省 schema 时补 https://。 */
export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (value === "") return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`;
  }
  return value.replace(/\/+$/, "");
}

export function validateServerUrl(input: string): ServerUrlValidation {
  const normalized = normalizeServerUrl(input);
  if (normalized === "") {
    return { ok: false, message: "请填写服务器地址，例如 https://aster.example.com" };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, message: "地址格式不正确，请填写完整 URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "只支持 https://（本机开发可用 http://localhost）" };
  }
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    return { ok: false, message: "远程服务器必须使用 https://" };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, message: "只填写协议、域名和端口，不要带路径" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, message: "地址不能包含查询参数或锚点" };
  }

  return { ok: true, url: normalized };
}

/** Web 端默认同源；开发时 Vite 代理 /api 到本地后端。 */
export function defaultWebBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (configured && configured.trim() !== "") {
    return normalizeServerUrl(configured);
  }
  return window.location.origin;
}
