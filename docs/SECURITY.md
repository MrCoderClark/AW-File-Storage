# Security Audit & Remediation — OpenNext / Cloudflare Application

I need you to perform a comprehensive security audit of this application.

## Application Architecture

This is a Next.js application deployed using OpenNext on Cloudflare.

The application has:

- Next.js / OpenNext
- Cloudflare Workers
- Cloudflare R2 file storage
- Database access
- API routes / server-side functionality
- Authentication and user sessions
- Potentially privileged/admin functionality
- File upload/download functionality
- Environment variables and secrets
- Cloudflare-specific bindings/configuration

Your job is to audit the application as if you were performing a professional application security review.

---

# IMPORTANT RULES

### 1. DO NOT blindly modify the application

Start with an audit.

Do not immediately make changes.

First inspect the architecture, source code, configuration, dependencies, database access, authentication, authorization, API endpoints, file handling, and Cloudflare configuration.

After the audit, present your findings and recommended fixes.

Only make changes after you have identified what needs to be changed.

### 2. Do not expose secrets

Never print, copy, or commit:

- API keys
- passwords
- database credentials
- Cloudflare API tokens
- JWT secrets
- encryption keys
- OAuth secrets
- session secrets
- R2 credentials
- private keys
- values from production environment variables

You may inspect how environment variables are used, but redact their actual values.

### 3. Preserve functionality

Security fixes must not unnecessarily change application behavior.

Before modifying code, understand how the existing feature works.

Prefer minimal, targeted security fixes.

### 4. Do not assume the application is secure because authentication exists

Explicitly test for authorization problems and IDOR/BOLA vulnerabilities.

A logged-in user should not automatically have access to another user's:

- files
- records
- database rows
- API resources
- admin functions
- organization data
- account information

---

# PHASE 1 — ARCHITECTURE RECONNAISSANCE

First map the application.

Identify:

- Next.js version
- OpenNext version
- React version
- Node/runtime requirements
- Cloudflare Workers configuration
- Wrangler configuration
- R2 bindings
- KV/D1/Hyperdrive/database bindings if present
- External databases
- Authentication mechanism
- Session mechanism
- Middleware
- API routes
- Server Actions
- Route Handlers
- Server Components
- Client Components
- Admin routes
- File upload/download routes
- Webhooks
- Cron jobs
- Background jobs
- External APIs
- OAuth integrations
- Email integrations
- Payment-related functionality, if any

Create a high-level architecture diagram in text showing:

User
→ Cloudflare
→ OpenNext / Worker
→ Next.js routes
→ Authentication
→ Database
→ R2
→ External services

Identify all trust boundaries.

---

# PHASE 2 — DEPENDENCY SECURITY

Inspect:

- package.json
- package-lock.json / pnpm-lock.yaml / yarn.lock
- wrangler configuration
- OpenNext configuration
- Next.js configuration
- TypeScript configuration
- ESLint configuration
- build/deployment configuration

Look for:

- outdated dependencies
- known CVEs
- vulnerable transitive dependencies
- packages with known security issues
- unnecessary dependencies
- packages with excessive privileges
- deprecated authentication/security libraries

Run appropriate package security audits where possible.

For example:

npm audit

or the appropriate package manager equivalent.

Do not automatically upgrade every dependency.

Identify upgrades that are actually security relevant.

For every vulnerable dependency provide:

- package
- current version
- vulnerable version range
- severity
- vulnerability/CVE if applicable
- affected functionality
- recommended version
- breaking-change risk

---

# PHASE 3 — AUTHENTICATION SECURITY

Audit authentication thoroughly.

Determine:

- How users log in
- How passwords are handled
- How sessions are created
- Where sessions are stored
- How session expiration works
- How logout works
- Whether sessions can be revoked
- Cookie configuration
- CSRF protections
- Password reset functionality
- Email verification
- Account registration
- Login rate limiting
- Brute-force protection
- Session fixation protection
- Token expiration
- Refresh token handling

Check cookies for:

- HttpOnly
- Secure
- SameSite
- appropriate expiration
- appropriate domain/path

Look for:

- authentication bypass
- weak session validation
- predictable tokens
- tokens stored in localStorage unnecessarily
- JWT validation problems
- accepting unsigned/incorrectly signed JWTs
- algorithm confusion
- missing expiration validation
- session fixation
- privilege escalation
- password reset abuse
- account enumeration

---

# PHASE 4 — AUTHORIZATION / IDOR / BOLA

This is a HIGH PRIORITY area.

Find every endpoint that accepts identifiers such as:

- userId
- accountId
- organizationId
- fileId
- documentId
- recordId
- projectId
- folderId
- bucket key
- database primary key

Determine whether the server verifies that the authenticated user is authorized to access that specific resource.

Look specifically for patterns like:

GET /api/files/:id

GET /api/users/:id

GET /api/documents/:id

DELETE /api/files/:id

PATCH /api/records/:id

where the ID comes from the client.

Do NOT assume that hiding IDs or using UUIDs is sufficient.

Test the authorization logic conceptually and identify whether a user could change an ID and access another user's resource.

Look for:

- IDOR
- BOLA
- horizontal privilege escalation
- vertical privilege escalation
- tenant isolation failures
- organization boundary failures
- admin authorization flaws

For multi-tenant functionality, verify that every database query properly scopes data to the authenticated user's organization/tenant.

---

# PHASE 5 — DATABASE SECURITY

Audit every database query.

Look for:

- SQL injection
- unsafe raw SQL
- unsafe query construction
- string interpolation
- missing authorization conditions
- missing tenant/user filters
- excessive database privileges
- sensitive data exposure
- insecure database connection handling

If using an ORM, determine whether raw queries are being used.

Pay special attention to:

- $queryRaw
- $executeRaw
- dynamic SQL
- dynamically constructed WHERE clauses
- dynamic table/column names

Verify that server-side authorization occurs BEFORE sensitive database data is returned.

Do not rely solely on frontend filtering.

---

# PHASE 6 — CLOUDFLARE R2 / FILE STORAGE SECURITY

This is another HIGH PRIORITY area.

Audit all file operations.

Identify:

- upload endpoints
- download endpoints
- delete endpoints
- list endpoints
- metadata endpoints
- signed URL generation
- R2 bucket access
- object key construction
- file ownership checks

Check for:

### Unauthorized file access

Can a user access another user's file by changing:

- object key
- file ID
- filename
- URL
- signed URL parameters

### Path/object key manipulation

Look for unsafe object key construction.

### Signed URLs

Verify:

- expiration time
- permissions
- scope
- HTTP method restrictions where applicable
- whether URLs can be reused
- whether URLs expose more access than intended

### File uploads

Check:

- file size limits
- MIME type validation
- extension validation
- filename sanitization
- malicious filenames
- executable content
- HTML/SVG uploads
- JavaScript uploads
- ZIP files
- decompression bombs
- oversized uploads
- storage exhaustion
- duplicate uploads
- unrestricted content types

Do not trust:

- Content-Type
- file extension
- client-provided filename

Where appropriate, inspect file signatures/magic bytes.

Determine whether uploaded files are ever served directly from a domain where they could execute as active content.

Pay particular attention to:

- HTML
- SVG
- JavaScript
- PDF
- image formats

---

# PHASE 7 — API SECURITY

Inventory every API endpoint.

For each endpoint document:

- method
- route
- authentication required?
- authorization required?
- accepted parameters
- database access
- R2 access
- external services
- rate limiting
- validation
- sensitive response data

Look for:

- missing authentication
- missing authorization
- mass assignment
- parameter tampering
- excessive data exposure
- insecure defaults
- improper error handling
- API abuse
- rate-limit bypass
- resource exhaustion
- unsafe HTTP methods
- CORS problems

Check whether sensitive endpoints can be called directly without going through the expected frontend.

---

# PHASE 8 — INPUT VALIDATION

Audit all user-controlled input.

Sources include:

- query parameters
- path parameters
- request bodies
- headers
- cookies
- uploaded filenames
- uploaded metadata
- form fields
- Server Actions
- API requests
- webhook payloads

Look for:

- SQL injection
- XSS
- command injection
- SSRF
- template injection
- path traversal
- prototype pollution
- unsafe deserialization
- malicious redirects
- header injection

Verify that validation occurs server-side.

Prefer established validation libraries where appropriate.

---

# PHASE 9 — XSS / HTML SECURITY

Search for:

- dangerouslySetInnerHTML
- raw HTML rendering
- markdown rendering
- HTML sanitization
- user-generated content
- unsanitized URLs
- iframe embedding
- uploaded HTML/SVG content

Determine whether stored XSS is possible.

Also check:

- Content-Security-Policy
- X-Content-Type-Options
- Referrer-Policy
- frame protection
- Permissions-Policy

Recommend appropriate security headers.

Do not blindly add a CSP that breaks the application.

First determine what resources the application actually requires.

---

# PHASE 10 — SSRF

Look for server-side requests where the destination URL can be influenced by the user.

Examples:

- URL importers
- image fetchers
- document fetchers
- webhook testers
- proxy endpoints
- remote file import
- URL previews

Check whether attackers could make the server request:

- localhost
- 127.0.0.1
- private IP ranges
- Cloudflare/internal services
- cloud metadata endpoints
- internal admin endpoints

Validate and restrict outbound destinations where appropriate.

---

# PHASE 11 — CSRF

Determine whether state-changing operations are vulnerable to CSRF.

Pay special attention to:

- cookie-based authentication
- POST
- PUT
- PATCH
- DELETE
- Server Actions
- account changes
- password changes
- file deletion
- administrative actions

Determine whether SameSite cookies and/or CSRF tokens provide adequate protection.

---

# PHASE 12 — ADMIN SECURITY

Find all administrative functionality.

Identify:

- admin routes
- admin APIs
- role checks
- permission checks
- privileged database queries
- user-management functionality
- organization-management functionality
- file-management functionality

Verify that admin authorization happens server-side.

Look for cases where:

- frontend hides an admin button
- but the API still allows the action

Test for privilege escalation from:

- normal user → admin
- user → another organization
- user → another account

---

# PHASE 13 — SECRETS / ENVIRONMENT VARIABLES

Search the repository for accidentally exposed secrets.

Check for:

- API keys
- passwords
- tokens
- private keys
- database URLs
- Cloudflare credentials
- JWT secrets
- OAuth secrets

Check:

- .env
- .env.local
- .env.production
- wrangler.toml
- wrangler.json
- source code
- configuration files
- Git history if available

Pay special attention to variables prefixed with:

NEXT*PUBLIC*

Determine whether any sensitive server-side secret has accidentally been exposed to the browser.

DO NOT print actual secret values.

---

# PHASE 14 — CLOUDFLARE CONFIGURATION

Audit Cloudflare-specific configuration.

Check:

- Worker configuration
- R2 bindings
- routes
- domains
- environment configuration
- CORS
- cache configuration
- caching of authenticated responses
- security headers
- Durable Objects if used
- KV if used
- D1 if used
- Hyperdrive if used
- Queues if used
- Cron triggers if used

VERY IMPORTANT:

Verify that authenticated/personalized responses cannot accidentally be cached and served to another user.

Check for cache poisoning and cache key problems.

---

# PHASE 15 — CORS

Audit all CORS configuration.

Look for:

- Access-Control-Allow-Origin: \*
- reflecting arbitrary Origin headers
- allowing credentials with unsafe origins
- overly broad allowed methods
- overly broad allowed headers

Determine which origins actually need access.

Do not recommend wildcard CORS if authentication credentials are involved.

---

# PHASE 16 — ERROR HANDLING / INFORMATION DISCLOSURE

Check whether production responses expose:

- stack traces
- SQL errors
- database schema
- internal IDs
- filesystem paths
- environment variables
- Cloudflare internals
- debugging information
- dependency versions

Verify that logs do not contain:

- passwords
- access tokens
- session tokens
- signed URLs
- sensitive personal information

---

# PHASE 17 — RATE LIMITING / ABUSE

Identify security-sensitive operations that require rate limiting:

- login
- registration
- password reset
- email verification
- file uploads
- file downloads
- API endpoints
- expensive database queries
- search
- invitations
- email sending
- external API calls

Determine whether Cloudflare-based rate limiting or application-level rate limiting would be appropriate.

Pay special attention to endpoints that could create:

- database records
- R2 objects
- emails
- external API requests

---

# PHASE 18 — BUSINESS LOGIC SECURITY

Do not limit the audit to traditional vulnerabilities.

Look for business logic issues such as:

- bypassing workflow requirements
- modifying records that should be immutable
- deleting records without permission
- manipulating quotas
- bypassing subscription/plan limits
- accessing resources after account removal
- changing organization ownership
- changing another user's role
- replaying operations
- duplicate submissions
- race conditions
- concurrent requests causing inconsistent state

---

# PHASE 19 — SECURITY HEADERS

Determine which security headers are currently present.

Evaluate:

- Content-Security-Policy
- Strict-Transport-Security
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
- frame-ancestors / clickjacking protection

Recommend headers based on the actual application architecture.

Do not blindly copy a generic security-header configuration.

---

# PHASE 20 — SOURCE CODE PATTERN SEARCH

Perform targeted searches for security-sensitive patterns, including but not limited to:

- dangerouslySetInnerHTML
- eval(
- new Function(
- child_process
- exec(
- spawn(
- shell commands
- fetch(
- axios
- raw SQL
- $queryRaw
- $executeRaw
- redirect(
- cookies(
- headers(
- Authorization
- Bearer
- JWT
- token
- session
- signed URL
- getSignedUrl
- R2
- putObject
- deleteObject
- NEXT*PUBLIC*
- process.env
- Server Actions
- middleware
- admin
- role
- permission
- userId
- organizationId
- fileId

Also inspect dynamic imports and any code that processes external data.

---

# PHASE 21 — SECURITY REPORT

After completing the audit, produce a report.

Classify every finding as:

CRITICAL
HIGH
MEDIUM
LOW
INFORMATIONAL

For every vulnerability provide:

### Finding

Short descriptive title.

### Severity

Critical / High / Medium / Low / Informational

### Location

Exact file and line number(s).

### Description

Explain the vulnerability clearly.

### Attack scenario

Explain how an attacker could exploit it.

### Impact

Explain what an attacker could gain or modify.

### Evidence

Show the relevant code pattern, but NEVER expose secrets.

### Recommended fix

Explain exactly how it should be fixed.

### Fix complexity

Low / Medium / High

### Regression risk

Low / Medium / High

### Verification

Explain how we can verify the fix.

---

# PHASE 22 — PRIORITIZED REMEDIATION PLAN

At the end provide:

## Fix Immediately

Critical and high-risk vulnerabilities.

## Fix Soon

Medium-risk vulnerabilities.

## Hardening

Lower-risk improvements.

Then provide the recommended implementation order.

Example:

1. Fix authorization/IDOR
2. Fix authentication/session vulnerabilities
3. Fix R2 access controls
4. Fix database authorization
5. Fix XSS
6. Fix secrets exposure
7. Fix dependency vulnerabilities
8. Add security headers
9. Add rate limiting
10. Additional hardening

---

# PHASE 23 — DO NOT STOP AT STATIC ANALYSIS

Where practical, perform safe local security tests against the application.

Examples:

- unauthenticated request to protected endpoint
- authenticated user accessing another user's resource
- modifying resource IDs
- invalid input
- oversized input
- invalid file types
- unauthorized deletion
- role manipulation
- expired/invalid session
- malformed tokens
- missing parameters
- unexpected HTTP methods

DO NOT attack production infrastructure.

Only test the local/development environment unless explicitly instructed otherwise.

Do not perform destructive testing.

---

# PHASE 24 — REMEDIATION

After presenting the audit findings, ask for confirmation before making significant security changes.

For straightforward, low-risk fixes, you may implement them if they clearly cannot alter intended functionality.

When implementing fixes:

- make minimal changes
- preserve existing functionality
- add validation
- add authorization checks
- add tests
- update dependencies only when appropriate
- update configuration carefully
- document security-sensitive changes

After fixing vulnerabilities, rerun the relevant security checks.

---

# FINAL DELIVERABLE

I want the final output to contain:

1. Executive summary
2. Application architecture
3. Attack surface inventory
4. Authentication findings
5. Authorization findings
6. IDOR/BOLA findings
7. Database findings
8. R2/file-storage findings
9. API findings
10. XSS findings
11. SSRF findings
12. CSRF findings
13. Cloudflare configuration findings
14. Secrets findings
15. Dependency findings
16. Rate-limiting findings
17. Business-logic findings
18. Security-header findings
19. Complete vulnerability table
20. Prioritized remediation plan
21. Recommended fixes
22. Tests that should be added
23. Security improvements that are optional/hardening

At the very end provide a concise:

# SECURITY SCORE

Rate the current application from 0–100.

Break the score down into:

- Authentication
- Authorization
- Data protection
- File storage
- API security
- Infrastructure/configuration
- Dependency security
- Monitoring/abuse prevention

Be honest. Do not give a high score simply because obvious vulnerabilities were not found.

The goal is to identify real vulnerabilities and make this application significantly harder to compromise.
