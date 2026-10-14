import { confirmClaimResponse } from "../../../../lib/fees/api.mjs";
export function POST(request: Request) {
  return confirmClaimResponse(request, {
    url: process.env.ROBINHOOD_RPC_URL || undefined,
    secret: process.env.SCAN_CURSOR_SECRET || undefined,
  });
}
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
