# 0001. Secure file storage platform on Cloudflare, decision record

The reasoning behind [index.md](index.md). A build never needs to read this file.

## Context

> ⚠️ Premise note: **R2 cannot host the application.** The original ask was to host the app on Cloudflare R2. R2 is object storage only. It can serve static files on a custom domain, but it has no compute, so it cannot render pages, set a session cookie, or sign a private download link. An app deployed as static files in a bucket therefore cannot have a real login at all, and the only way to keep the bucket private would be to make it public. The correct framing on Cloudflare is Workers for the app with R2 bound to it as storage, which is exactly what the dashboard offers under "Create app". This spec is written that way.

> ⚠️ Premise note: **Writing our own login is the highest risk decision here.** Authentication is one of the few areas where an ordinary looking mistake is a breach rather than a bug. The list of things that must all be right is long and unforgiving: password hashing parameters, timing safe comparison, session token entropy, cookie flags, session fixation on login, revocation, reset token single use and expiry, user enumeration through error messages and response timing, cross site request forgery on every mutating action, and lockout that resists both a targeted attack and a distributed one. A proven library or hosted service (Better Auth self hosted, or Clerk hosted) delivers all of that in an afternoon, and neither was ruled out by a regulatory constraint, only by preference. The engineer chose to write it anyway, so child spec 0001 specifies every one of those items concretely rather than leaving them to be invented mid build, and a follow up requires an independent review. This is the mitigation, not a resolution: the risk is accepted, deliberately, and it is real.

> ⚠️ Premise note: **This topic spans several independent decisions.** The stack, the login system, the tenancy model and schema, the upload and publish pipeline, and the Upload Center screen are each separately implementable and separately wrong in different ways. This spec is therefore an umbrella: the stack decision here, four child specs beside it. Trying to hold all five in one file would have made none of them reviewable.

**The problem.** There is no application yet, only a design mock at `docs/Designs/mock1.jpg` and a goal: internal staff sign in, upload files, and a `.vcf` contact card ends up at a public web address anyone can open. The repository is empty. There is no `AGENTS.md`, no git history, and no code, so every layer is an open choice and nothing constrains us except the platform already in hand.

**The forces.**

*The public address is the actual product.* A vCard address will be printed on business cards and encoded in QR codes. That means it must be stable for years, cheap to serve at unpredictable volume, and fast from a phone on mobile data. It also means replacing the file behind an address must not change the address, and the address must be servable without waking up any of our code.

*Private by default is a hard requirement, and it conflicts with the public one.* Everything that is not a vCard stays private. A design that keeps public and private files in one bucket relies on our own access checks being correct on every path, forever. A design with two buckets relies on the platform, which is a much shorter list of things that can go wrong.

*The team is small and the platform is already chosen.* Cloudflare is where the domain, the account, and the intended storage already live. Adding a second cloud for the database or the app means cross network calls, a second bill, a second set of credentials, and a public database endpoint to defend. Reuse of what is already there beats the marginally better tool somewhere else.

*Enterprise shape from day one, at a small scale.* The mock is an enterprise dashboard: organizations, roles, storage quotas, upload history, activity. Fewer than a hundred users are expected, so nothing here needs to scale hard. But organization isolation is load bearing: adding an `org_id` column after launch means rewriting every query, every index, and every access check, and it is the one thing on this list that cannot be retrofitted cheaply.

*Contact data is personal data.* A published vCard contains a real person's name, phone number, and email address. Publishing is intentional and is the product, but it still needs to be a deliberate, recorded, reversible act rather than a side effect nobody can account for later.

**The consequence of not deciding.** Every one of these choices ends up made implicitly by whoever writes the first file, and the two that cannot be undone cheaply (organization isolation, and whether public and private files share a bucket) are exactly the two most likely to be got wrong in a hurry.

## Options considered

Full stacks, not individual tools.

### Option 1: All on Cloudflare, Next.js on Workers with D1 and R2, login written in house

Next.js runs on Cloudflare Workers through the OpenNext adapter. Records live in D1 (SQLite on Cloudflare) reached through Prisma's D1 driver adapter. Files live in two R2 buckets, one private and one public on `contacts.americaworks.com`. Login is ours: session rows in D1, PBKDF2 hashing through the runtime's own Web Crypto, optional TOTP.

**Pros**:
- One platform, one account, one bill, one deploy. R2 and D1 are bound directly to the Worker, so there is no public database endpoint and no egress charge between app and storage.
- The public vCard address is served straight from the bucket through the Cloudflare cache, with no compute in the request path at all, which is the cheapest and fastest possible answer to the core product requirement.
- No per user identity fee, ever, and every user row stays in our own database.
- Matches exactly what the engineer chose, so nothing about it is a surprise later.

**Cons**:
- We own every authentication and session bug we write. This is the dominant risk of the whole plan.
- D1 is SQLite with real caps on database size, write concurrency, and result size. It is comfortable for this workload and awkward the moment reporting gets serious.
- Prisma on D1 depends on a preview driver adapter, cannot apply its own migrations, and adds weight to a Worker bundle that has a hard size limit.
- The OpenNext adapter sits between us and Next.js releases, so an upgrade can be blocked by the adapter.

### Option 2: All on Cloudflare, but with a proven auth library instead of our own

Identical to option 1 in every layer except one: Better Auth, self hosted, with its D1 adapter and its organization plugin, replaces the hand written login.

**Pros**:
- The dangerous parts (hashing, session rotation, reset tokens, verification, lockout) are already written, already reviewed, and already attacked by people other than us.
- Its organization plugin covers most of the tenancy requirement, so organizations, roles, and invitations largely come for free.
- Still self hosted and still no per user fee: the user and session rows live in our D1 exactly as in option 1.
- Roughly two weeks of build and review time returned to the actual product.

**Cons**:
- A dependency in the most sensitive part of the system, with its release cadence and its breaking changes.
- Its conventions dictate part of our schema, so our user and session tables are shaped by it rather than by us.
- Less complete control over unusual requirements later.

### Option 3: Next.js on Vercel, Neon Postgres, Clerk, R2 for files

The mainstream managed path. Vercel runs the app, Neon provides Postgres, Clerk provides identity with organizations and roles built in, R2 keeps the files.

**Pros**:
- Lowest total build effort and lowest risk by a wide margin. Identity, organizations, invitations, and roles are configuration rather than code.
- Real Postgres, with proper JSON, full text search, and per pull request database branching.
- The smoothest possible Next.js experience, with no adapter between us and the framework.

**Cons**:
- Three vendors and three bills, and Clerk charges per monthly active user.
- The app is no longer beside the storage: every database call and every R2 signing call crosses a network boundary out of Cloudflare.
- Contradicts the engineer's stated choices on hosting, database, and auth.

### Option 4: Static site in R2, no server at all

Export the Next.js app to static files, drop them in a public R2 bucket on a custom domain, and let the browser talk to R2 directly.

**Pros**:
- Almost nothing to operate, and effectively free to run.
- Literally what the original question asked for.

**Cons**:
- No server means no secure login, no private bucket, and no server side validation. Any credential the browser holds is a credential an attacker holds.
- Fails the private by default requirement outright, and fails the organization requirement completely.
- Listed only to record why it was rejected.

## Rationale

**Update (2026-08-26): the auth decision moved from Option 1 to Option 2.** The stack below is otherwise Option 1, with two changes the engineer approved after the first draft: login is now Better Auth (self hosted) rather than hand written, and the database toolkit is Drizzle rather than Prisma on D1. Both changes take the recommendation this document already made. The options are left intact below as the record of why. The paragraphs that follow describe Option 1 as originally chosen; read them together with this note.

**Option 1's stack is the foundation, and it is the engineer's stack.** Every layer of it answers a specific force from Context. Cloudflare only, because the domain, the account, and the intended storage are already there, and binding R2 and D1 to the Worker removes both the egress cost and the publicly reachable database that a split cloud would create. Two buckets rather than one, because private by default is a hard requirement and a bucket with no public domain is enforced by the platform, whereas one shared bucket is enforced only by our own code being right on every path forever. The public bucket on a custom domain, because a printed QR code needs an address that outlives every internal refactor and is served without waking our code. Organization isolation in the first migration, because it is the only decision on the list that cannot be retrofitted without rewriting every query. A single layered application rather than services, because there are fewer than five engineers and no measured bottleneck, and a monolith can be split later while services cannot easily be merged back.

**Both of the places where my recommendation differed from the first draft were subsequently taken, and I want the reasoning on the record.** The first draft chose to write authentication from scratch; option 2 was the right answer and is now the decision. Building authentication correctly is genuinely hard, and the failure mode is a breach rather than a bug, so the usual advice is to use a proven library unless a regulation forbids it, which nothing here does. Better Auth keeps every stated benefit (self hosted, no per user fee, our data in our D1) while moving the dangerous primitives to code that other people also review and attack. The residual risk is real but far shorter: configuring the library correctly and keeping it patched, rather than implementing hashing, session rotation, and reset tokens ourselves. Child spec 0001 pins that configuration and the hardening added on top, and a follow up item requires a review of `src/server/auth.ts` against it. The same reasoning, at much lower stakes, moved the database toolkit from Prisma on D1 to Drizzle: Drizzle is the low friction pairing with a D1 binding and the first class choice for Better Auth's adapter, while Prisma reaches D1 only through a preview adapter, cannot apply its own migrations, and is heavier in a size limited Worker bundle.

**The remaining calls were mine to make, and here they are with their runners up.** Presigned uploads straight from the browser to the private bucket, because it takes Worker request limits and CPU time out of the upload path entirely; the runner up, proxying bytes through the Worker with the R2 binding, is simpler to write and puts a ceiling on file size. A staging prefix that the browser writes to, with the server validating and only then copying into the public bucket, because letting a browser write directly into a public bucket means whatever holds that signed link decides what the public sees; the runner up, presigning straight into the public bucket, is one fewer step and gives up all server side validation. (The session token and password hashing calls in this paragraph's original draft are now moot: Better Auth owns both — opaque database sessions with instant revocation, and scrypt hashing — so they are no longer ours to choose. See the update note above and child 0001.) Resend for email over Amazon SES, because the volume is tiny and the setup and sending reputation work SES demands buys nothing at this size. Optional TOTP that admins must enrol, because the data is other people's contact details and the schema for it costs nothing to include now and a migration to add later.
