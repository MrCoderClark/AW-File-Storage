import { getRailData } from "@/server/rail";

// Left-rail data (storage usage, today's upload history, recent activity).
// Fetched on load and re-fetched after an upload settles so the rail updates
// without a page refresh (spec 0004 AC-10).
export async function GET() {
  const data = await getRailData();
  if (!data) return new Response("Unauthorized", { status: 401 });
  return Response.json({ ok: true, ...data });
}
