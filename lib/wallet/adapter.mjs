import { normalizeAddress } from "../fees/model.mjs";

// Discovery metadata is used only as text; wallet-supplied images are never rendered.
export class WalletAdapter {
  constructor(host, notify) {
    this.host = host;
    this.notify = notify;
    this.options = [];
    this.sequence = 0;
    this.epoch = 0;
    this.pending = false;
    this.session = null;
    this.unwatch = () => {};
    this.announce = (event) => {
      const detail = event?.detail;
      if (detail?.info && typeof detail.info.name === "string")
        this.add(detail.provider, detail.info.name, detail.info.rdns === "io.rabby", true);
    };
  }
  start() {
    this.host.addEventListener("eip6963:announceProvider", this.announce);
    this.host.dispatchEvent(new Event("eip6963:requestProvider"));
    this.discoverLegacy();
  }
  discoverLegacy() {
    const legacy = this.host.ethereum;
    for (const provider of [...(Array.isArray(legacy?.providers) ? legacy.providers : []), legacy])
      this.add(provider, provider?.isRabby ? "Rabby" : provider?.isMetaMask ? "MetaMask" : "Browser wallet", !!provider?.isRabby);
  }
  add(provider, name, rabby, discovered = false) {
    if (!provider || typeof provider.request !== "function") return;
    if (rabby && !discovered && this.options.some((option) => option.rabby && option.discovered)) return;
    if (rabby && discovered) this.options = this.options.filter((option) => !option.rabby || option.discovered || option.provider === provider);
    const existing = this.options.find((option) => option.provider === provider);
    if (existing) {
      existing.discovered ||= discovered;
      if (rabby) { existing.rabby = true; existing.name = "Rabby"; }
      else if (existing.name === "Browser wallet") existing.name = name.slice(0, 48);
    } else {
      this.options.push({ id: `wallet-${++this.sequence}`, name: rabby ? "Rabby" : name.slice(0, 48), rabby, provider, discovered });
    }
    this.options.sort((a, b) => Number(b.rabby) - Number(a.rabby));
    this.notify({ type: "providers", options: [...this.options] });
  }
  disconnect(announce = true) {
    this.epoch++;
    try { this.unwatch(); } catch {}
    this.unwatch = () => {};
    this.pending = false;
    this.session = null;
    if (announce) this.notify({ type: "disconnected" });
  }
  async connect(option) {
    if (this.pending || !this.options.includes(option)) return;
    this.disconnect(false);
    const epoch = this.epoch;
    this.pending = true;
    this.notify({ type: "connecting", name: option.name });
    let changed;
    const accountsChanged = (accounts) => {
      if (epoch !== this.epoch) return;
      if (this.pending) changed = accounts;
      else this.accept(accounts, option);
    };
    const disconnected = () => { if (epoch === this.epoch) this.disconnect(); };
    try {
    if (typeof option.provider.on === "function") {
      option.provider.on("accountsChanged", accountsChanged);
      option.provider.on("disconnect", disconnected);
      this.unwatch = () => {
        option.provider.removeListener?.("accountsChanged", accountsChanged);
        option.provider.removeListener?.("disconnect", disconnected);
      };
    }
      const accounts = await option.provider.request({ method: "eth_requestAccounts" });
      if (epoch !== this.epoch) return;
      this.pending = false;
      this.accept(changed ?? accounts, option);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.disconnect(false);
      this.notify({ type: "error", code: error?.code === 4001 ? "rejected" : error?.code === -32002 ? "pending" : "unavailable" });
    }
  }
  accept(accounts, option) {
    if (!Array.isArray(accounts) || !accounts.length) { this.disconnect(); return; }
    let address;
    try { address = normalizeAddress(accounts[0]); }
    catch { this.disconnect(false); this.notify({ type: "error", code: "invalid_account" }); return; }
    if (this.session?.address === address) return;
    const switched = !!this.session;
    this.session = { address, name: option.name, provider: option.provider };
    this.notify({ type: "connected", address, name: option.name, switched });
  }
  dispose() {
    this.host.removeEventListener("eip6963:announceProvider", this.announce);
    this.disconnect(false);
  }
}
