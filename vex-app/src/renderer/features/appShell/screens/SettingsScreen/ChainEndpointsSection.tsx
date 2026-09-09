import { useEffect, useState, type JSX } from "react";
import { getChainEndpoints, setChainEndpoints } from "../../../../lib/api/chain-endpoints.js";
import { Button } from "../../../../components/ui/button.js";

export function ChainEndpointsSection(): JSX.Element {
  const [chainId, setChainId] = useState("4663");
  const [rpcUrl, setRpcUrl] = useState("");
  const [blockscoutBaseUrl, setBlockscoutBaseUrl] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setMessage("");
    const id = Number(chainId);
    if (!Number.isSafeInteger(id) || id < 1) { setBusy(false); return; }
    setBusy(true);
    void getChainEndpoints(id).then((result) => {
      if (!active) return;
      if (result.ok) {
        setRpcUrl(result.data.rpcUrl ?? "");
        setBlockscoutBaseUrl(result.data.blockscoutBaseUrl ?? "");
        setLoaded(true);
      } else setMessage(result.error.message);
    }).catch(() => { if (active) setMessage("Unable to load chain endpoints. Reopen this section to retry."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [chainId]);
  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const result = await setChainEndpoints({ chainId: Number(chainId), rpcUrl: rpcUrl.trim() || null,
        blockscoutBaseUrl: blockscoutBaseUrl.trim() || null });
      setMessage(result.ok ? "Saved. The next chain read uses these endpoints." : result.error.message);
    } catch { setMessage("Unable to save chain endpoints. Try again."); }
    finally { setBusy(false); }
  };
  const inputClass = "mt-1 w-full rounded border border-line-2 bg-transparent px-3 py-2 text-ink-primary";
  return <section aria-label="Chain endpoints" className="flex flex-col gap-4">
    <h2 className="font-serif text-2xl text-ink-primary">Chain endpoints</h2>
    <p className="text-sm text-ink-secondary">Set your own endpoints per chain. Leave a field empty to use its default. Blockscout discovers tokens; RPC reads their balances.</p>
    <label>Chain ID<input className={inputClass} inputMode="numeric" disabled={busy} value={chainId} onChange={(event) => setChainId(event.target.value)} /></label>
    <label>EVM RPC URL<input className={inputClass} type="password" autoComplete="off" disabled={!loaded || busy} value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} /></label>
    <label>Blockscout base URL<input className={inputClass} type="password" autoComplete="off" disabled={!loaded || busy} value={blockscoutBaseUrl} onChange={(event) => setBlockscoutBaseUrl(event.target.value)} /></label>
    <p className="text-sm text-ink-secondary">Blockscout accepts HTTPS, or HTTP on loopback. URL credentials, query parameters and fragments are not supported. Reverse proxy path prefixes are supported.</p>
    <Button disabled={!loaded || busy} onClick={() => { void save(); }}>Save endpoints</Button>
    {message ? <p role="status" className="text-sm text-ink-secondary">{message}</p> : null}
  </section>;
}
