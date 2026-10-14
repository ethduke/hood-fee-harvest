"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Wallet,
  Layers3,
  History,
  Check,
  ShieldCheck,
  ChevronDown,
  Pause,
  X,
  Code2,
  RefreshCw,
  CircleHelp,
  Radar,
} from "lucide-react";
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
    const connection = new WalletAdapter(window, (event: WalletEvent) => {
      if (event.type === "providers") { setWalletOptions(event.options); return; }
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
  async function run(address: string, fresh = false, budget = Number.POSITIVE_INFINITY) {
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
                ...(!existing?.result?.cursor && Object.values(current).some((s) => s.result)
                  ? {
                      snapshotCursor: Object.values(current).find((s) => s.result)!.result!
                        .snapshotCursor,
                    }
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
      <aside className="sidebar">
        <Link href="/" className="brand">
          <Brand />
          <span>
            hood<span className="brand-sub">fee harvest</span>
          </span>
        </Link>
        <span className="sidebar-label">WORKSPACE</span>
        <button
          className="nav-item active"
          onClick={() => {
            setInfo(false);
            connectRef.current?.focus();
          }}
        >
          <Layers3 size={18} />
          Fee dashboard
          <span className="nav-dot" />
        </button>
        <button className="nav-item" onClick={() => setInfo(true)}>
          <ShieldCheck size={18} />
          Coverage & sources
        </button>
        <div className="sidebar-tip">
          <Radar size={23} />
          <strong>Your fees. In plain sight.</strong>
          <p>One address. Reviewed contracts. A clear record of what’s owed and what’s paid.</p>
        </div>
        <div className="sidebar-bottom">
          <div className="network-status">
            <ChainGlyph />
            <span>
              Robinhood Chain<small>Mainnet · 4663</small>
            </span>
            <span className="green-dot" />
          </div>
          <a href="https://github.com/ethduke/hood-fee-harvest" target="_blank" rel="noreferrer">
            <Code2 size={15} />
            View source
            <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <span>/</span> <strong>Fee dashboard</strong>
          </span>
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
            <span className="read-only">
              <ShieldCheck size={13} />
              Read only
            </span>
            <button aria-label="How it works" className="icon-button" onClick={() => setInfo(true)}>
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                <span className="green-dot" />
                ROBINHOOD CHAIN FEE EXPLORER
              </span>
              <h1>
                Fees you earned.
                <br />
                <span>Still yours.</span>
              </h1>
              <p>
                Find unclaimed launchpad fees and follow every verified payout.
                <br className="desktop-break" /> Connect your wallet. Your fee scan starts automatically.
              </p>
            </div>
            <div className="hero-emblem" aria-hidden="true">
              <span className="orbit orbit-one" />
              <span className="orbit orbit-two" />
              <Brand />
              <span className="orbit-node node-one" />
              <span className="orbit-node node-two" />
              <span className="emblem-caption">ONCHAIN. ACCOUNTED FOR.</span>
            </div>
          </div>
          <section className="lookup-panel" aria-label="Scan sources">
            <div className="connection-status" role="status" aria-live="polite" aria-atomic="true">
              <ShieldCheck size={16} />
              <div><strong>{connectionNotice}</strong><p>Address access only. No signatures or transactions. Your address stays out of URLs and browser storage.</p></div>
            </div>
            <div className="source-selector">
              <span>SCAN SOURCES</span>
              <div>
                {SOURCE_INFO.map((source) => (
                  <button
                    key={source.id}
                    className={`source-chip ${selected.has(source.id) ? "selected" : ""}`}
                    aria-pressed={selected.has(source.id)}
                    disabled={running}
                    onClick={() => toggleSource(source.id)}
                  >
                    <span className={`pad-mark ${source.id}`}>{source.mark}</span>
                    {source.name}
                    {selected.has(source.id) && <Check size={12} />}
                  </button>
                ))}
              </div>
              <button className="text-button coverage-link" onClick={() => setInfo(true)}>
                View coverage
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
              label="ALREADY PAID"
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
                      disabled={!included.length}
                      onClick={() => void run(wallet, true)}
                    >
                      <RefreshCw size={16} />
                    </button>
                    {!complete && included.length > 0 && (
                      <button className="secondary-button" onClick={continueScan}>
                        Continue scan
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
          <section className="results-panel">
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  {activeTab === "history" ? <History size={27} /> : <Wallet size={27} />}
                  <span>
                    <Search size={12} />
                  </span>
                </div>
                <h2>
                  {!wallet
                    ? "Your next harvest starts here"
                    : running
                      ? "Looking for your fees…"
                      : complete && !historyIncomplete
                        ? "No matching payouts or balances found"
                        : "Nothing found in the pages scanned yet"}
                </h2>
                <p>
                  {!wallet
                    ? "Connect Rabby in the top-right corner. We’ll scan the selected sources\nand show available fees and onchain payout history as results arrive."
                    : complete && !historyIncomplete
                      ? "No matching results in the covered contracts. Check coverage for excluded routes."
                      : "Keep scanning to discover older positions. Unread pages and failed reads remain unknown."}
                </p>
                {!wallet && (
                  <button className="text-button" onClick={connectDefault} disabled={connecting}>
                    Connect wallet
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            )}
            <div className="results-footer">
              <span>
                <ShieldCheck size={13} />
                Verified contract events. Exact asset amounts. No signatures.
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
            <span>Built for the fees you might have forgotten.</span>
            <span>
              Independent tool · Robinhood Chain
              <small>No Robinhood or launchpad affiliation.</small>
            </span>
          </footer>
        </main>
      </div>
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
            <p className="wallet-readonly"><ShieldCheck size={14} />Address access only. No signatures or transactions.</p>
        </WalletDialog>
      )}
      {info && (
        <div className="modal-backdrop" onClick={() => setInfo(false)}>
          <section
            className="coverage-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="coverage-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              aria-label="Close coverage details"
              onClick={() => setInfo(false)}
            >
              <X size={18} />
            </button>
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
                <strong>Reads only.</strong> Claim fees through the source launchpad. Connecting shares your account
                address; no signature or transaction is requested here.
              </p>
            </div>
            <button className="primary-button" onClick={() => setInfo(false)}>
              Back to dashboard
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
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
          <span className="muted-number">Nothing found yet</span>
        ) : (
          values.slice(0, 2).map((row) => <span key={row.currency}>{exact(row)}</span>)
        )}
        {values.length > 2 && <small>+{values.length - 2} other assets</small>}
      </div>
      <p>{helper}</p>
    </div>
  );
}

function WalletDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop" onClick={onClose}>
    <section ref={dialog} className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title"
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <button className="icon-button modal-close" aria-label="Close wallet picker" onClick={onClose}><X size={18} /></button>
      {children}
    </section>
  </div>;
}
