import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WalletAdapter } from "../lib/wallet/adapter.mjs";
const account = `0x${"17".repeat(20)}`, other = `0x${"28".repeat(20)}`;
function provider(request = async () => [account]) {
  const wallet = new EventEmitter();
  wallet.calls = [];
  wallet.request = async (input) => { wallet.calls.push(input); return request(input); };
  return wallet;
}
function setup(legacy) {
  const host = new EventTarget();
  host.ethereum = legacy;
  const events = [];
  const adapter = new WalletAdapter(host, (event) => events.push(event));
  adapter.start();
  const announce = (wallet, name, rdns) => host.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { name, rdns }, provider: wallet } }));
  return { adapter, events, announce };
}
test("Rabby discovery wins over a competing legacy provider, without duplicate wallets or account requests", () => {
  const legacy = provider(), rabby = provider();
  const { adapter, announce } = setup(legacy);
  announce(rabby, "Rabby Wallet", "io.rabby");
  announce(rabby, "Rabby Wallet", "io.rabby");
  assert.equal(adapter.options.length, 2);
  assert.equal(adapter.options[0].provider, rabby);
  assert.equal(adapter.options[0].name, "Rabby");
  assert.equal(legacy.calls.length + rabby.calls.length, 0);
  adapter.dispose();
});
test("connection requests account access only; switches emit the new account and disconnect clears listeners", async () => {
  const wallet = provider(); wallet.isRabby = true;
  const { adapter, events } = setup(wallet);
  await adapter.connect(adapter.options[0]);
  assert.deepEqual(wallet.calls, [{ method: "eth_requestAccounts" }]);
  assert.equal(events.at(-1).address, account);
  wallet.emit("accountsChanged", [other]);
  assert.equal(events.at(-1).address, other);
  assert.equal(events.at(-1).switched, true);
  const count = events.length;
  wallet.emit("accountsChanged", [other]);
  assert.equal(events.length, count);
  wallet.emit("accountsChanged", []);
  assert.equal(events.at(-1).type, "disconnected");
  assert.equal(adapter.session, null);
  assert.equal(wallet.listenerCount("accountsChanged"), 0);
  adapter.dispose();
});
test("cancelled or unmounted pending connections cannot reconnect from a late permission response", async () => {
  let resolve;
  const wallet = provider(() => new Promise((done) => { resolve = done; }));
  const { adapter, events } = setup(wallet);
  const pending = adapter.connect(adapter.options[0]);
  adapter.disconnect();
  resolve([account]);
  await pending;
  assert.equal(adapter.session, null);
  assert.equal(events.at(-1).type, "disconnected");
  const pendingAgain = adapter.connect(adapter.options[0]);
  adapter.dispose(); resolve([account]); await pendingAgain;
  assert.equal(adapter.session, null);
  assert.equal(wallet.listenerCount("disconnect"), 0);
});
test("account changes while permission is pending supersede the returned older account", async () => {
  let resolve;
  const wallet = provider(() => new Promise((done) => { resolve = done; }));
  const { adapter, events } = setup(wallet);
  const pending = adapter.connect(adapter.options[0]);
  wallet.emit("accountsChanged", [other]); resolve([account]); await pending;
  assert.equal(events.at(-1).address, other);
  assert.equal(events.filter((event) => event.type === "connected").length, 1);
  adapter.dispose();
});
test("wallet rejection and malformed accounts expose only fixed error codes", async () => {
  const sensitive = "private provider details";
  const wallet = provider(async () => { throw { code: 4001, message: sensitive }; });
  const { adapter, events } = setup(wallet);
  await adapter.connect(adapter.options[0]);
  assert.deepEqual(events.at(-1), { type: "error", code: "rejected" });
  assert.equal(JSON.stringify(events).includes(sensitive), false);
  wallet.request = async () => ["not an address"];
  await adapter.connect(adapter.options[0]);
  assert.deepEqual(events.at(-1), { type: "error", code: "invalid_account" });
  assert.equal(wallet.listenerCount("accountsChanged"), 0);
  adapter.dispose();
});
test("provider disconnection stops the session and stale account events are ignored", async () => {
  const wallet = provider();
  const { adapter, events } = setup(wallet);
  await adapter.connect(adapter.options[0]);
  wallet.emit("disconnect", { message: "private detail" });
  const count = events.length;
  wallet.emit("accountsChanged", [other]);
  assert.equal(events.length, count);
  assert.equal(adapter.session, null);
  adapter.dispose();
});

test("EIP discovery replaces a legacy Rabby wrapper without duplicate picker entries", () => {
  const legacy = provider(), announced = provider(); legacy.isRabby = true;
  const { adapter, announce } = setup(legacy);
  announce(announced, "Rabby", "io.rabby");
  adapter.discoverLegacy();
  assert.equal(adapter.options.length, 1);
  assert.equal(adapter.options[0].provider, announced);
  adapter.dispose();
});
