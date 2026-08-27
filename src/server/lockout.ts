import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { accountLock, user as userTable } from "./db/schema";

/**
 * Per-account sign-in lockout (spec 0001 AC-7): 5 consecutive failures lock the
 * account for 15 minutes, doubling on each further lockout to a 24h cap; a
 * success clears the counter. Keyed by user id (not org-scoped: it runs before
 * any organization is known), so it uses the raw db, which the auth layer may.
 *
 * This is layered ON TOP of Better Auth's IP/route rate limiter — the limiter
 * blunts distributed floods, this stops a targeted single-account attack.
 */
const MAX_FAILURES = 5;
const BASE_LOCK_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCK_MS = 24 * 60 * 60 * 1000; // 24 hours

async function userIdByEmail(db: Db, email: string) {
  const [u] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email.toLowerCase()))
    .limit(1);
  return u?.id;
}

async function upsertLock(
  db: Db,
  userId: string,
  values: { failedCount: number; lockLevel: number; lockedUntil: Date | null },
) {
  await db
    .insert(accountLock)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: accountLock.userId, set: values });
}

/** True if the account for `email` is currently locked. Unknown emails are never "locked". */
export async function isLocked(db: Db, email: string): Promise<boolean> {
  const userId = await userIdByEmail(db, email);
  if (!userId) return false;
  const [lock] = await db
    .select()
    .from(accountLock)
    .where(eq(accountLock.userId, userId))
    .limit(1);
  return !!lock?.lockedUntil && new Date(lock.lockedUntil).getTime() > Date.now();
}

/** Record a failed attempt; lock (with doubling) once the threshold is reached. */
export async function recordFailure(db: Db, email: string): Promise<void> {
  const userId = await userIdByEmail(db, email);
  if (!userId) return; // don't create locks for non-existent accounts
  const [lock] = await db
    .select()
    .from(accountLock)
    .where(eq(accountLock.userId, userId))
    .limit(1);

  const failedCount = (lock?.failedCount ?? 0) + 1;
  if (failedCount >= MAX_FAILURES) {
    const lockLevel = (lock?.lockLevel ?? 0) + 1;
    const duration = Math.min(BASE_LOCK_MS * 2 ** (lockLevel - 1), MAX_LOCK_MS);
    await upsertLock(db, userId, {
      failedCount: 0,
      lockLevel,
      lockedUntil: new Date(Date.now() + duration),
    });
  } else {
    await upsertLock(db, userId, {
      failedCount,
      lockLevel: lock?.lockLevel ?? 0,
      lockedUntil: lock?.lockedUntil ?? null,
    });
  }
}

/** Clear the counter and any lock on a successful sign-in. */
export async function clearFailures(db: Db, email: string): Promise<void> {
  const userId = await userIdByEmail(db, email);
  if (!userId) return;
  await upsertLock(db, userId, {
    failedCount: 0,
    lockLevel: 0,
    lockedUntil: null,
  });
}
