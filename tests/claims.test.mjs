import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics } from "viem";
import { O1, LONG, LONG_HOOK, PONS, PONS_V1 } from "../lib/fees/catalog.mjs";
import { o1Current, o1Legacy, longAbi, ponsV1Abi, ponsEscrow } from "../lib/fees/abi.mjs";
import { NATIVE, poolId } from "../lib/fees/model.mjs";
import { seal, open } from "../lib/fees/cursor.mjs";
import { claimKey, claimPlan, validateQuote } from "../lib/fees/claim-plan.mjs";
import { prepareClaim, confirmClaim, receiptPayouts } from "../lib/fees/claims.mjs";
import { prepareClaimResponse } from "../lib/fees/api.mjs";
import { ClaimController } from "../lib/wallet/claims.mjs";
const wallet = `0x${"11".repeat(20)}`, token = `0x${"22".repeat(20)}`, pair = `0x${"33".repeat(20)}`;
const blockHash = `0x${"44".repeat(32)}`, txHash = `0x${"55".repeat(32)}`;
const secret = "fixture-" + "8".repeat(40);
const poolKey = { currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: LONG.address }, position = poolId(poolKey);
const row = (profile = O1[4], currency = NATIVE) => ({ id: profile.id, target: profile.id, source: profile.kind.startsWith("pons") ? "pons" : profile.kind,
  currency, raw: "10", kind: "available", symbol: currency === NATIVE ? "ETH" : "TEST", decimals: 18, metadataVerified: true,
  ...(profile === LONG ? { position, token } : profile === PONS_V1 ? { position: token, token } : {}) });
function rpcFixture(profile = O1[4]) {
  const state = { calls: [], verified: [], raw: 10n, shares: 5n * 10n ** 17n, redirect: wallet, head: 120n, receipt: null, transaction: null };
  const rpc = {
    async snapshot(confirmations = 20) { return { number: Number(state.head) - confirmations, hash: blockHash, timestamp: 1 }; },
    async verify(target) { state.verified.push(target.id ?? "hook"); },
    async currency(currency) { return { currency, symbol: "TEST", decimals: 18, metadataVerified: true }; },
    async call(target, abi, name, args) {
      encodeFunctionData({ abi, functionName: name, args });
      state.calls.push(name);
      if (["owed", "balanceOf", "balanceOfToken"].includes(name)) return state.raw;
      if (name === "getState") return [NATIVE, 0n, LONG_HOOK.address, "0x", 2, poolKey, 0];
      if (name === "getShares") return state.shares;
      if (name === "getCumulatedFees0") return 1000n;
      if (name === "getCumulatedFees1") return 2000n;
      if (name.startsWith("getLastCumulatedFees")) return 0n;
      if (name === "collectFees") return [100n, 200n];
      if (name === "getLaunchedToken") return { exists: true, token, deployer: wallet, pairedToken: pair };
      if (name === "feeRedirects") return state.redirect;
      if (name === "deployer") return wallet;
      if (name === "pairedToken") return pair;
      if (name === "tokenProtocolFeeShares") return 30n;
      throw Error("Unexpected fixture read");
    },
    async send(method, params) {
      state.calls.push(method);
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_blockNumber") return `0x${state.head.toString(16)}`;
      if (method === "eth_getTransactionReceipt") return state.receipt;
      if (method === "eth_getTransactionByHash") return state.transaction;
      if (method === "eth_getBlockByNumber") return { hash: blockHash };
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_call") return profile === LONG || profile === PONS_V1
        ? encodeFunctionResult({ abi: profile === LONG ? longAbi : ponsV1Abi, functionName: "collectFees", result: [100n, 200n] })
        : profile === PONS ? encodeFunctionResult({ abi: ponsEscrow, functionName: "claim", result: state.raw }) : "0x";
      throw Error("Unexpected fixture method");
    },
  };
  return { state, rpc, options: { secret, createRpc: () => rpc } };
}
async function prepare(profile = O1[4], currency = NATIVE, fixture = rpcFixture(profile)) {
  const clicked = row(profile, currency);
  const claimHandle = await seal({ version: 1, address: wallet, source: "claim", row: clicked }, secret);
  const quote = await prepareClaim({ address: wallet, claimHandle }, fixture.options);
  return { ...fixture, clicked: { ...clicked, claimHandle }, quote };
}
function paidReceipt(quote, value = 10n) {
  return { transactionHash: txHash, from: wallet, to: quote.target, status: "0x1", blockHash, blockNumber: "0x64", logs: [{
    address: quote.target, blockHash, transactionHash: txHash, logIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: o1Current, eventName: "Claimed", args: { recipient: wallet, currency: NATIVE, destination: wallet } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  }] };
}
test("each O1 deployment preserves its own selector, always pays its owner, and carries zero native value", async () => {
  for (const profile of O1) {
    const { quote, state, clicked } = await prepare(profile);
    const decoded = decodeFunctionData({ abi: profile.version === "legacy" ? o1Legacy : o1Current, data: quote.data });
    assert.equal(decoded.functionName, profile.version === "legacy" ? "claim" : "claimFor");
    assert.deepEqual(decoded.args.map((item) => item.toLowerCase()), [wallet, NATIVE]);
    assert.equal(quote.value, "0x0"); assert.equal(quote.target, profile.address);
    assert.ok(state.verified.includes(profile.id));
    assert.ok(state.calls.includes("eth_call") && state.calls.includes("eth_estimateGas"));
    assert.equal(validateQuote(quote, clicked, wallet).data, quote.data);
  }
});
test("pons escrow caps its native/token claim to the live balance", async () => {
  for (const currency of [NATIVE, token]) {
    const { quote } = await prepare(PONS, currency);
    const decoded = decodeFunctionData({ abi: ponsEscrow, data: quote.data });
    assert.equal(decoded.functionName, currency === NATIVE ? "claim" : "claimToken");
    assert.equal(decoded.args.at(-1), 10n);
  }
});
test("Long claims both assets together and uses beneficiary shares rather than the pool-wide return", async () => {
  const { quote, state } = await prepare(LONG);
  assert.deepEqual(quote.payouts.map((payout) => payout.raw), ["550", "1100"]);
  assert.ok(state.verified.includes(LONG.id) && state.verified.includes("hook"));
  assert.equal(claimKey(quote.row), claimKey({ ...quote.row, currency: token }));
  assert.equal(decodeFunctionData({ abi: longAbi, data: quote.data }).args[0], position);
});
test("pons v1 binds a claim to the current fee recipient and claims both assets", async () => {
  const { quote } = await prepare(PONS_V1, token);
  assert.deepEqual(quote.payouts.map((payout) => payout.raw), ["70", "140"]);
  const fixture = rpcFixture(PONS_V1); fixture.state.redirect = pair;
  await assert.rejects(prepare(PONS_V1, token, fixture), (error) => error.code === "wrong_account");
});
test("unsigned or another wallet's rows, unswept fees, zero balances, redirects and native value are blocked", async () => {
  const { quote, clicked, options } = await prepare();
  await assert.rejects(prepareClaim({ address: pair, claimHandle: clicked.claimHandle }, options));
  await assert.rejects(prepareClaim({ address: wallet, claimHandle: "unsigned" }, options));
  assert.throws(() => claimPlan({ ...clicked, kind: "unswept" }, wallet));
  for (const patch of [{ target: pair }, { address: pair }, { value: "0x1" }, { data: quote.data + "00" }, { chainId: 1 }, { payouts: [] }])
    assert.throws(() => validateQuote({ ...quote, ...patch }, clicked, wallet));
  const fixture = rpcFixture(); fixture.state.raw = 0n;
  await assert.rejects(prepare(O1[4], NATIVE, fixture), (error) => error.code === "nothing_to_claim");
});
test("claim API accepts only same-origin bounded preparation inputs and exposes fixed codes", async () => {
  const request = (input, origin) => new Request("https://app.example.invalid/api/claim/prepare", { method: "POST",
    headers: { "content-type": "application/json", "x-hood-intent": "claim-prepare", ...(origin ? { origin } : {}) }, body: JSON.stringify(input) });
  for (const input of [{ address: wallet, target: pair }, { address: wallet, url: "https://example.invalid" }])
    assert.equal((await prepareClaimResponse(request(input))).status, 400);
  assert.equal((await prepareClaimResponse(request({}, "https://elsewhere.example.invalid"))).status, 400);
  const response = await prepareClaimResponse(request({ address: wallet, claimHandle: "unsigned" }), { secret });
  assert.equal((await response.json()).error, "cursor_expired");
});
test("receipt confirmation waits until the refresh snapshot contains the payout and rejects changed transaction data", async () => {
  const { quote, state, options } = await prepare();
  const input = { address: wallet, authorization: quote.authorization, hash: txHash };
  assert.equal((await confirmClaim(input, options)).status, "pending");
  state.receipt = paidReceipt(quote);
  state.transaction = { hash: txHash, from: wallet, to: quote.target, input: quote.data, value: "0x0", blockHash };
  state.head = 119n;
  assert.equal((await confirmClaim(input, options)).status, "confirming");
  state.head = 120n;
  const result = await confirmClaim(input, options);
  assert.equal(result.status, "confirmed"); assert.equal(result.history[0].raw, "10");
  assert.ok((await open(result.snapshotCursor, wallet, "snapshot", secret)).snapshot.number >= 100);
  state.transaction.input += "00";
  await assert.rejects(confirmClaim(input, options), (error) => error.code === "invalid_response");
});
test("successful receipts without payout events and reverted receipts never become paid history", async () => {
  const { quote, state, options } = await prepare();
  state.receipt = { ...paidReceipt(quote), logs: [] };
  state.transaction = { hash: txHash, from: wallet, to: quote.target, input: quote.data, value: "0x0", blockHash };
  const input = { address: wallet, authorization: quote.authorization, hash: txHash };
  assert.equal((await confirmClaim(input, options)).status, "no_payout");
  state.receipt.status = "0x0";
  const reverted = await confirmClaim(input, options);
  assert.equal(reverted.status, "reverted"); assert.deepEqual(reverted.history, []);
  assert.deepEqual(receiptPayouts(paidReceipt(quote, 0n), quote), []);
});
async function controllerFixture(sendError) {
  const { quote, clicked } = await prepare();
  const events = [], refreshes = [], calls = [];
  const session = { address: wallet, provider: { async request({ method, params }) {
    calls.push({ method, params });
    if (method === "eth_accounts") return [wallet];
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return "0xabcd";
    if (method === "eth_call") return "0x";
    if (method === "eth_sendTransaction") { if (sendError) throw sendError; return txHash; }
    throw Error("Unexpected wallet method");
  } } };
  let current = session, confirmation = 0;
  const controller = new ClaimController({ getSession: () => current, notify: (state) => events.push({ ...state }),
    refresh: (result, owner) => refreshes.push({ result, owner }), hashCode: () => O1[4].hash, delay: async () => {},
    fetcher: async function (url) { assert.equal(this, globalThis); return new Response(JSON.stringify(url.endsWith("prepare") ? quote : confirmation++ === 0
      ? { status: "confirming", confirmations: 19 }
      : { status: "confirmed", history: [{ ...clicked, tx: txHash }], snapshotCursor: "qa.snapshot" }), { headers: { "content-type": "application/json" } }); },
  });
  return { controller, events, refreshes, calls, clicked, changeAccount: () => { current = { ...session, address: pair }; controller.contextChanged(); } };
}
test("wallet submission is explicit, serialized, account-bound and refreshes both datasets only after confirmation", async () => {
  const { controller, calls, refreshes, clicked, events } = await controllerFixture();
  await controller.begin(clicked);
  assert.equal(controller.state.phase, "review"); assert.equal(calls.length, 0);
  await Promise.all([controller.send(), controller.send()]);
  const writes = calls.filter((call) => call.method === "eth_sendTransaction");
  assert.equal(writes.length, 1); assert.equal(writes[0].params[0].value, "0x0");
  assert.ok(events.some((event) => event.phase === "confirming"));
  assert.equal(refreshes.length, 1); assert.equal(refreshes[0].owner, wallet);
  assert.equal(controller.state.phase, "confirmed");
});
test("wallet rejection never refreshes paid history; an ambiguous send is locked and never resent", async () => {
  for (const [error, phase] of [[{ code: 4001, message: "private detail" }, "error"], [{ code: -1, message: "private detail" }, "uncertain"]]) {
    const fixture = await controllerFixture(error);
    await fixture.controller.begin(fixture.clicked); await fixture.controller.send(); await fixture.controller.send();
    assert.equal(fixture.controller.state.phase, phase); assert.equal(fixture.refreshes.length, 0);
    assert.equal(fixture.calls.filter((call) => call.method === "eth_sendTransaction").length, 1);
    assert.equal(JSON.stringify(fixture.events).includes("private detail"), false);
  }
});
test("account changes invalidate reviews before any wallet transaction can be submitted", async () => {
  const fixture = await controllerFixture();
  await fixture.controller.begin(fixture.clicked); fixture.changeAccount(); await fixture.controller.send();
  assert.equal(fixture.calls.filter((call) => call.method === "eth_sendTransaction").length, 0);
  assert.equal(fixture.controller.state.phase, "idle");
});
test("changed contract bytecode blocks the wallet prompt and simulation failures never leak provider details", async () => {
  const fixture = await controllerFixture();
  fixture.controller.hashCode = () => `0x${"99".repeat(32)}`;
  await fixture.controller.begin(fixture.clicked); await fixture.controller.send();
  assert.equal(fixture.controller.state.error, "contract_changed");
  assert.equal(fixture.calls.some((call) => call.method === "eth_sendTransaction"), false);
  const failed = await controllerFixture();
  failed.controller.getSession().provider.request = async ({ method }) => {
    if (method === "eth_accounts") return [wallet];
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return "0xabcd";
    throw Error("private provider details");
  };
  await failed.controller.begin(failed.clicked); await failed.controller.send();
  assert.equal(failed.controller.state.phase, "error");
  assert.equal(JSON.stringify(failed.events).includes("private provider details"), false);
});
test("claim finality is bound to the canonical block, owner and recipient event", async () => {
  const { quote, state, options } = await prepare();
  state.receipt = paidReceipt(quote);
  state.transaction = { hash: txHash, from: wallet, to: quote.target, input: quote.data, value: "0x0", blockHash };
  state.receipt.from = pair;
  await assert.rejects(confirmClaim({ address: wallet, authorization: quote.authorization, hash: txHash }, options));
  state.receipt = paidReceipt(quote);
  state.receipt.blockHash = `0x${"66".repeat(32)}`; state.transaction.blockHash = state.receipt.blockHash;
  assert.equal((await confirmClaim({ address: wallet, authorization: quote.authorization, hash: txHash }, options)).status, "pending");
  const receipt = paidReceipt(quote);
  receipt.logs[0].topics = encodeEventTopics({ abi: o1Current, eventName: "Claimed", args: { recipient: wallet, currency: NATIVE, destination: pair } });
  assert.deepEqual(receiptPayouts(receipt, quote), []);
});
test("Long receipt payout amounts stay aligned with its two currencies", async () => {
  const { quote } = await prepare(LONG);
  const receipt = { ...paidReceipt(quote), logs: [{ address: LONG.address, blockHash, transactionHash: txHash, logIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: longAbi, eventName: "Release", args: { poolId: position, beneficiary: wallet } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [550n, 1100n]),
  }] };
  assert.deepEqual(receiptPayouts(receipt, quote).map((payout) => [payout.currency, payout.raw]), [[NATIVE, "550"], [token, "1100"]]);
  receipt.logs[0].topics = encodeEventTopics({ abi: longAbi, eventName: "Release", args: { poolId: position, beneficiary: pair } });
  assert.deepEqual(receiptPayouts(receipt, quote), []);
});
