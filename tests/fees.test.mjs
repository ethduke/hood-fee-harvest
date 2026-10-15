import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex, toEventSelector } from "viem";
import {
  beneficiaryFees,
  NATIVE,
  compactAmount,
  normalizeAddress,
  totals,
  mergeRows,
} from "../lib/fees/model.mjs";
import { seal, open } from "../lib/fees/cursor.mjs";
import { scanResponse } from "../lib/fees/api.mjs";
import { Rpc } from "../lib/fees/rpc.mjs";
import { checkBlob } from "../scripts/check-public.mjs";
import { O1, LONG, LONG_HOOK } from "../lib/fees/catalog.mjs";
const wallet = `0x${"11".repeat(20)}`,
  other = `0x${"22".repeat(20)}`,
  hash = `0x${"33".repeat(32)}`;
const secret = "fixture-" + Array.from({ length: 40 }, (_, i) => String(i % 10)).join("");
test("fungun beneficiary checkpoint math does not confuse collected pool fees with payout", () => {
  assert.equal(beneficiaryFees(1000n, 100n, 900n, 25n * 10n ** 16n), 50n);
  assert.throws(() => beneficiaryFees(0n, 0n, 1n, 10n ** 18n));
  assert.throws(() => beneficiaryFees(1n, 1n, 0n, 10n ** 18n + 1n));
  assert.equal(beneficiaryFees(1000n, 0n, 1000n, 10n ** 18n), 0n);
});
test("exact formatting preserves positive dust and large integers", () => {
  assert.equal(compactAmount("1", 18), "<0.000001");
  assert.equal(compactAmount("123456789000000000000000000000", 18), "123,456,789,000");
  assert.throws(() => normalizeAddress(NATIVE));
  assert.equal(normalizeAddress(` ${wallet} `), wallet);
});
test("asset totals are keyed by currency address and result identities deduplicate", () => {
  const base = { currency: NATIVE, decimals: 18, symbol: "ETH", raw: "12" };
  assert.equal(totals([base, { ...base, raw: "5" }])[0].raw, "17");
  assert.equal(totals([base, { ...base, currency: other }]).length, 2);
  assert.throws(() => totals([base, { ...base, decimals: 6 }]));
  assert.equal(
    mergeRows([
      { id: "one", raw: "2" },
      { id: "one", raw: "3" },
    ]).length,
    1,
  );
});
test("signed cursors reject tampering, wallet/source changes and expiry", async () => {
  const state = {
    version: 1,
    address: wallet,
    source: "o1",
    snapshot: { number: 9, hash },
    seen: [],
    streams: [],
    pending: [],
  };
  const cursor = await seal(state, secret);
  assert.equal((await open(cursor, wallet, "o1", secret)).snapshot.number, 9);
  await assert.rejects(open(cursor, other, "o1", secret));
  await assert.rejects(open(cursor, wallet, "pons", secret));
  await assert.rejects(
    open(cursor.replace(/^./, cursor.startsWith("A") ? "B" : "A"), wallet, "o1", secret),
  );
  await assert.rejects(open(cursor, wallet, "o1", "different-" + secret));
});
test("RPC rejects all transaction/signature methods without sending requests", async () => {
  let called = 0;
  const rpc = new Rpc("https://rpc.example.invalid", () => {
    called++;
  });
  await assert.rejects(rpc.send("eth_sendRawTransaction", []));
  await assert.rejects(rpc.send("eth_sign", []));
  assert.equal(called, 0);
});
test("provider messages and thrown secrets never enter API errors", async () => {
  const marker = "sensitive fixture";
  const request = () =>
    new Request("https://app.example.invalid/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hood-intent": "scan" },
      body: JSON.stringify({ address: wallet, source: "o1" }),
    });
  const response = await scanResponse(request(), {
    url: "https://rpc.example.invalid",
    fetcher: async () => {
      throw new Error(marker);
    },
  });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.equal(text.includes(marker), false);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
});
test("same-origin intent, POST-only input and no caller-defined provider/target", async () => {
  for (const body of [
    { address: wallet, source: "o1", url: "https://evil.example.invalid" },
    { address: wallet, source: "o1", target: other },
  ]) {
    const r = await scanResponse(
      new Request("https://app.example.invalid/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hood-intent": "scan" },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(r.status, 400);
  }
  const r = await scanResponse(
    new Request("https://app.example.invalid/api/scan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hood-intent": "scan",
        origin: "https://other.example.invalid",
      },
      body: "{}",
    }),
  );
  assert.equal(r.status, 400);
});
test("public safety guard blocks prohibited files, logging and raw captures", () => {
  assert.ok(checkBlob("notes.md", Buffer.from("text")).length);
  assert.ok(checkBlob("app/page.tsx", Buffer.from("console.log(data)")).length);
  assert.ok(checkBlob("capture.json", Buffer.from(wallet)).length);
  assert.ok(checkBlob("logs/service.log", Buffer.from("text")).length);
  assert.ok(checkBlob("app/page.tsx", Buffer.from("localStorage.setItem(key, value)")).length);
  assert.equal(checkBlob("lib/wallet/scan-cache.mjs", Buffer.from("localStorage.setItem(key, value)")).length, 0);
  assert.ok(checkBlob("lib/wallet/scan-cache.mjs", Buffer.from("console.log(data)")).length);
  assert.equal(checkBlob("lib/fees/catalog.mjs", Buffer.from(O1[0].address)).length, 0);
});
test("failed reads remain errors, not empty successful results", async () => {
  const response = await scanResponse(
    new Request("https://app.example.invalid/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hood-intent": "scan" },
      body: JSON.stringify({ address: wallet, source: "long" }),
    }),
    {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "private fixture" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).balances, undefined);
});
import { scan } from "../lib/fees/engine.mjs";
import { o1Legacy } from "../lib/fees/abi.mjs";
import { ReadError } from "../lib/fees/model.mjs";
function fakeRpc({ failRange = false, reorg = false } = {}) {
  const record = { verified: [], ranges: [], calls: [] };
  return {
    record,
    async snapshot() {
      return { number: 88000000, hash, timestamp: 1234567890 };
    },
    async verify(target) {
      record.verified.push(target.address);
    },
    async currency(currency) {
      return {
        currency: currency.toLowerCase(),
        symbol: currency === NATIVE ? "ETH" : "TEST",
        decimals: 18,
        metadataVerified: true,
      };
    },
    async call(address, abi, name, args) {
      record.calls.push({ address, name, args });
      if (name === "owed") return 10n;
      throw new ReadError("read_failed");
    },
    async send(method, params) {
      if (method === "eth_chainId") return toHex(4663);
      if (method === "eth_getBlockByNumber") return { hash: reorg ? `0x${"44".repeat(32)}` : hash };
      if (method === "eth_getLogs") {
        record.ranges.push(params[0]);
        if (failRange) throw new ReadError("log_range");
        if (params[0].address !== O1[0].address) return [];
        return [
          {
            address: O1[0].address,
            removed: false,
            blockHash: hash,
            transactionHash: `0x${"55".repeat(32)}`,
            blockNumber: params[0].toBlock,
            logIndex: "0x1",
            topics: encodeEventTopics({
              abi: o1Legacy,
              eventName: "Claimed",
              args: { recipient: wallet, currency: other },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [45n]),
          },
        ];
      }
      throw new ReadError("invalid_request");
    },
  };
}
test("historical claims discover non-native owed balances, verify every profile and share a frozen snapshot", async () => {
  const rpc = fakeRpc();
  const result = await scan({ address: wallet, source: "o1" }, { secret, createRpc: () => rpc });
  assert.equal(rpc.record.verified.length, O1.length);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].currency, other);
  assert.equal(result.history[0].raw, "45");
  assert.equal(result.balances.filter((r) => r.currency === NATIVE).length, O1.length);
  assert.equal(result.balances.find((r) => r.currency === other).raw, "10");
  assert.equal(result.coverage.complete, false);
  assert.ok(result.cursor);
  const state = await open(result.cursor, wallet, "o1", secret);
  assert.equal(state.snapshot.number, 88000000);
  const frozen = await open(result.snapshotCursor, wallet, "snapshot", secret);
  assert.equal(frozen.snapshot.hash, hash);
  const again = await scan(
    { address: wallet, source: "o1", cursor: result.cursor },
    { secret, createRpc: () => fakeRpc() },
  );
  assert.equal(again.snapshot.number, result.snapshot.number);
});
test("range limits reduce the window without skipping failed blocks", async () => {
  const rpc = fakeRpc({ failRange: true });
  const result = await scan({ address: wallet, source: "o1" }, { secret, createRpc: () => rpc });
  const state = await open(result.cursor, wallet, "o1", secret);
  assert.equal(state.streams[0].next, state.snapshot.number);
  assert.equal(state.streams[0].range, Math.floor((88000000 - O1[0].start + 1) / 8));
  assert.equal(rpc.record.ranges.length, 3);
  assert.equal(result.coverage.percent, 0);
  assert.equal(result.history.length, 0);
});
test("reorg invalidates a resumed snapshot and cannot return stale balances", async () => {
  const result = await scan(
    { address: wallet, source: "o1" },
    { secret, createRpc: () => fakeRpc() },
  );
  await assert.rejects(
    scan(
      { address: wallet, source: "o1", cursor: result.cursor },
      { secret, createRpc: () => fakeRpc({ reorg: true }) },
    ),
    (e) => e.code === "snapshot_changed",
  );
});
test("RPC code pins fail closed on bytecode changes", async () => {
  const rpc = new Rpc(
    "https://rpc.example.invalid",
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6000" })),
  );
  await assert.rejects(
    rpc.verify({ address: wallet, hash: keccak256("0x6001") }, "0x1"),
    (e) => e.code === "contract_changed",
  );
});
test("transport refuses redirects and binds native Worker fetch correctly", async () => {
  let settings;
  const rpc = new Rpc("https://rpc.example.invalid", async function (url, options) {
    assert.equal(this, globalThis);
    settings = options;
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.example.invalid" },
    });
  });
  await assert.rejects(rpc.send("eth_chainId"), (e) => e.code === "provider_unavailable");
  assert.equal(settings.redirect, "manual");
});
test("known pons zero-fee revert is distinguished from generic read failures", async () => {
  const { toFunctionSelector } = await import("viem");
  const rpc = new Rpc(
    "https://rpc.example.invalid",
    async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: 3,
            data: toFunctionSelector("NoFeesToCollect()"),
            message: "private fixture",
          },
        }),
      ),
  );
  await assert.rejects(rpc.send("eth_call", []), (e) => e.code === "nothing_to_collect");
});
import { longAbi, ponsV1Abi } from "../lib/fees/abi.mjs";
import { PONS_V1 } from "../lib/fees/catalog.mjs";
import { poolId } from "../lib/fees/model.mjs";
test("Long release history and current beneficiary balances are separate, share-adjusted amounts", async () => {
  const key = {
      currency0: NATIVE,
      currency1: other,
      fee: 3000,
      tickSpacing: 60,
      hooks: LONG.address,
    },
    id = poolId(key),
    rpc = fakeRpc();
  rpc.call = async (address, abi, name) => {
    if (name === "getPoolKey") return [NATIVE, other, 3000, 60, LONG.address];
    if (name === "getState") return [NATIVE, 0n, LONG_HOOK.address, "0x", 2, key, 0];
    if (name === "getShares") return 25n * 10n ** 16n;
    if (name === "getCumulatedFees0") return 1000n;
    if (name === "getCumulatedFees1") return 100n;
    if (name === "getLastCumulatedFees0") return 900n;
    if (name === "getLastCumulatedFees1") return 0n;
    if (name === "collectFees") return [200n, 0n];
    throw new ReadError("read_failed");
  };
  const original = rpc.send;
  rpc.send = async (method, params) =>
    method !== "eth_getLogs"
      ? original(method, params)
      : Array.isArray(params[0].topics[0]) ? [] : [
          {
            address: LONG.address,
            removed: false,
            blockHash: hash,
            transactionHash: `0x${"55".repeat(32)}`,
            blockNumber: params[0].toBlock,
            logIndex: "0x1",
            topics: encodeEventTopics({
              abi: longAbi,
              eventName: "Release",
              args: { poolId: id, beneficiary: wallet },
            }),
            data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [4n, 8n]),
          },
        ];
  const first = await scan({ address: wallet, source: "long" }, { secret, createRpc: () => rpc });
  const result = await scan({ address: wallet, source: "long", cursor: first.cursor }, { secret, createRpc: () => rpc });
  assert.deepEqual(
    result.balances.map((r) => r.raw),
    ["75", "25"],
  );
  assert.deepEqual(
    result.history.map((r) => r.raw),
    ["4", "8"],
  );
});
function ponsRpc(redirectBeforeClaim = false) {
  const rpc = fakeRpc();
  rpc.call = async (address, abi, name, args, block) => {
    if (name === "balanceOf") return 20n;
    if (name === "feeRecipientTokenCount" || name === "deployerTokenCount") return 0n;
    if (name === "feeRedirects") return block === toHex(88000000) ? other : wallet;
    if (name === "deployer") return other;
    throw new ReadError("read_failed");
  };
  const original = rpc.send;
  rpc.send = async (method, params) => {
    if (method !== "eth_getLogs") return original(method, params);
    const filter = params[0];
    if (filter.address !== PONS_V1.address) return [];
    if (filter.fromBlock === filter.toBlock)
      return redirectBeforeClaim
        ? [
            {
              address: PONS_V1.address,
              blockNumber: filter.toBlock,
              logIndex: "0x1",
              topics: encodeEventTopics({
                abi: ponsV1Abi,
                eventName: "FeeRedirectUpdated",
                args: { token: other, newFeeWallet: other },
              }),
              data: "0x",
            },
          ]
        : [];
    if (filter.topics[0] === toEventSelector(ponsV1Abi.find((e) => e.name === "PositionLocked")))
      return [{
        address: PONS_V1.address, removed: false, blockHash: hash,
        transactionHash: `0x${"55".repeat(32)}`, blockNumber: filter.toBlock, logIndex: "0x0",
        topics: encodeEventTopics({ abi: ponsV1Abi, eventName: "PositionLocked", args: { token: other, deployer: wallet, dexId: 1n } }),
        data: encodeAbiParameters([{type:"address"},{type:"uint256"},{type:"address"}], [NATIVE,1n,other]),
      }];
    if (filter.topics[0] !== toEventSelector(ponsV1Abi.find((e) => e.name === "FeesClaimed"))) return [];
    return [
      {
        address: PONS_V1.address,
        removed: false,
        blockHash: hash,
        transactionHash: `0x${"55".repeat(32)}`,
        blockNumber: filter.toBlock,
        logIndex: "0x2",
        topics: encodeEventTopics({
          abi: ponsV1Abi,
          eventName: "FeesClaimed",
          args: { token: other, caller: other },
        }),
        data: encodeAbiParameters(
          [
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [NATIVE, other, 12n, 13n, 2n, 3n],
        ),
      },
    ];
  };
  return rpc;
}
test("pons v1 attributes an operator-triggered collection to its historical recipient", async () => {
  const next = await finishPons(false);
  assert.deepEqual(
    next.history.map((r) => r.raw),
    ["12", "13"],
  );
  assert.ok(next.history.every((r) => r.destination === wallet));
});
test("pons v1 respects redirects before the claim within the same block", async () => {
  const next = await finishPons(true);
  assert.equal(next.history.length, 0);
});
test("history-only pons reads preserve historical recipient attribution without balance simulations", async () => {
  const next = await finishPons(false, "history");
  assert.deepEqual(next.history.map((r) => r.raw), ["12", "13"]);
  assert.equal(next.balances.length, 0);
});
async function finishPons(redirect, scope) {
  let cursor, result;
  const history = [];
  for (let page = 0; page < 10; page++) {
    result = await scan({ address: wallet, source: "pons", scope, ...(cursor ? {cursor} : {}) },
      { secret, createRpc: () => ponsRpc(redirect) });
    history.push(...result.history);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  assert.equal(result.coverage.complete, true);
  return {...result, history};
}
