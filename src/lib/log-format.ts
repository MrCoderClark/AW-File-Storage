// Presentation mapping for the admin Activity Logs view (spec 0018). Pure functions
// over the raw `audit_event.action` string, so both the server (filtering) and the
// client (badges) agree on how an action is categorised, labelled, and statused.

export type LogCategory =
  | "vcard"
  | "onboard"
  | "offboard"
  | "sync"
  | "error"
  | "user"
  | "file"
  | "other";

const CATEGORY: Record<string, LogCategory> = {
  "vcard.published": "vcard",
  "vcard.edited": "vcard",
  "card.auto_created": "onboard",
  "member.added": "onboard",
  "member.joined": "onboard",
  "member.invited": "onboard",
  "member.invite_resent": "onboard",
  "card.offboarded": "offboard",
  "card.auto_unpublished": "offboard",
  "card.offboard_purged": "offboard",
  "vcard.unpublished": "offboard",
  "member.removed": "offboard",
  "member.suspended": "offboard",
  "member.invite_revoked": "offboard",
  "o365.synced": "sync",
  "o365.cleared": "sync",
  "o365.sync_failed": "error",
  "member.role_changed": "user",
  "member.reactivated": "user",
  "member.sessions_revoked": "user",
  "member.password_reset_sent": "user",
  "member.password_set": "user",
  "member.two_factor_reset": "user",
  "import.rate_limit_changed": "user",
  "import.rate_reset": "user",
  "file.deleted": "file",
  "file.renamed": "file",
  "file.link_created": "file",
};

const CATEGORY_LABEL: Record<LogCategory, string> = {
  vcard: "VCard Generation",
  onboard: "Onboarding",
  offboard: "Offboarding",
  sync: "O365 Sync",
  error: "Sync Error",
  user: "User Management",
  file: "File",
  other: "System",
};

const ACTION_PHRASE: Record<string, string> = {
  "vcard.published": "Card published",
  "vcard.edited": "Card edited",
  "vcard.unpublished": "Card unpublished",
  "card.auto_created": "Card auto-created from Office 365",
  "card.auto_unpublished": "Card auto-unpublished",
  "card.offboarded": "Card retracted (user offboarded)",
  "card.offboard_purged": "Card deleted after grace period",
  "o365.synced": "Office 365 attribute synced",
  "o365.cleared": "Office 365 attribute cleared",
  "o365.sync_failed": "Office 365 sync failed",
  "member.added": "Member added",
  "member.joined": "Member accepted invitation",
  "member.invited": "Member invited",
  "member.invite_resent": "Invitation resent",
  "member.invite_revoked": "Invitation revoked",
  "member.removed": "Member removed",
  "member.suspended": "Member suspended",
  "member.reactivated": "Member reactivated",
  "member.role_changed": "Member role changed",
  "member.sessions_revoked": "Sessions revoked",
  "member.password_reset_sent": "Password reset link sent",
  "member.password_set": "Password set",
  "member.two_factor_reset": "Two-factor reset",
  "import.rate_limit_changed": "Import limit changed",
  "import.rate_reset": "Import limit reset",
  "file.deleted": "File deleted",
  "file.renamed": "File renamed",
  "file.link_created": "Download link created",
};

/** All actions belonging to a category — for the server-side filter. */
export function actionsForCategory(category: LogCategory): string[] {
  return Object.entries(CATEGORY)
    .filter(([, c]) => c === category)
    .map(([action]) => action);
}

export function logCategory(action: string): LogCategory {
  return CATEGORY[action] ?? "other";
}

export function logCategoryLabel(action: string): string {
  return CATEGORY_LABEL[logCategory(action)];
}

/** A friendly one-line phrase for the action (falls back to the raw action). */
export function logActionPhrase(action: string): string {
  return ACTION_PHRASE[action] ?? action;
}

/** Success unless the action names a failure. */
export function logStatus(action: string): "success" | "failed" {
  return logCategory(action) === "error" ? "failed" : "success";
}

/**
 * A short human detail pulled from the audit metadata JSON — the most useful of a
 * handful of common keys (name, email, slug, role, url), else empty. Never throws.
 */
export function logDetail(metadataJson: string | null): string {
  if (!metadataJson) return "";
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  // A numeric before/after change (spec 0029 import.rate_limit_changed) reads as
  // "5 → 20"; a null side is the env default. Keyed on from/to so only this event
  // matches (member.role_changed uses before/after and is unaffected).
  if ("from" in meta || "to" in meta) {
    const fmt = (v: unknown): string => (v == null ? "default" : String(v));
    return `${fmt(meta.from)} → ${fmt(meta.to)}`;
  }
  const pick = (k: string): string | null =>
    typeof meta[k] === "string" && (meta[k] as string).trim()
      ? (meta[k] as string)
      : null;
  // Deliberately not `url` — a long .vcf URL is unreadable and, being one unbreakable
  // token, blows out the table width. The route falls back to the resolved target
  // name (e.g. the card's contact) instead, which reads far better.
  return pick("name") ?? pick("email") ?? pick("slug") ?? pick("role") ?? "";
}
