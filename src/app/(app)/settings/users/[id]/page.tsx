import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MemberActions } from "@/components/member-actions";
import { formatBytes, timeAgo } from "@/lib/format";
import { getMemberDetail } from "@/server/members";
import { getActor } from "@/server/session";

export const dynamic = "force-dynamic";

// Member detail (spec 0005 AC-10, AC-11). Owner/admin only; org-scoped.
export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor?.canManageAny) notFound();

  const { env } = getCloudflareContext();
  const member = await getMemberDetail(env as unknown as { DB: D1Database }, {
    orgId: actor.orgId,
    memberId: id,
  });
  if (!member) notFound();

  const isSelf = member.userId === actor.userId;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/settings/members"
        className="text-sm text-accent-500 hover:underline"
      >
        ← Back to members
      </Link>

      <div className="mt-3 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-600/10 text-sm font-semibold text-brand-600">
          {initials(member.name)}
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">
            {member.name}
            {isSelf && (
              <span className="ml-2 text-sm font-normal text-muted-500">
                (you)
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-500">{member.email}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-600">
            {member.role}
          </span>
          {member.status === "active" ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Active
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              Suspended
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Panel title="Sign-in">
          <Row label="Last sign-in">
            {member.signIn.lastSignInAt
              ? timeAgo(member.signIn.lastSignInAt)
              : "Never"}
          </Row>
          <Row label="Active sessions">{member.signIn.activeSessions}</Row>
          <Row label="Failed attempts">{member.signIn.failedCount}</Row>
          <Row label="Locked until">
            {member.signIn.lockedUntil
              ? new Date(member.signIn.lockedUntil).toLocaleString()
              : "Not locked"}
          </Row>
          <Row label="Joined">{timeAgo(member.joinedAt)}</Row>
        </Panel>

        <Panel title="Storage footprint">
          <Row label="Files uploaded">{member.storage.files}</Row>
          <Row label="Total size">{formatBytes(member.storage.bytes)}</Row>
          <Row label="Published cards">{member.storage.published}</Row>
        </Panel>

        <Panel title="Security" className="sm:col-span-2">
          <Row label="Two-factor">
            {member.security.twoFactorEnabled ? "Enrolled" : "Not enrolled"}
          </Row>
          <Row label="Two-factor required">
            {member.security.twoFactorRequired ? "Yes" : "No"}
          </Row>
        </Panel>
      </div>

      {!isSelf && (
        <MemberActions
          memberId={member.id}
          memberName={member.name}
          twoFactorRequired={member.security.twoFactorRequired}
          twoFactorEnabled={member.security.twoFactorEnabled}
        />
      )}
    </div>
  );
}

function Panel({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-[--radius-panel] border border-border bg-surface p-5 ${className}`}
    >
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <dl className="mt-3 space-y-2">{children}</dl>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-500">{label}</dt>
      <dd className="font-medium text-slate-800">{children}</dd>
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "•"
  );
}
