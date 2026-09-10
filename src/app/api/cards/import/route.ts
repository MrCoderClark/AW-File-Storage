import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type CardImportEnv,
  createCardImport,
  ImportError,
  kickDrain,
  type MappedRow,
} from "@/server/card-import";
import { requireApiRole } from "@/server/session";

// Accept a bulk contact-card import (spec 0028). Any signed-in member of the active org
// may run one. The browser parsed + mapped the spreadsheet and sends ONLY the mapped
// rows as JSON (never the raw file); the server re-validates every row, stores the run,
// and a scheduled drain publishes the valid ones. Idempotent on the client `importId`.
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const auth = await requireApiRole("member");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    importId?: string;
    rows?: MappedRow[];
  };
  const importId = (body.importId ?? "").trim();
  if (!UUID_RE.test(importId)) {
    return Response.json(
      { ok: false, error: "A valid import id is required." },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.rows)) {
    return Response.json(
      { ok: false, error: "Rows are required." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  const cfEnv = env as unknown as CardImportEnv;
  try {
    const result = await createCardImport(
      cfEnv,
      auth.actor.orgId,
      auth.actor.userId,
      importId,
      body.rows,
    );
    // Start publishing right away, in-process in the background (on-demand drain, no
    // periodic cron). Only kick when there is work left to do.
    if (result.status === "pending" || result.status === "processing") {
      kickDrain(cfEnv);
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ImportError) {
      return Response.json(
        { ok: false, error: e.message },
        { status: e.status },
      );
    }
    throw e;
  }
}
