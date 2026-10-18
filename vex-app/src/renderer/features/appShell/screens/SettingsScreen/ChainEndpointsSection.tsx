import { useEffect, useState, type JSX } from "react";
import { getChainEndpoints, setChainEndpoints } from "../../../../lib/api/chain-endpoints.js";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";

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
  const inputClass = "h-[42px] text-[15px]";
  const labelClass = "vex-ov-label flex flex-col gap-1";
  return <section aria-label="Chain endpoints" className="vex-set__sec vex-set__stack flex flex-col gap-4 border-t border-rule pt-5">
    <h3 className="vex-set__sh-title">Chain endpoints</h3>
    <p className="vex-set__note">Set your own endpoints per chain. Leave a field empty to use its default. Blockscout discovers tokens; RPC reads their balances.</p>
    <label className={labelClass}>Chain ID<Input className={inputClass} inputMode="numeric" disabled={busy} value={chainId} onChange={(event) => setChainId(event.target.value)} /></label>
    <label className={labelClass}>EVM RPC URL<Input className={inputClass} type="password" autoComplete="off" disabled={!loaded || busy} value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} /></label>
    <label className={labelClass}>Blockscout base URL<Input className={inputClass} type="password" autoComplete="off" disabled={!loaded || busy} value={blockscoutBaseUrl} onChange={(event) => setBlockscoutBaseUrl(event.target.value)} /></label>
    <p className="vex-set__note">Blockscout accepts HTTPS, or HTTP on loopback. URL credentials, query parameters and fragments are not supported. Reverse proxy path prefixes are supported.</p>
    <div><Button variant="quiet" disabled={!loaded || busy} onClick={() => { void save(); }}>Save endpoints</Button></div>
    {message ? <p role="status" className="text-[13px] leading-[19px] text-ink-secondary">{message}</p> : null}
  </section>;
}
