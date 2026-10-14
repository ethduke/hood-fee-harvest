"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Wallet,
  History,
  Check,
  ShieldCheck,
  ChevronDown,
  Pause,
  X,
  RefreshCw,
  Radar,
} from "lucide-react";
import { ClaimController } from "../lib/wallet/claims.mjs";
import { claimKey } from "../lib/fees/claim-plan.mjs";
import { WalletAdapter } from "../lib/wallet/adapter.mjs";
import { SOURCE_INFO } from "../lib/fees/catalog.mjs";
import { compactAmount, mergeRows, totals } from "../lib/fees/model.mjs";
type WalletOption = { id: string; name: string; rabby: boolean; provider: { request: (input: { method: string }) => Promise<unknown> } };
type WalletEvent =
  | { type: "providers"; options: WalletOption[] }
  | { type: "connecting"; name: string }
  | { type: "connected"; address: string; name: string; switched: boolean }
  | { type: "disconnected" }
  | { type: "error"; code: string };
const walletErrors: Record<string, string> = {
  rejected: "Connection cancelled. Connect again when you’re ready.",
  pending: "A wallet request is already open. Approve or dismiss it in your wallet, then try again.",
  unavailable: "The wallet could not connect. Unlock it and try again.",
  invalid_account: "The wallet returned an invalid account. Choose another account and reconnect.",
};
type FeeRow = {
  id: string;
  source: string;
  target: string;
  currency: string;
  symbol: string;
  decimals: number;
  metadataVerified: boolean;
  raw: string;
  kind?: string;
  token?: string;
  tx?: string;
  block?: number;
  destination?: string;
  earmarkedRaw?: string;
  position?: string;
  claimHandle?: string;
};
type ClaimState = {
  phase: string; error?: string; row?: FeeRow; owner?: string; hash?: string; confirmations?: number;
  quote?: { target: string; address: string; payouts: FeeRow[]; expiresAt: number; gas: string };
};
const claimErrors: Record<string, string> = {
  rejected: "Request cancelled in your wallet. No new claim was approved.",
  nothing_to_claim: "These fees are no longer available. Refresh your balances.",
  wrong_account: "The connected account changed. Reconnect the fee owner and try again.",
  wrong_chain: "Choose Robinhood Chain in your wallet, then try again.",
  contract_changed: "This contract no longer matches its reviewed code. The claim was blocked.",
  cursor_expired: "This fee record expired. Refresh balances before claiming.",
  quote_expired: "The claim review expired. Click Claim again to prepare fresh amounts.",
  gas_limit: "This claim needs more gas than the supported limit. Use the launchpad to review it.",
  read_failed: "The claim or its confirmation could not be verified. Check wallet activity before retrying.",
  provider_unavailable: "The chain provider is unavailable. Try again shortly.",
  rate_limited: "The provider is busy. Confirmation checks retry automatically; preparation can be retried shortly.",
  invalid_response: "The claim response could not be verified.",
  confirmation_pending: "Confirmation is taking longer than expected. Check again; do not submit a duplicate claim.",
};
type Result = {
  snapshotCursor: string;
  source: string;
  snapshot: { number: number; hash: string; timestamp: number };
  balances: FeeRow[];
  history: FeeRow[];
  warnings: string[];
  coverage: { complete: boolean; percent: number; pending: number };
  cursor: string | null;
};
type SourceState = {
  result?: Result;
  balances: FeeRow[];
  history: FeeRow[];
  error?: string;
  pages: number;
};
const errors: Record<string, string> = {
  invalid_address: "Enter a valid Ethereum wallet address.",
  provider_unavailable:
    "The chain provider is unavailable. Your scan progress is kept; try again shortly.",
  rate_limited: "The provider is busy. Wait a moment, then continue your scan.",
  cursor_expired: "This scan expired or the service restarted. Refresh to start a new snapshot.",
  snapshot_changed: "The chain changed beneath this snapshot. Refresh to scan again.",
  contract_changed:
    "A contract no longer matches its reviewed deployment. This source is unavailable.",
  read_failed: "A contract read could not be verified. This source is unknown; try again.",
  wrong_chain: "The provider returned a different network. This source is unavailable.",
  invalid_response: "The provider returned data that could not be verified.",
  log_range:
    "The provider cannot read this historical range. Try a provider with historical log support.",
  response_limit: "This historical page exceeds the provider limit.",
  position_limit: "This wallet exceeds the current scan capacity. The result remains incomplete.",
  page_limit: "This page exceeded its read budget. Continue to retry.",
};
const warningText: Record<string, string> = {
  migrated_pool: "Migrated Doppler pools are outside this adapter’s coverage.",
  other_doppler_route: "Other integrations on the shared manager were excluded.",
  archive_required:
    "Some pons v1 payout recipients could not be verified historically. History is incomplete; an archive RPC is needed.",
  v1_preview_unavailable: "A pons v1 fee preview failed. Its balance is unknown, not zero.",
  buyback_earmark:
    "pons has fees earmarked for buybacks. A skipped buyback can increase the eventual creator payout.",
};
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
function exact(row: FeeRow) {
  return row.metadataVerified
    ? `${compactAmount(row.raw, row.decimals)} ${row.symbol}`
    : `${row.raw} raw units`;
}
const explorer = (type: string, address: string) =>
  `https://robinhoodchain.blockscout.com/${type}/${address}`;
function ChainGlyph() {
  return (
    <span className="chain-glyph">
      <span />
      <span />
    </span>
  );
}
function Brand() {
  return (
    <span className="brand-mark">
      h<span>↗</span>
    </span>
  );
}
function Amount({ row }: { row: FeeRow }) {
  return (
    <span title={`${row.raw} raw units · ${row.currency}`} className="amount">
      {exact(row)}
    </span>
  );
}
export default function Home() {
  const [wallet, setWallet] = useState("");
  const [claimState, setClaimState] = useState<ClaimState>({ phase: "idle" });
  const claims = useRef<ClaimController | null>(null);
  const [walletName, setWalletName] = useState("");
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);
  const [walletMenu, setWalletMenu] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState("Connect your wallet to start an automatic fee scan.");
  const [selected, setSelected] = useState(new Set(SOURCE_INFO.map((s) => s.id))),
    [states, setStates] = useState<Record<string, SourceState>>({});
  const [activeTab, setActiveTab] = useState("unclaimed"),
    [running, setRunning] = useState(false),
    [info, setInfo] = useState(false),
    [showZero, setShowZero] = useState(false),
    [filter, setFilter] = useState("all"),
    [notice, setNotice] = useState("");
  const active = useRef(false),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    latest = useRef(states);
  const connectRef = useRef<HTMLButtonElement>(null);
  const adapter = useRef<WalletAdapter | null>(null);
  const selectedRef = useRef(selected);
  function cancelWork() {
    active.current = false;
    generation.current++;
    controller.current?.abort();
  }
  function stop() {
    cancelWork();
    setRunning(false);
  }
  useEffect(() => {
    const claimController = new ClaimController({
      getSession: () => adapter.current?.session,
      notify: (state: ClaimState) => setClaimState(state),
      refresh: (confirmation: { history: FeeRow[]; snapshotCursor: string }, address: string) => {
        stop();
        const seeded: Record<string, SourceState> = {};
        for (const row of confirmation.history) {
          const source = seeded[row.source] ?? { balances: [], history: [], pages: 0 };
          source.history.push(row);
          seeded[row.source] = source;
        }
        publish(seeded);
        void run(address, false, Number.POSITIVE_INFINITY, confirmation.snapshotCursor);
      },
    });
    claims.current = claimController;
    const connection = new WalletAdapter(window, (event: WalletEvent) => {
      if (event.type === "providers") { setWalletOptions(event.options); return; }
      claimController.contextChanged();
      if (event.type === "connecting") {
        stop();
        publish({});
        setWallet("");
        setWalletName(event.name);
        setConnecting(true);
        setConnectionNotice(`Approve the connection in ${event.name}. Your fee scan will start automatically.`);
      } else if (event.type === "connected") {
        stop();
        publish({});
        setWallet(event.address);
        setWalletName(event.name);
        setConnecting(false);
        setWalletMenu(false);
        setFilter("all");
        setConnectionNotice(`${event.switched ? "Account changed" : `${event.name} connected`}. Your selected sources are checked automatically.`);
        if (selectedRef.current.size) void run(event.address, true);
        else setNotice("Choose at least one scan source to start checking fees.");
      } else {
        stop();
        publish({});
        setWallet("");
        setWalletName("");
        setConnecting(false);
        setNotice("");
        setConnectionNotice(event.type === "error" ? walletErrors[event.code] ?? walletErrors.unavailable : "Wallet disconnected. Scanning stopped and results cleared.");
      }
    });
    adapter.current = connection;
    connection.start();
    return () => {
      claimController.dispose();
      claims.current = null;
      connection.dispose();
      adapter.current = null;
      cancelWork();
    };
    // Wallet events use current scan state and source selections through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function connectDefault() {
    adapter.current?.discoverLegacy();
    const preferred = adapter.current?.options.find((option) => option.rabby);
    if (preferred) void adapter.current?.connect(preferred);
    else setWalletMenu(true);
  }
  function publish(next: Record<string, SourceState>) {
    latest.current = next;
    setStates(next);
  }
  async function run(address: string, fresh = false, budget = Number.POSITIVE_INFINITY, anchor?: string) {
    stop();
    const token = generation.current;
    active.current = true;
    setRunning(true);
    setNotice("");
    let current: Record<string, SourceState> = fresh ? {} : { ...latest.current };
    if (fresh) publish(current);
    const ids = SOURCE_INFO.filter((s) => selectedRef.current.has(s.id)).map((s) => s.id);
    let page = 0;
    try {
      while (active.current && token === generation.current && page < budget) {
        let didWork = false;
        for (const id of ids) {
          if (!active.current || token !== generation.current) break;
          const existing = current[id];
          if (existing?.result?.coverage.complete || existing?.error) continue;
          didWork = true;
          setNotice(`Checking ${SOURCE_INFO.find((source) => source.id === id)?.name}: available fees and claimed history. Results appear as they are verified.`);
          controller.current = new AbortController();
          try {
            const response = await fetch("/api/scan", {
              method: "POST",
              headers: { "content-type": "application/json", "x-hood-intent": "scan" },
              body: JSON.stringify({
                address,
                source: id,
                ...(existing?.result?.cursor ? { cursor: existing.result.cursor } : {}),
                ...(!existing?.result?.cursor && (anchor || Object.values(current).some((state) => state.result))
                  ? { snapshotCursor: anchor || Object.values(current).find((state) => state.result)!.result!.snapshotCursor }
                  : {}),
              }),
              signal: controller.current.signal,
              cache: "no-store",
            });
            const data = (await response.json()) as Result & { error: string };
            if (token !== generation.current || !active.current) break;
            if (!response.ok) {
              current = {
                ...current,
                [id]: {
                  ...existing,
                  balances: existing?.balances ?? [],
                  history: existing?.history ?? [],
                  pages: existing?.pages ?? 0,
                  error: errors[data.error] ?? errors.provider_unavailable,
                },
              };
              publish(current);
              continue;
            }
            const result = data as Result;
            current = {
              ...current,
              [id]: {
                result,
                balances: mergeRows([
                  ...(existing?.balances ?? []),
                  ...result.balances,
                ]) as FeeRow[],
                history: mergeRows([...(existing?.history ?? []), ...result.history]) as FeeRow[],
                pages: (existing?.pages ?? 0) + 1,
              },
            };
            publish(current);
          } catch {
            if (token !== generation.current || !active.current) break;
            current = {
              ...current,
              [id]: {
                ...existing,
                balances: existing?.balances ?? [],
                history: existing?.history ?? [],
                pages: existing?.pages ?? 0,
                error: errors.provider_unavailable,
              },
            };
            publish(current);
          }
        }
        if (!didWork) break;
        page++;
        if (active.current && page < budget)
          await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (active.current && token === generation.current) {
        const failed = ids.some((id) => current[id]?.error);
        const finished = ids.length > 0 && ids.every((id) => current[id]?.result?.coverage.complete && !current[id]?.error);
        setNotice(failed
          ? "Some sources could not be read. Verified results are kept; unread fees remain unknown. Continue to retry."
          : finished
            ? "Scan complete for the selected contracts. Your available fees and claimed history are ready."
            : "This scan pass is finished. Continue to discover older positions and payouts.");
      }
    } finally {
      if (token === generation.current) {
        active.current = false;
        setRunning(false);
      }
    }
  }
  function continueScan() {
    const cleaned = Object.fromEntries(
      Object.entries(latest.current).map(([id, state]) => [id, { ...state, error: undefined }]),
    );
    publish(cleaned);
    void run(wallet, false);
  }
  function toggleSource(id: string) {
    if (running) return;
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedRef.current = next;
    setSelected(next);
    if (wallet && next.size) void run(wallet);
    else if (wallet) { stop(); setNotice("Choose at least one scan source to start checking fees."); }
  }
  const claimBusy = ["preparing", "review", "wallet", "submitted", "confirming", "uncertain"].includes(claimState.phase);
  function beginClaim(row: FeeRow) {
    if (claimBusy) return;
    stop();
    setNotice("Scan paused while your claim is prepared. Review the transaction in your wallet.");
    void claims.current?.begin(row);
  }
  const included = SOURCE_INFO.filter((s) => selected.has(s.id));
  const allBalances = included.flatMap((s) => states[s.id]?.balances ?? []);
  const available = allBalances.filter((r) => r.kind === "available" && BigInt(r.raw) > 0n);
  const pending = allBalances.filter((r) => r.kind !== "available" && BigInt(r.raw) > 0n);
  const claimed = included
    .flatMap((s) => states[s.id]?.history ?? [])
    .sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  const complete =
    wallet && included.length > 0 &&
    included.every((s) => states[s.id]?.result?.coverage.complete && !states[s.id]?.error);
  const historyIncomplete = included.some((s) =>
    states[s.id]?.result?.warnings.includes("archive_required"),
  );
  const found = totals(available) as FeeRow[],
    paid = totals(claimed) as FeeRow[];
  const pct = included.length
    ? included.reduce((n, s) => n + (states[s.id]?.result?.coverage.percent ?? 0), 0) /
      included.length
    : 0;
  const snapshots = included.flatMap((s) =>
    states[s.id]?.result ? [states[s.id].result!.snapshot] : [],
  );
  const snapshotsMatch =
    snapshots.length > 0 && snapshots.every((s) => s.hash === snapshots[0].hash);
  // Each source has a confirmed frozen snapshot. Cross-source aggregate amounts
  // are only shown when the snapshots coincide; otherwise show separate assets.
  const rows = (
    activeTab === "history" ? claimed : allBalances.filter((r) => showZero || BigInt(r.raw) > 0n)
  ).filter((r) => filter === "all" || r.source === filter);
  return (
    <div className="app-shell">
      <div className="main-shell">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Hood Fee Harvest home">
            <Brand /><span>hood<span className="brand-sub">FEE HARVEST</span></span>
          </Link>
          <nav className="top-nav" aria-label="Main navigation">
            <a href="#harvest" className="nav-link active">Dashboard</a>
            <button className="nav-link" onClick={() => setInfo(true)}>Coverage <ArrowUpRight size={13} /></button>
          </nav>
          <div className="topbar-right">
            <div className="wallet-control">
              <button ref={connectRef} className="wallet-connect" disabled={connecting}
                onClick={() => wallet ? setWalletMenu(true) : connectDefault()}>
                {connecting ? <span className="spinner" /> : <Wallet size={16} />}
                <span>{connecting ? "Connecting…" : wallet ? `${walletName} · ${short(wallet)}` : "Connect Rabby"}</span>
              </button>
              <button className="wallet-choose" aria-label="Choose wallet or disconnect" onClick={() => setWalletMenu(true)}>
                <ChevronDown size={14} />
              </button>
            </div>
          </div>
        </header>
        <main>
          <section className="page-heading" aria-labelledby="hero-title">
            <div className="hero-copy">
              <span className="eyebrow"><span className="green-dot" /> MADE FOR ROBINHOOD CHAIN</span>
              <h1 id="hero-title">Leave no<br /><span>fees</span> behind<span className="hero-period">.</span></h1>
              <p>Your launchpad fees, finally in one place.<br />Find what’s unclaimed. Keep track of what’s paid.</p>
              <div className="hero-steps"><span><b>01</b> Connect</span><ArrowRight size={15} /><span><b>02</b> Discover</span><ArrowRight size={15} /><span><b>03</b> Harvest</span></div>
            </div>
            <div className="harvest-art" aria-hidden="true">
              <div className="art-heading"><span>THE HARVEST ROUTE</span><ArrowUpRight size={20} /></div>
              <div className="art-route">
                <div className="art-sources"><span>o1</span><span>long</span><span>pons</span></div>
                <svg className="route-lines" viewBox="0 0 300 160" fill="none"><path d="M0 26H60Q100 26 110 56L120 80H260M0 80H260M0 134H60Q100 134 110 104L120 80" stroke="currentColor" strokeWidth="1.5" /><path d="m245 65 15 15-15 15" stroke="currentColor" strokeWidth="1.5" /><circle cx="120" cy="80" r="5" fill="currentColor" /></svg>
                <span className="art-wallet"><Wallet size={32} strokeWidth={1.4} /></span>
              </div>
              <div className="art-caption"><strong>Different launchpads.<br /><em>One clear view.</em></strong><span>READ<br />REVIEW<br />CLAIM</span></div>
              <div className="art-footer"><span className="green-dot" /> REVIEWED CONTRACTS <span>4663 ↗</span></div>
            </div>
          </section>
          <div className="section-heading" id="harvest"><span className="eyebrow">01 / YOUR HARVEST</span><span className="network-tag"><ChainGlyph /> Robinhood Chain <span>Mainnet</span></span></div>
          <div className="dashboard-grid">
          <section className="lookup-panel" aria-label="Scan sources">
            <div className="panel-heading"><span>YOUR SCAN</span><Radar size={18} /></div>

            <div className="connection-status" role="status" aria-live="polite" aria-atomic="true">
              <ShieldCheck size={16} />
              <div><strong>{connectionNotice}</strong><p>Connect once. We’ll check your selected sources in the background.</p></div>
            </div>
            <div className="source-selector">
              <span>SCAN SOURCES</span>
              <div>
                {SOURCE_INFO.map((source) => (
                  <button
                    key={source.id}
                    className={`source-chip ${selected.has(source.id) ? "selected" : ""}`}
                    aria-pressed={selected.has(source.id)}
                    disabled={running || claimBusy}
                    onClick={() => toggleSource(source.id)}
                  >
                    <span className={`pad-mark ${source.id}`}>{source.mark}</span>
                    {source.name}
                    {selected.has(source.id) && <Check size={12} />}
                  </button>
                ))}
              </div>
              <button className="text-button coverage-link" onClick={() => setInfo(true)}>
                What’s covered
                <ArrowUpRight size={13} />
              </button>
            </div>
          </section>
          <section className="summary-grid" aria-label="Wallet summary">
            <Summary
              label="AVAILABLE FEES"
              values={found}
              wallet={wallet}
              helper={
                !wallet
                  ? "Your claimable balances will appear here"
                  : snapshotsMatch
                    ? "Located in reviewed contracts"
                    : "Per-source confirmed snapshots"
              }
              icon={<Wallet size={17} />}
            />
            <Summary
              label="CLAIMED TO DATE"
              values={paid}
              wallet={wallet}
              helper={
                !wallet
                  ? "Confirmed payout history"
                  : complete && !historyIncomplete
                    ? "Verified history across scanned contracts"
                    : "Verified payouts found so far"
              }
              icon={<History size={17} />}
            />
            <div className="summary-card">
              <span className="summary-label">
                SCAN COVERAGE
                <Radar size={17} />
              </span>
              <div className="summary-value">
                {wallet ? (
                  <>{complete ? "Complete" : pct < 0.01 ? "Started" : `${pct.toFixed(1)}%`}</>
                ) : (
                  <span className="muted-number">—</span>
                )}
              </div>
              <p>
                {wallet
                  ? `${included.length} source groups · ${included.reduce((n, s) => n + (states[s.id]?.pages ?? 0), 0)} pages checked`
                  : "Connect your wallet to start scanning"}
              </p>
              <div className="mini-progress">
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
          </section>
          </div>
          {wallet && (
            <section className="scan-strip" aria-live="polite">
              <div>
                <span className={running ? "pulse-dot" : "green-dot"} />
                <strong>
                  {running
                    ? "Scanning in the background…"
                    : complete
                      ? "Covered contracts scanned"
                      : !included.length ? "Choose scan sources" : "Scan paused or needs attention"}
                </strong>
                <p>
                  {notice ||
                    "Balances and payouts use confirmed snapshots. An unfinished scan never means there are no fees."}
                  {` ${available.length} available fee positions · ${claimed.length} verified payouts found.`}
                </p>
              </div>
              <div className="scan-actions">
                {running ? (
                  <button className="secondary-button" onClick={() => { stop(); setNotice("Scan paused. Your verified results are kept. Continue whenever you are ready."); }}>
                    <Pause size={14} />
                    Pause
                  </button>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      title="Refresh all selected sources"
                      aria-label="Refresh all selected sources"
                      disabled={!included.length || claimBusy}
                      onClick={() => void run(wallet, true)}
                    >
                      <RefreshCw size={16} />
                    </button>
                    {!complete && included.length > 0 && (
                      <button className="secondary-button" disabled={claimBusy} onClick={continueScan}>
                        Continue scan
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
          {claimState.phase !== "idle" && (claimState.owner === wallet || claimBusy) && (
            <section className="claim-status" role="status" aria-live="polite" aria-atomic="true">
              <strong>{claimBusy && claimState.owner && claimState.owner !== wallet
                ? "A claim for the previous account is still being tracked."
                : claimState.phase === "preparing" ? "Checking your claim…"
                : claimState.phase === "review" ? "Your claim is ready to review."
                : claimState.phase === "wallet" ? `Confirm the transaction in ${walletName || "your wallet"}.`
                : claimState.phase === "submitted" ? "Claim submitted. Waiting for it to be mined."
                : claimState.phase === "confirming" ? `Claim mined. Confirming onchain · ${claimState.confirmations ?? 0}/20 blocks.`
                : claimState.phase === "confirmed" ? running ? "Claim confirmed. Refreshing your balances and payout history." : complete ? "Claim confirmed. Balances and payout history refreshed." : "Claim confirmed. Your payout is recorded; check the scan status for remaining reads."
                : claimState.phase === "reverted" ? "The claim reverted. No fee payout was made; network gas may have been spent."
                : claimState.phase === "no_payout" ? "Transaction confirmed; a fee payout could not be verified. Refreshing your results."
                : claimState.phase === "uncertain" ? "The wallet may have submitted this claim. Check wallet activity before trying again."
                : "Claim needs attention."}</strong>
              {claimState.error && claimState.phase !== "uncertain" && <p>{claimErrors[claimState.error] ?? "The claim could not be verified. Check your wallet before retrying."}</p>}
              {claimState.hash && <a href={explorer("tx", claimState.hash)} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={13} /></a>}
              {claimState.error === "confirmation_pending" && <button className="secondary-button" onClick={() => void claims.current?.watch()}>Check confirmation</button>}
            </section>
          )}
          <div className="section-heading results-title"><div><span className="eyebrow">02 / THE DETAILS</span><h2>Every fee. Accounted for.</h2></div><button className="text-button" onClick={() => setInfo(true)}>How it works <ArrowUpRight size={15} /></button></div>
          <section className="results-panel" aria-label="Fee balances and payout history">
            <div className="results-header">
              <div className="tabs" role="tablist" aria-label="Fee results">
                <button
                  role="tab"
                  aria-selected={activeTab === "unclaimed"}
                  className={activeTab === "unclaimed" ? "active" : ""}
                  onClick={() => setActiveTab("unclaimed")}
                >
                  Unclaimed fees<span>{available.length + pending.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "history"}
                  className={activeTab === "history" ? "active" : ""}
                  onClick={() => setActiveTab("history")}
                >
                  Payout history<span>{claimed.length}</span>
                </button>
              </div>
              <div className="table-controls">
                {activeTab === "unclaimed" && wallet && (
                  <label className="zero-toggle">
                    <input
                      type="checkbox"
                      checked={showZero}
                      onChange={(e) => setShowZero(e.target.checked)}
                    />
                    Show zero
                  </label>
                )}
                <label className="filter-select">
                  <select
                    aria-label="Filter by launchpad"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All launchpads</option>
                    {included.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </label>
              </div>
            </div>
            {rows.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>LAUNCHPAD</th>
                      <th>ASSET</th>
                      <th>{activeTab === "history" ? "PAID OUT" : "AMOUNT"}</th>
                      <th>{activeTab === "history" ? "CONFIRMED AT" : "STATUS"}</th>
                      <th>{activeTab === "history" ? "TRANSACTION" : "POSITION"}</th>
                      {activeTab !== "history" && <th>CLAIM</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="pad-cell">
                            <span className={`pad-mark ${row.source}`}>
                              {SOURCE_INFO.find((s) => s.id === row.source)?.mark}
                            </span>
                            <span>
                              {SOURCE_INFO.find((s) => s.id === row.source)?.name}
                              <small>{row.target}</small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <a
                            className="asset-cell"
                            href={explorer("address", row.currency)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{row.symbol}</strong>
                            <small>{short(row.currency)}</small>
                          </a>
                        </td>
                        <td>
                          <Amount row={row} />
                        </td>
                        <td>
                          {activeTab === "history" ? (
                            <a
                              className="block-link"
                              href={explorer("block", String(row.block))}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Block {row.block?.toLocaleString()}
                            </a>
                          ) : (
                            <span
                              className={`status-pill ${row.kind === "available" ? "available" : "pending"}`}
                            >
                              {row.kind === "available"
                                ? "Available"
                                : row.kind === "conversion-needed"
                                  ? "Needs conversion"
                                  : "Unswept estimate"}
                            </span>
                          )}
                        </td>
                        <td>
                          {row.tx ? (
                            <a
                              className="explorer-link"
                              href={explorer("tx", row.tx)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(row.tx)}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : row.token ? (
                            <a
                              className="explorer-link"
                              href={explorer("address", row.token)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(row.token)}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : (
                            <span className="table-muted">Shared escrow</span>
                          )}
                        </td>
                        {activeTab !== "history" && <td>
                          {row.kind === "available" && BigInt(row.raw) > 0n ? (
                            <button className="claim-button" disabled={claimBusy || !row.claimHandle}
                              title={!row.claimHandle ? "Refresh this fee before claiming" : "Review and claim with your connected wallet"}
                              onClick={() => beginClaim(row)}>
                              {claimBusy && claimState.row && claimKey(claimState.row) === claimKey(row) ? "In progress…" : "Claim"}
                              <ArrowUpRight size={13} />
                            </button>
                          ) : <span className="table-muted">{row.kind !== "available" ? "Not yet claimable" : "—"}</span>}
                        </td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden="true">
                  {activeTab === "history" ? <History size={27} /> : <Wallet size={27} />}
                  <span>
                    <Search size={12} />
                  </span>
                </div>
                <h2>
                  {!wallet
                    ? "Your fees are out there."
                    : running
                      ? "Looking for your fees…"
                      : complete && !historyIncomplete
                        ? activeTab === "history" ? "No payout history found" : "No unclaimed fees found"
                        : "Nothing found in the pages scanned yet"}
                </h2>
                <p>
                  {!wallet
                    ? "Connect your wallet to discover unclaimed fees\nand see your verified payout history."
                    : complete && !historyIncomplete
                      ? activeTab === "history" ? "No matching payouts in the covered contracts. Check coverage for excluded routes." : "No positive balances found in the covered contracts. Confirmed claims appear in Payout history."
                      : "Keep scanning to discover older positions. Unread pages and failed reads remain unknown."}
                </p>
                {!wallet && (
                  <button className="primary-button" onClick={connectDefault} disabled={connecting}>
                    Connect Rabby
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            )}
            <div className="results-footer">
              <span>
                <ShieldCheck size={13} />
                Read-only scans · Wallet-approved claims
              </span>
              <span>
                {wallet
                  ? `${available.length} available · ${pending.length} unswept positions`
                  : "Ready when you are"}
              </span>
            </div>
          </section>
          <div className="source-health">
            {included.map((source) => {
              const state = states[source.id];
              return (
                <div key={source.id}>
                  <span className={`pad-mark ${source.id}`}>{source.mark}</span>
                  <div>
                    <strong>{source.name}</strong>
                    <small>
                      {state?.error
                        ? "Read unavailable"
                        : state?.result?.coverage.complete
                          ? "Covered history scanned"
                          : state?.result
                            ? `${state.result.coverage.percent.toFixed(2)}% of history checked`
                            : "Ready to scan"}
                    </small>
                  </div>
                  <span className={`health-dot ${state?.error ? "error" : ""}`} />
                </div>
              );
            })}
          </div>
          {included.map((source) => {
            const state = states[source.id];
            return (
              <div key={source.id} className="source-notes">
                {state?.error && (
                  <p className="source-error" role="alert">
                    <strong>{source.name}:</strong> {state.error}
                  </p>
                )}
                {state?.result?.warnings.map((w) => (
                  <p key={w}>
                    {warningText[w] ??
                      "This source has additional fees outside the current adapter’s coverage."}
                  </p>
                ))}
              </div>
            );
          })}
          <footer className="page-footer">
            <div><span className="footer-brand">hood ↗</span><span>Find it. Claim it. Carry on.</span></div>
            <div><a href="https://github.com/ethduke/hood-fee-harvest" target="_blank" rel="noreferrer">View source <ArrowUpRight size={14} /></a><button className="text-button" onClick={() => setInfo(true)}>Coverage & privacy <ArrowUpRight size={14} /></button></div>
            <small>Independent tool. No Robinhood or launchpad affiliation.</small>
          </footer>
        </main>
      </div>
      {claimState.phase === "review" && claimState.quote && (
        <WalletDialog titleId="claim-title" closeLabel="Cancel claim review" onClose={() => claims.current?.cancel()}>
          <span className="eyebrow">REVIEW YOUR CLAIM</span>
          <h2 id="claim-title">Claim your fees.</h2>
          <p>{claimState.quote.payouts.length > 1 ? "This transaction collects both assets for this position." : "This transaction claims fees to your connected account."}</p>
          <div className="claim-payouts">{claimState.quote.payouts.filter((row) => BigInt(row.raw) > 0n).map((row) => <div key={row.currency}><Amount row={row} /><small>{short(row.currency)}</small></div>)}</div>
          <p>Recipient: <span className="mono">{short(claimState.quote.address)}</span><br />Network: Robinhood Chain</p>
          <a className="text-button" href={explorer("address", claimState.quote.target)} target="_blank" rel="noreferrer">View claim contract <ArrowUpRight size={13} /></a>
          <p>The claim was simulated. Amounts can change before mining. You pay network gas in ETH; your wallet shows the final gas fee. No token approval is requested.</p>
          <button className="primary-button" onClick={() => void claims.current?.send()}>Confirm in {walletName || "wallet"}<ArrowUpRight size={15} /></button>
        </WalletDialog>
      )}
      {walletMenu && (
        <WalletDialog onClose={() => { if (connecting) adapter.current?.disconnect(); setWalletMenu(false); }}>

            <span className="eyebrow">YOUR WALLET</span>
            <h2 id="wallet-title">Connect to find your fees.</h2>
            <p>Rabby is the default. Choose an installed wallet to share your account address and start scanning automatically.</p>
            {!walletOptions.some((option) => option.rabby) && <a className="wallet-option" href="https://rabby.io/" target="_blank" rel="noreferrer"><Wallet size={20} /><span>Get Rabby<small>Install the wallet, then reload this page.</small></span><ArrowUpRight size={16} /></a>}
            {walletOptions.map((option) => <button key={option.id} className="wallet-option" disabled={connecting} onClick={() => void adapter.current?.connect(option)}><Wallet size={20} /><span>{option.name}<small>{option.rabby ? "Default wallet" : "Detected in your browser"}</small></span><ArrowRight size={16} /></button>)}
            {!walletOptions.length && <p>No browser wallet detected. Open this site in your wallet’s browser or install Rabby.</p>}
            {connecting && <p role="status">Approve the connection in {walletName}, or cancel below.</p>}
            {(wallet || connecting) && <button className="secondary-button" onClick={() => { adapter.current?.disconnect(); setWalletMenu(false); }}>{connecting ? "Cancel connection" : "Disconnect wallet"}</button>}
            <p className="wallet-readonly"><ShieldCheck size={14} />Connection shares your address. Each claim requires wallet confirmation.</p>
        </WalletDialog>
      )}
      {info && (
        <WalletDialog titleId="coverage-title" closeLabel="Close coverage details" className="coverage-modal" onClose={() => setInfo(false)}>
            <span className="eyebrow">KNOW WHAT’S COVERED</span>
            <h2 id="coverage-title">A clear view of your fees.</h2>
            <p>
              The first release reuses fungun’s reviewed accounting. Sources are checked against
              pinned deployed bytecode on Robinhood Chain.
            </p>
            {SOURCE_INFO.map((s) => (
              <article key={s.id}>
                <span className={`pad-mark ${s.id}`}>{s.mark}</span>
                <div>
                  <h3>{s.name}</h3>
                  <p>{s.description}</p>
                  <small>{s.note}</small>
                </div>
              </article>
            ))}
            <div className="coverage-footnotes">
              <p>
                <strong>Scan to completion.</strong> The app pages through logs from deployment to a
                fixed block with 20 confirmations. Partial scans show only what has been found so
                far.
              </p>
              <p>
                <strong>Available and unswept are separate.</strong> Pending pons fees may need
                collection or conversion. Buyback earmarks can change the final payout. Asset totals
                are never converted into a pretend combined currency.
              </p>
              <p>
                <strong>Your query isn’t saved.</strong> No wallet address in URLs, browser storage,
                application logs, analytics or a database. Queries are sent to the chain provider.
                Hosting logs depend on the operator’s settings.
              </p>
              <p>
                <strong>More adapters come later.</strong> Bags, Flap, pools.trade, PAIR and other
                verified platforms are not included in this first release. pons’ older unreviewed
                stacks, holder dividends and buyback vesting remain outside coverage.
              </p>
              <p>
                <strong>You approve every claim.</strong> Scanning only reads the chain. Claiming sends one transaction after you review it and approve it in your wallet. Pool claims collect both assets together. Unswept estimates cannot be claimed here.
              </p>
            </div>
            <button className="primary-button" onClick={() => setInfo(false)}>
              Back to dashboard
              <ArrowRight size={15} />
            </button>
        </WalletDialog>
      )}
    </div>
  );
}
function Summary({
  label,
  values,
  wallet,
  helper,
  icon,
}: {
  label: string;
  values: FeeRow[];
  wallet: string;
  helper: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="summary-card">
      <span className="summary-label">
        {label}
        {icon}
      </span>
      <div className="summary-value">
        {!wallet ? (
          <span className="muted-number">—</span>
        ) : !values.length ? (
          <span className="muted-number">None found</span>
        ) : (
          values.slice(0, 2).map((row) => <span key={row.currency}>{exact(row)}</span>)
        )}
        {values.length > 2 && <small>+{values.length - 2} other assets</small>}
      </div>
      <p>{helper}</p>
    </div>
  );
}

function WalletDialog({ children, onClose, titleId = "wallet-title", closeLabel = "Close wallet picker", className = "wallet-modal" }: { children: React.ReactNode; onClose: () => void; titleId?: string; closeLabel?: string; className?: string }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop" onClick={onClose}>
    <section ref={dialog} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <button className="icon-button modal-close" aria-label={closeLabel} onClick={onClose}><X size={18} /></button>
      {children}
    </section>
  </div>;
}
