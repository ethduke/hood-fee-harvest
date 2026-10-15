import { SOURCE_INFO, targets } from "../fees/catalog.mjs";
import { normalizeAddress, totals } from "../fees/model.mjs";

const prefix = "hood-fee-harvest:scan:4663:";
const maxSize = 2_000_000;
const sources = SOURCE_INFO.map((source) => source.id);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const address = (value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const text = (value, limit) => typeof value === "string" && value.length <= limit;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function rows(value, source) {
  return Array.isArray(value) && value.length <= 4096 && value.every((row) => record(row) &&
    text(row.id, 500) && row.source === source && targets[source].some((target) => target.id === row.target) &&
    address(row.currency) && /^\d{1,78}$/.test(row.raw) && typeof row.raw === "string" &&
    integer(row.decimals) && row.decimals <= 255 && text(row.symbol, 128) && typeof row.metadataVerified === "boolean" &&
    (row.kind === undefined || ["available", "unswept", "conversion-needed"].includes(row.kind)) &&
    (row.claimHandle === undefined || text(row.claimHandle, 85000)) &&
    (row.block === undefined || integer(row.block)) &&
    (row.tx === undefined || /^0x[\da-f]{64}$/i.test(row.tx)) &&
    (row.token === undefined || address(row.token)) &&
    (row.destination === undefined || address(row.destination)) &&
    (row.position === undefined || /^0x(?:[\da-f]{40}|[\da-f]{64})$/i.test(row.position)));
}
function states(value, scope) {
  return record(value) && Object.entries(value).every(([source, state]) => sources.includes(source) && record(state) &&
    integer(state.pages) && rows(state.balances, source) && rows(state.history, source) &&
    (state.error === undefined || text(state.error, 500)) &&
    (state.result === undefined || (record(state.result) && state.result.source === source &&
      state.result.scope === scope && record(state.result.snapshot) && integer(state.result.snapshot.number) &&
      /^0x[\da-f]{64}$/i.test(state.result.snapshot.hash) &&
      text(state.result.snapshotCursor, 85000) && (state.result.cursor === null || text(state.result.cursor, 85000)) &&
      record(state.result.coverage) && typeof state.result.coverage.complete === "boolean" &&
      Number.isFinite(state.result.coverage.percent) && state.result.coverage.percent >= 0 && state.result.coverage.percent <= 100 &&
      integer(state.result.coverage.pending) && Array.isArray(state.result.warnings) &&
      state.result.warnings.every((warning) => text(warning, 100)))));
}
// Storage is optional (private browsing and quota limits can deny access).
// Cached data is display/progress only; the server verifies cursors and every claim.
export class ScanCache {
  constructor(host) { this.host = host; }
  load(wallet) {
    try {
      const owner = normalizeAddress(wallet);
      const raw = this.host.localStorage.getItem(prefix + owner);
      if (!raw || raw.length > maxSize) return null;
      const value = JSON.parse(raw);
      if (!record(value) || value.version !== 1 || value.chainId !== 4663 || value.address !== owner ||
        !integer(value.savedAt) || !Array.isArray(value.selected) || value.selected.some((source) => !sources.includes(source)) ||
        typeof value.historyStarted !== "boolean" || !states(value.balances, "balances") || !states(value.history, "history")) return null;
      totals(Object.values(value.balances).flatMap((state) => state.balances.filter((row) => row.kind === "available")));
      totals(Object.values(value.history).flatMap((state) => state.history));
      return value;
    } catch { return null; }
  }
  save(wallet, progress) {
    try {
      const owner = normalizeAddress(wallet), savedAt = Date.now();
      const value = JSON.stringify({ ...progress, version: 1, chainId: 4663, address: owner, savedAt });
      if (value.length > maxSize) return null;
      this.host.localStorage.setItem(prefix + owner, value);
      return savedAt;
    } catch { return null; }
  }
  remove(wallet) {
    try { this.host.localStorage.removeItem(prefix + normalizeAddress(wallet)); return true; }
    catch { return false; }
  }
}
