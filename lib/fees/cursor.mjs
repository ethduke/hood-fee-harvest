import { ReadError } from "./model.mjs";
const encoder = new TextEncoder();
let transient;
function keyBytes(secret) {
  if (secret && secret.length >= 32) return encoder.encode(secret);
  transient ??= crypto.getRandomValues(new Uint8Array(32));
  return transient;
}
function base64(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value) {
  try {
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new ReadError("cursor_expired");
  }
}
async function hmac(secret) {
  return crypto.subtle.importKey(
    "raw",
    keyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function seal(state, secret) {
  const payload = encoder.encode(JSON.stringify({ ...state, expires: Date.now() + 86400000 }));
  if (payload.length > 60000) throw new ReadError("position_limit");
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(secret), payload));
  return `${base64(payload)}.${base64(signature)}`;
}
export async function open(cursor, address, source, secret) {
  if (typeof cursor !== "string" || cursor.length > 85000 || !/^[\w-]+\.[\w-]+$/.test(cursor))
    throw new ReadError("cursor_expired");
  const [p, s] = cursor.split(".");
  const payload = decode(p);
  if (!(await crypto.subtle.verify("HMAC", await hmac(secret), decode(s), payload)))
    throw new ReadError("cursor_expired");
  let state;
  try {
    state = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new ReadError("cursor_expired");
  }
  if (
    state.address !== address ||
    state.source !== source ||
    state.expires < Date.now() ||
    state.version !== 1
  )
    throw new ReadError("cursor_expired");
  return state;
}
