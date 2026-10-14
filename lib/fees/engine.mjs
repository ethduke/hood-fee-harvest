import { decodeEventLog, toEventSelector, toHex } from "viem";
import { Rpc } from "./rpc.mjs";
import { open, seal } from "./cursor.mjs";
import {
  SOURCE_INFO,
  targets,
  LONG,
  LONG_HOOK,
  PONS,
  PONS_HOOK,
  PONS_V1,
} from "./catalog.mjs";
import {
  o1Current,
  o1Legacy,
  ponsEscrow,
  longAbi,
  ponsV1Abi,
  ponsFactoryAbi,
  ponsCurveAbi,
  ponsHookAbi,
} from "./abi.mjs";
import {
  ReadError,
  normalizeAddress,
  NATIVE,
  same,
  topicAddress,
  beneficiaryFees,
  poolId,
  progress,
} from "./model.mjs";
const abiFor = (target) =>
  target.kind === "o1"
    ? target.version === "legacy"
      ? o1Legacy
      : o1Current
    : target.kind === "pons"
      ? ponsEscrow
      : target.kind === "pons-v1"
        ? ponsV1Abi
        : target.kind === "pons-factory"
          ? ponsFactoryAbi
          : longAbi;
const events = (abi) => abi.filter((x) => x.type === "event").map(toEventSelector);
function streamFor(target, snapshot, mode, token) {
  return {
    target: target.id, start: target.start, next: snapshot,
    range: Math.max(1, snapshot - target.start + 1), sizing: 2,
    ...(mode ? { mode } : {}), ...(token ? { token } : {}),
  };
}
function initialStreams(source, snapshot) {
  return targets[source].flatMap((target) => {
    const modes = target.kind === "long" ? ["discovery", "claims"]
      : target.kind === "pons-v1" ? ["deployer", "recipient"] : [undefined];
    return modes.map((mode) => streamFor(target, snapshot, mode));
  });
}
function v1History(state, token) {
  if (!state.streams) return; // Claim preflight reuses the balance reader only.
  // Recipient indexes contain current rights. The indexed redirect events also
  // discover former recipients, whose historical payouts must remain visible.
  if (!state.streams.some((s) => s.mode === "token-claims" && same(s.token, token))) {
    if (state.streams.length >= 520) throw new ReadError("position_limit");
    state.streams.push(streamFor(PONS_V1, state.snapshot.number, "token-claims", token));
  }
}
function streamTopics(stream, target, address) {
  const abi = abiFor(target);
  const selector = (name) => toEventSelector(abi.find((e) => e.type === "event" && e.name === name));
  const wallet = topicAddress(address);
  if (target.kind === "long" && stream.mode === "discovery")
    return [[selector("Lock"), selector("UpdateBeneficiary")]];
  if (target.kind === "long" && stream.mode === "claims")
    return [selector("Release"), null, wallet];
  if (stream.mode === "deployer") return [selector("PositionLocked"), null, wallet];
  if (stream.mode === "recipient") return [selector("FeeRedirectUpdated"), null, wallet];
  if (stream.mode === "token-claims") return [selector("FeesClaimed"), topicAddress(stream.token)];
  return [events(abi), ...(["o1", "pons"].includes(target.kind) ? [wallet] : [])];
}
function relevantEvent(event, address) {
  const a = event.args;
  if (event.event === "Lock") return a.beneficiaries.some((b) => same(b.beneficiary, address));
  if (event.event === "UpdateBeneficiary")
    return same(a.newBeneficiary, address) || same(a.oldBeneficiary, address);
  if (event.event === "Release") return same(a.beneficiary, address);
  if (event.event === "PositionLocked") return same(a.deployer, address);
  if (event.event === "FeeRedirectUpdated") return same(a.newFeeWallet, address);
  if (event.event === "CreatorFeeRecipientUpdated") return same(a.newRecipient, address);
  return true;
}
function readState(state) {
  if (
    !state ||
    !Array.isArray(state.streams) ||
    !Array.isArray(state.pending) ||
    !Array.isArray(state.seen) ||
    state.pending.length > 128 ||
    state.seen.length > 512 ||
    !Number.isSafeInteger(state.snapshot.number)
  )
    throw new ReadError("cursor_expired");
}
function logValue(log, target, lo, hi, abi, topics) {
  if (
    !log ||
    !same(log.address, target.address) ||
    log.removed !== false ||
    !/^0x[\da-f]{64}$/i.test(log.blockHash) ||
    !/^0x[\da-f]{64}$/i.test(log.transactionHash) ||
    !/^0x[\da-f]+$/i.test(log.blockNumber) ||
    !/^0x[\da-f]+$/i.test(log.logIndex) ||
    !Array.isArray(log.topics)
  )
    throw new ReadError("invalid_response");
  const height = Number(BigInt(log.blockNumber));
  if (height < lo || height > hi) throw new ReadError("invalid_response");
  if (topics?.some((expected, i) => expected !== null &&
    !(Array.isArray(expected) ? expected : [expected]).some((value) => same(value, log.topics[i]))))
    throw new ReadError("invalid_response");
  let event;
  try {
    event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  } catch {
    throw new ReadError("invalid_response");
  }
  return {
    target: target.id,
    event: event.eventName,
    args: JSON.parse(
      JSON.stringify(event.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
    block: height,
    tx: log.transactionHash,
    index: Number(BigInt(log.logIndex)),
    hash: log.blockHash,
  };
}
async function payout(rpc, state, event, currency, raw, extra = {}) {
  return {
    id: `${event.hash}:${event.index}:${currency.toLowerCase()}`,
    source: state.source,
    target: event.target,
    ...(await rpc.currency(currency, toHex(state.snapshot.number))),
    raw: raw.toString(),
    block: event.block,
    tx: event.tx,
    ...extra,
  };
}
async function balance(rpc, state, target, currency, raw, extra = {}) {
  return {
    id: `${target.id}:${extra.position ?? ""}:${currency.toLowerCase()}:${extra.kind ?? "available"}`,
    source: state.source,
    target: target.id,
    ...(await rpc.currency(currency, toHex(state.snapshot.number))),
    raw: raw.toString(),
    kind: "available",
    ...extra,
  };
}
export async function longPool(rpc, id, asset, block) {
  let key;
  if (asset) {
    const s = await rpc.call(LONG.address, longAbi, "getState", [asset], block);
    key = s[5];
    if (!same(s[2], LONG_HOOK.address) || s[4] === 0) return null;
  } else {
    const k = await rpc.call(LONG.address, longAbi, "getPoolKey", [id], block);
    key = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
    let found;
    for (const token of [key.currency0, key.currency1].filter((a) => !same(a, NATIVE))) {
      const s = await rpc.call(LONG.address, longAbi, "getState", [token], block);
      if (s[4] !== 0 && same(s[2], LONG_HOOK.address) && poolId(s[5]) === id) {
        asset = token;
        found = s;
        break;
      }
    }
    if (!found) return null;
  }
  if (!same(key.hooks, LONG.address) || BigInt(key.currency0) >= BigInt(key.currency1)) return null;
  const computed = poolId(key);
  if (id && id !== computed) throw new ReadError("invalid_response");
  return { id: computed, key, asset };
}
export async function longBalance(rpc, state, pool, rows, warnings) {
  const block = toHex(state.snapshot.number),
    address = state.address;
  const s = await rpc.call(LONG.address, longAbi, "getState", [pool.asset], block);
  if (s[4] !== 2 || !same(s[2], LONG_HOOK.address)) {
    warnings.add("migrated_pool");
    return;
  }
  const shares = await rpc.call(LONG.address, longAbi, "getShares", [pool.id, address], block);
  if (shares === 0n) return;
  const c0 = await rpc.call(LONG.address, longAbi, "getCumulatedFees0", [pool.id], block);
  const c1 = await rpc.call(LONG.address, longAbi, "getCumulatedFees1", [pool.id], block);
  const l0 = await rpc.call(
    LONG.address,
    longAbi,
    "getLastCumulatedFees0",
    [pool.id, address],
    block,
  );
  const l1 = await rpc.call(
    LONG.address,
    longAbi,
    "getLastCumulatedFees1",
    [pool.id, address],
    block,
  );
  const collected = await rpc.call(LONG.address, longAbi, "collectFees", [pool.id], block, address);
  for (const [i, currency] of [pool.key.currency0, pool.key.currency1].entries()) {
    const raw = beneficiaryFees(i === 0 ? c0 : c1, collected[i], i === 0 ? l0 : l1, shares);
    rows.push(
      await balance(rpc, state, LONG, currency, raw, { position: pool.id, token: pool.asset }),
    );
  }
}
async function processEvent(rpc, state, event, rows, history, warnings) {
  const target = targets[state.source].find((t) => t.id === event.target),
    a = event.args,
    block = toHex(state.snapshot.number);
  if (target.kind === "o1" || target.kind === "pons") {
    if (!same(a.recipient, state.address)) throw new ReadError("invalid_response");
    const currency = target.kind === "o1" ? a.currency : (a.token ?? NATIVE);
    const key = `${target.id}:${currency.toLowerCase()}`;
    if (!state.seen.includes(key)) {
      const raw =
        target.kind === "o1"
          ? await rpc.call(target.address, o1Current, "owed", [state.address, currency], block)
          : await rpc.call(
              target.address,
              ponsEscrow,
              same(currency, NATIVE) ? "balanceOf" : "balanceOfToken",
              same(currency, NATIVE) ? [state.address] : [state.address, currency],
              block,
            );
      rows.push(await balance(rpc, state, target, currency, raw));
      state.seen.push(key);
    }
    if (event.event.startsWith("Claimed") && BigInt(a.amount) > 0n)
      history.push(
        await payout(rpc, state, event, currency, a.amount, {
          destination: a.destination ?? state.address,
        }),
      );
    return;
  }
  if (target.kind === "long") {
    if (event.event === "Release") {
      if (!same(a.beneficiary, state.address)) throw new ReadError("invalid_response");
      const pool = await longPool(rpc, a.poolId, null, block);
      if (!pool) {
        warnings.add("other_doppler_route");
        return;
      }
      const currentKey = `long:${pool.id}`;
      if (!state.seen.includes(currentKey)) {
        await longBalance(rpc, state, pool, rows, warnings);
        state.seen.push(currentKey);
      }
      for (const [i, currency] of [pool.key.currency0, pool.key.currency1].entries()) {
        const raw = i === 0 ? a.fees0 : a.fees1;
        if (BigInt(raw) > 0n)
          history.push(
            await payout(rpc, state, event, currency, raw, {
              position: pool.id,
              token: pool.asset,
            }),
          );
      }
    } else {
      const relevant =
        event.event === "Lock"
          ? a.beneficiaries.some((b) => same(b.beneficiary, state.address))
          : same(a.newBeneficiary, state.address) || same(a.oldBeneficiary, state.address);
      if (!relevant) return;
      const pool = await longPool(
        rpc,
        event.event === "Lock" ? null : a.poolId,
        event.event === "Lock" ? a.pool : null,
        block,
      );
      if (!pool) {
        warnings.add("other_doppler_route");
        return;
      }
      const key = `long:${pool.id}`;
      if (state.seen.includes(key)) return;
      await longBalance(rpc, state, pool, rows, warnings);
      state.seen.push(key);
    }
    return;
  }
  // pons discovery is handled below. History reads use the actual payout
  // recipient at the event block, never FeesClaimed.caller.
  if (target.kind === "pons-v1") {
    if (event.event === "FeesClaimed") {
      const tokenAbi = [
        {
          type: "function",
          name: "deployer",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ];
      let recipient;
      try {
        const previous = toHex(Math.max(0, event.block - 1));
        recipient = await rpc.call(target.address, ponsV1Abi, "feeRedirects", [a.token], previous);
        if (same(recipient, NATIVE))
          recipient = await rpc.call(a.token, tokenAbi, "deployer", [], previous);
        // Historical eth_call is end-of-block. Apply only redirects preceding
        // this claim's log index so same-block transfers cannot misattribute it.
        const redirects = await rpc.send("eth_getLogs", [
          {
            address: target.address,
            fromBlock: toHex(event.block),
            toBlock: toHex(event.block),
            topics: [
              toEventSelector(ponsV1Abi.find((x) => x.name === "FeeRedirectUpdated")),
              topicAddress(a.token),
            ],
          },
        ]);
        for (const log of redirects.sort((x, y) =>
          Number(BigInt(x.logIndex) - BigInt(y.logIndex)),
        )) {
          if (Number(BigInt(log.logIndex)) >= event.index) break;
          const parsed = decodeEventLog({
            abi: ponsV1Abi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          recipient = same(parsed.args.newFeeWallet, NATIVE)
            ? await rpc.call(a.token, tokenAbi, "deployer", [], previous)
            : parsed.args.newFeeWallet;
        }
      } catch {
        warnings.add("archive_required");
        return;
      }
      if (!same(recipient, state.address)) return;
      for (const [currency, raw] of [
        [a.token0, a.recipientAmount0],
        [a.token1, a.recipientAmount1],
      ])
        if (BigInt(raw) > 0n)
          history.push(
            await payout(rpc, state, event, currency, raw, {
              token: a.token,
              destination: recipient,
            }),
          );
    } else {
      if (event.event === "PositionLocked" && !same(a.deployer, state.address)) return;
      if (event.event === "FeeRedirectUpdated" && !same(a.newFeeWallet, state.address)) return;
      await ponsV1Balance(rpc, state, a.token, rows, warnings);
    }
    return;
  }
  if (target.kind === "pons-factory") {
    if (
      event.event === "CreatorFeeRecipientUpdated" &&
      !same(a.newRecipient, state.address) &&
      !same(a.previousRecipient, state.address)
    )
      return;
    const launch = await rpc.call(
      target.address,
      ponsFactoryAbi,
      "getLaunchedToken",
      [a.token],
      block,
    );
    if (!launch.exists || !same(launch.creatorFeeRecipient, state.address)) return false;
    const key = `curve:${a.token.toLowerCase()}`;
    if (state.seen.includes(key)) return;
    const graduated = await rpc.call(launch.curve, ponsCurveAbi, "graduated", [], block);
    if (!graduated) {
      const recipient = await rpc.call(launch.curve, ponsCurveAbi, "deployer", [], block);
      if (!same(recipient, state.address)) throw new ReadError("contract_changed");
      const quote = await rpc.call(launch.curve, ponsCurveAbi, "quoteFeeBalance", [], block);
      const tax = await rpc.call(launch.curve, ponsCurveAbi, "creatorTaxBalance", [], block);
      const share = BigInt(
        await rpc.call(launch.curve, ponsCurveAbi, "protocolFeeShareBps", [], block),
      );
      const earmark = await rpc.call(launch.curve, ponsCurveAbi, "buybackQuoteBalance", [], block);
      if (share > 10000n) throw new ReadError("invalid_response");
      const bucket = quote - (quote * share) / 10000n,
        buyback = earmark < bucket ? earmark : bucket;
      const raw = bucket - buyback + tax;
      if (quote > 0n || tax > 0n)
        rows.push(
          await balance(rpc, state, PONS, launch.pairToken, raw, {
            kind: "unswept",
            token: a.token,
            position: launch.curve,
            earmarkedRaw: buyback.toString(),
          }),
        );
      if (buyback > 0n) warnings.add("buyback_earmark");
    } else {
      const ordered =
        BigInt(a.token) < BigInt(launch.pairToken)
          ? [a.token, launch.pairToken]
          : [launch.pairToken, a.token];
      const id = poolId({
        currency0: ordered[0],
        currency1: ordered[1],
        fee: launch.poolFee,
        tickSpacing: launch.tickSpacing,
        hooks: PONS_HOOK.address,
      });
      const config = await rpc.call(PONS_HOOK.address, ponsHookAbi, "launches", [id], block);
      if (!config[0] || !same(config[2], a.token) || !same(config[4], state.address))
        throw new ReadError("contract_changed");
      const share = BigInt(config[8]);
      if (share > 10000n) throw new ReadError("invalid_response");
      for (const currency of ordered) {
        const gross = await rpc.call(
          PONS_HOOK.address,
          ponsHookAbi,
          "pendingFees",
          [id, currency],
          block,
        );
        const tax = await rpc.call(
          PONS_HOOK.address,
          ponsHookAbi,
          "pendingCreatorTax",
          [id, currency],
          block,
        );
        const earmark = await rpc.call(
          PONS_HOOK.address,
          ponsHookAbi,
          "pendingBuyback",
          [id, currency],
          block,
        );
        const bucket = gross - (gross * share) / 10000n,
          buyback = earmark < bucket ? earmark : bucket;
        if (gross > 0n || tax > 0n)
          rows.push(
            await balance(rpc, state, PONS, currency, bucket - buyback + tax, {
              kind: same(currency, a.token) ? "conversion-needed" : "unswept",
              token: a.token,
              position: id,
              earmarkedRaw: buyback.toString(),
            }),
          );
      }
    }
    state.seen.push(key);
  }
}
export async function ponsV1Balance(rpc, state, token, rows, warnings) {
  v1History(state, token);
  const key = `v1:${token.toLowerCase()}`;
  if (state.seen.includes(key)) return;
  const block = toHex(state.snapshot.number);
  const redirect = await rpc.call(PONS_V1.address, ponsV1Abi, "feeRedirects", [token], block);
  const tokenAbi = [
    {
      type: "function",
      name: "deployer",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "address" }],
    },
    {
      type: "function",
      name: "pairedToken",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "address" }],
    },
  ];
  const deployer = await rpc.call(token, tokenAbi, "deployer", [], block);
  if (!same(same(redirect, NATIVE) ? deployer : redirect, state.address)) {
    state.seen.push(key);
    return;
  }
  let gross;
  try {
    gross = await rpc.call(PONS_V1.address, ponsV1Abi, "collectFees", [token], block, deployer);
  } catch (error) {
    if (error.code === "nothing_to_collect") gross = [0n, 0n];
    else {
      warnings.add("v1_preview_unavailable");
      return;
    }
  }
  const share = await rpc.call(
    PONS_V1.address,
    ponsV1Abi,
    "tokenProtocolFeeShares",
    [token],
    block,
  );
  if (share > 100n) throw new ReadError("invalid_response");
  const pair = await rpc.call(token, tokenAbi, "pairedToken", [], block);
  const ordered = BigInt(token) < BigInt(pair) ? [token, pair] : [pair, token];
  for (const [i, currency] of ordered.entries())
    rows.push(
      await balance(rpc, state, PONS_V1, currency, gross[i] - (gross[i] * share) / 100n, {
        token,
        position: token,
      }),
    );
  state.seen.push(key);
}
export async function scan(
  input,
  { url, secret, fetcher, createRpc = (endpoint, transport) => new Rpc(endpoint, transport) } = {},
) {
  const address = normalizeAddress(input.address),
    source = input.source;
  if (!SOURCE_INFO.some((s) => s.id === source)) throw new ReadError("invalid_source");
  const rpc = createRpc(url ?? "https://rpc.mainnet.chain.robinhood.com", fetcher);
  let state;
  if (input.cursor) {
    state = await open(input.cursor, address, source, secret);
    readState(state);
    if (BigInt(await rpc.send("eth_chainId")) !== 4663n) throw new ReadError("wrong_chain");
    const snap = await rpc.send("eth_getBlockByNumber", [toHex(state.snapshot.number), false]);
    if (snap?.hash !== state.snapshot.hash) throw new ReadError("snapshot_changed");
  } else {
    let snapshot;
    if (input.snapshotCursor) {
      const frozen = await open(input.snapshotCursor, address, "snapshot", secret);
      snapshot = frozen.snapshot;
      if (BigInt(await rpc.send("eth_chainId")) !== 4663n) throw new ReadError("wrong_chain");
      const checked = await rpc.send("eth_getBlockByNumber", [toHex(snapshot.number), false]);
      if (checked?.hash !== snapshot.hash) throw new ReadError("snapshot_changed");
    } else snapshot = await rpc.snapshot();
    state = {
      version: 1,
      address,
      source,
      snapshot,
      streams: initialStreams(source, snapshot.number),
      pending: [],
      seen: [],
      warnings: [],
      turn: 0,
      initialized: false,
    };
  }
  const block = toHex(state.snapshot.number),
    rows = [],
    history = [],
    warnings = new Set(state.warnings);
  // Upgrade in-flight cursors from the fixed-window scanner without restarting
  // their snapshot or re-reading successfully covered blocks.
  for (const stream of state.streams) if (stream.sizing !== 2) {
    stream.range = Math.max(1, stream.next - stream.start + 1);
    stream.sizing = 2;
  }
  for (const target of targets[source]) await rpc.verify(target, block);
  if (source === "long") await rpc.verify(LONG_HOOK, block);
  if (source === "pons") await rpc.verify(PONS_HOOK, block);
  if (!state.initialized) {
    for (const target of targets[source].filter((t) => ["o1", "pons"].includes(t.kind))) {
      const raw =
        target.kind === "o1"
          ? await rpc.call(target.address, o1Current, "owed", [address, NATIVE], block)
          : await rpc.call(target.address, ponsEscrow, "balanceOf", [address], block);
      rows.push(await balance(rpc, state, target, NATIVE, raw));
      state.seen.push(`${target.id}:${NATIVE}`);
    }
    if (source === "pons") {
      const recipientCount = await rpc.call(
        PONS_V1.address,
        ponsV1Abi,
        "feeRecipientTokenCount",
        [address],
        block,
      );
      const deployerCount = await rpc.call(
        PONS_V1.address,
        ponsV1Abi,
        "deployerTokenCount",
        [address],
        block,
      );
      if (recipientCount > 10000n || deployerCount > 10000n) throw new ReadError("position_limit");
      state.v1Index = [
        { name: "feeRecipientTokens", count: Number(recipientCount), offset: 0 },
        { name: "deployerTokens", count: Number(deployerCount), offset: 0 },
      ];
    }
    state.initialized = true;
  }
  let work = 0;
  let examined = 0;
  const workLimit = source === "o1" ? 16 : 2;
  async function drain() {
    while (state.pending.length && work < workLimit && examined < 32) {
      const event = state.pending.shift();
      const counted = await processEvent(rpc, state, event, rows, history, warnings);
      examined++;
      // A v2 launch with another current recipient needs only one state read.
      // Do not spend a full position-processing slot on that unrelated launch.
      if (counted !== false) work++;
    }
  }
  for (const index of state.v1Index ?? []) {
    while (index.offset < index.count && work < 2) {
      const token = await rpc.call(
        PONS_V1.address,
        ponsV1Abi,
        index.name,
        [address, BigInt(index.offset)],
        block,
      );
      await ponsV1Balance(rpc, state, token, rows, warnings);
      index.offset++;
      work++;
    }
  }
  await drain();
  const pageDeadline = Date.now() + 4000;
  for (let ranges = 0; ranges < 4 && !state.pending.length && work < workLimit && examined < 32 && Date.now() < pageDeadline; ranges++) {
    let stream;
    for (let i = 0; i < state.streams.length; i++) {
      const at = (state.turn + i) % state.streams.length,
        s = state.streams[at];
      if (s.next >= s.start) {
        stream = s;
        state.turn = at + 1;
        break;
      }
    }
    if (stream) {
      const target = targets[source].find((t) => t.id === stream.target),
        abi = abiFor(target);
      const hi = stream.next, topics = streamTopics(stream, target, address);
      // Try the whole remaining history first. Narrow only on a provider limit
      // or too many relevant records, retaining the exact unprocessed boundary.
      let advanced = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const lo = Math.max(stream.start, hi - stream.range + 1);
        let logs;
        try {
          logs = await rpc.send("eth_getLogs", [
            { address: target.address, fromBlock: toHex(lo), toBlock: toHex(hi), topics },
          ]);
        } catch (error) {
          if (!["log_range", "response_limit"].includes(error.code) || stream.range === 1) throw error;
          stream.range = Math.max(1, Math.floor(stream.range / 2));
          continue;
        }
        if (!Array.isArray(logs)) throw new ReadError("invalid_response");
        let relevant = logs.map((l) => logValue(l, target, lo, hi, abi, topics))
          .filter((event) => relevantEvent(event, address));
        if (target.kind === "pons-factory" && rpc.calls && relevant.length <= 1024) {
          // The initial recipient is absent from TokenLaunched. Read its pinned
          // factory record, rather than assuming deployer === fee recipient.
          // A read-only multicall replaces one HTTP request per unrelated token.
          const matching = [];
          for (let offset = 0; offset < relevant.length; offset += 128) {
            const chunk = relevant.slice(offset, offset + 128);
            const launches = await rpc.calls(chunk.map((event) => ({address:target.address, abi:ponsFactoryAbi,
              functionName:"getLaunchedToken", args:[event.args.token]})), block);
            if (launches.length !== chunk.length) throw new ReadError("invalid_response");
            chunk.forEach((event, i) => {
              if (launches[i].exists && same(launches[i].creatorFeeRecipient, address)) matching.push(event);
            });
          }
          relevant = matching;
        }
        if (relevant.length > 128) {
          if (stream.range === 1) throw new ReadError("response_limit");
          stream.range = Math.max(1, Math.floor(stream.range / 2));
          continue;
        }
        state.pending = relevant.sort((a, b) => b.block - a.block || b.index - a.index);
        stream.next = lo - 1;
        advanced = true;
        // Result-size limits vary with historical activity. A dense period must
        // not permanently force tiny windows throughout older, sparse periods.
        if (logs.length < 512 && relevant.length < 32)
          stream.range = Math.min(state.snapshot.number + 1, stream.range * 2);
        await drain();
        break;
      }
      if (!advanced) break;
    } else break;
  }
  if (state.seen.length > 512) throw new ReadError("position_limit");
  state.warnings = [...warnings];
  const complete =
    state.streams.every((s) => s.next < s.start) &&
    !state.pending.length &&
    (state.v1Index ?? []).every((i) => i.offset >= i.count);
  return {
    source,
    snapshot: state.snapshot,
    snapshotCursor: await seal(
      { version: 1, address, source: "snapshot", snapshot: state.snapshot },
      secret,
    ),
    balances: await Promise.all(rows.map(async (row) => row.kind === "available" && BigInt(row.raw) > 0n
      ? { ...row, claimHandle: await seal({ version: 1, address, source: "claim", row }, secret) }
      : row)),
    history,
    warnings: state.warnings,
    coverage: {
      complete,
      percent: complete ? 100 : progress(state.streams, state.snapshot.number),
      blocksTotal: state.streams.reduce((n, s) => n + Math.max(0, state.snapshot.number - s.start + 1), 0),
      blocksChecked: state.streams.reduce((n, s) => n + Math.max(0, state.snapshot.number - Math.max(s.start - 1, s.next)), 0),
      pending: state.pending.length,
      oldestScannedBlock: Math.min(...state.streams.map((s) => Math.max(s.start, s.next + 1))),
    },
    cursor: complete ? null : await seal(state, secret),
  };
}
