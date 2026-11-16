import { useState, type FormEvent } from "react";
import { CheckCircle2, PlugZap, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { validateServerUrl } from "@/lib/server-url";
import {
  useConnectionStore,
  type ConnectionTestResult,
} from "@/store/connection";

type ServerAddressFormProps = {
  initialUrl?: string;
  submitLabel?: string;
  onSaved?: (url: string) => void;
};

export function ServerAddressForm({
  initialUrl = "",
  submitLabel = "保存并继续",
  onSaved,
}: ServerAddressFormProps) {
  const saveServerUrl = useConnectionStore((state) => state.saveServerUrl);
  const testConnection = useConnectionStore((state) => state.testConnection);
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  const [url, setUrl] = useState(initialUrl || baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const runTest = async () => {
    const validation = validateServerUrl(url);
    if (!validation.ok) {
      setError(validation.message);
      setTestResult(null);
      return;
    }
    setError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(url);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const validation = validateServerUrl(url);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await saveServerUrl(url);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onSaved?.(validation.url);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <div>
        <label htmlFor="server-url" className="mb-1.5 block text-xs font-medium text-muted-foreground">
          服务器地址
        </label>
        <Input
          id="server-url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
            setTestResult(null);
          }}
          placeholder="https://aster.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          className="font-mono text-sm"
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          远程服务器必须使用 <code className="font-mono">https://</code>；本机开发可用{" "}
          <code className="font-mono">http://localhost:8787</code>。只填协议、域名和端口。
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{error}</p>
      )}

      {testResult && (
        <div
          className={
            testResult.ok
              ? "flex items-start gap-2 rounded-md bg-success/10 px-2.5 py-2 text-xs text-success"
              : "flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          }
        >
          {testResult.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>
            {testResult.ok
              ? `连接成功 · 服务版本 ${testResult.version} · ${testResult.latencyMs} ms`
              : `连接失败：${testResult.message}`}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => void runTest()} disabled={testing || saving}>
          {testing ? <Spinner /> : <PlugZap className="size-3.5" />}
          测试连接
        </Button>
        <Button type="submit" className="flex-1" disabled={saving || testing || url.trim() === ""}>
          {saving ? <Spinner /> : null}
          {saving ? "保存中…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
