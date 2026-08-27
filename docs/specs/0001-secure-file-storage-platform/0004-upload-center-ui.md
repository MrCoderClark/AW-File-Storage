# 0001d. App shell and Upload Center screen

Child of [0001, Secure file storage platform on Cloudflare](index.md).

## Summary

This is the screen in the mock: a dark navy header, a row of navigation tabs, a left rail showing upload history and storage usage, and a main panel with a large drag and drop area over a table of files that are currently uploading, queued, or failed. This spec turns that picture into a build specification: which parts are in this release, what each state looks like, how progress and the estimated time are worked out, how it behaves with a keyboard and a screen reader, and what it does on a narrow screen. The design source is the screenshot at `docs/Designs/mock1.jpg` and nothing else, so the build has one thing to match.

**Inline rationale.** The mock is the design source, which means no style direction needs inventing, but a static picture leaves out every state that matters, so the empty, loading, error, and offline states are specified here rather than improvised. The mock shows six navigation tabs and only one of them has a specification, so the others are cut from this release rather than shipped as dead links, which is the usual way a mock quietly becomes four unfinished features. Progress is driven by the browser's own upload progress events, because the bytes never touch our server and there is therefore nothing server side to ask.

## Requirements

**User stories**:
- As a staff member, I want to drop a folder of contact cards onto the page and watch each file's progress, so that I can tell what is happening without refreshing.
- As a staff member, I want to copy a published card's public address with one click, so that I can paste it into a QR code generator or an email.
- As a staff member, I want a failed upload to tell me why and let me retry it in place, so that I do not start over.
- As an admin, I want to see how much of our storage allowance is used, so that I notice before we run out.
- As a keyboard only user, I want to reach and use the upload control without a mouse, so that the page is usable at all.

**Acceptance criteria**:
- **AC-1**: The signed in shell matches `docs/Designs/mock1.jpg` in structure: a dark header with the product name, a search field, a notification bell, and the user's name and role; a navigation row beneath it; a left rail with Upload History, Storage Usage, and Recent Activity; a main content panel; and a footer.
- **AC-2**: The navigation shows only routes that exist in this release. Nothing in the navigation leads to an empty or unfinished page.
- **AC-3**: Dropping files onto the drop area starts uploading them. Dropping a folder uploads the files inside it, up to two levels deep. The drop area shows a clearly different state while a drag is over it.
- **AC-4**: The `Browse Files` button opens the file picker, is reachable by keyboard alone, shows a visible focus ring, and the drop area itself is operable by keyboard with the same effect.
- **AC-5**: Each file appears as a row showing its name, a progress bar, the bytes transferred against the total, and the estimated time remaining, matching the columns in the mock. The estimate is a rolling average of recent throughput, not a single sample, and it is hidden rather than shown as nonsense when there is not yet enough data.
- **AC-6**: At most 3 files upload at once. The rest show a `QUEUED` badge and start automatically as slots free up.
- **AC-7**: A failed row shows `FAILED - Retry` in red with a readable reason, and the retry control resumes without asking for the file again. A multipart upload resumes from the last completed part rather than from the beginning.
- **AC-8**: A file rejected before upload (over the size cap, or over the organization's quota) never appears as an upload in progress. It appears immediately as rejected with the reason and the two numbers involved.
- **AC-9**: When a vCard finishes and is published, its row shows the public address with a copy control, and copying it confirms visibly.
- **AC-10**: Storage Usage shows used against quota as a percentage and a bar, and updates after an upload completes without a page refresh.
- **AC-11**: Upload History shows today's completed count and total bytes, and Recent Activity shows the latest audit events the viewer is allowed to see. A viewer without audit access sees only their own activity.
- **AC-12**: Every list has a designed empty state, a loading skeleton, and an error state with a retry. No area renders as a blank rectangle.
- **AC-13**: Navigating away from the page while uploads are in flight warns before leaving. Losing the network pauses the uploads and shows an offline notice, and regaining it resumes them.
- **AC-14**: Progress is announced to assistive technology politely rather than on every update, every control has an accessible name, colour is never the only signal of a state, and text contrast meets WCAG AA.
- **AC-15**: The layout works from 360 pixels wide upward. Below the large breakpoint the left rail collapses behind a control, and the upload table becomes stacked cards rather than a horizontally scrolling table.
- **AC-16**: An unauthenticated visitor to any application route is redirected to sign in and returned to the route they asked for after signing in. The public vCard address is unaffected, since it is served by the bucket and never reaches the app.
- **AC-17**: A user who is a member of more than one organization can switch organizations from the header, and every panel on the page reloads for the new organization.
- **AC-18**: Animation is limited to opacity and transform, and honours a reduced motion preference. The page does not shift its layout as rows are added.

## Decision

**Chosen option**: Build the shell and the Upload Center to the screenshot, with Tailwind CSS v4 and shadcn/ui components, and cut every navigation tab that has no specification behind it.

**Design source**: `docs/Designs/mock1.jpg`, the screenshot provided by the engineer. There is no Figma file and no existing design system, so this screenshot plus the tokens below are the sole reference.

**Implementation skills**: `tailwindcss-v4` (`C:\Users\jclark\.agents\skills\tailwindcss-v4\`) · `frontend-design` (`C:\Users\jclark\.agents\skills\frontend-design\`) · `playwright` (`C:\Users\jclark\.agents\skills\playwright\`)

## Feature design

**Scope of the navigation** (AC-2). The mock shows six tabs. Only these ship in this release:

| Tab in the mock | This release |
|---|---|
| Dashboard | In, as the storage and recent activity overview |
| Upload Center | In, the screen this spec details, and the default landing page |
| Settings | In, limited to profile, password, second factor, and member management |
| Shared Files | Cut. Private files are shared with a signed link from the file row, which needs no separate screen yet |
| Team Projects | Cut. There is no project concept in the data model |
| Reports | Cut. The audit log view in Settings covers the real need for now |

**Design tokens**, read off the mock and defined once in `@theme` (Tailwind v4 defines its theme in CSS rather than in a JavaScript config file):

| Token | Value | Used for |
|---|---|---|
| `--color-brand-900` | `#0d2440` | Header background, the darkest navy |
| `--color-brand-800` | `#14385c` | Navigation row, one step lighter than the header |
| `--color-brand-600` | `#1f5d99` | Primary buttons and active navigation |
| `--color-accent-500` | `#2f86d6` | Progress bars and the logo mark |
| `--color-surface` | `#ffffff` | Panels |
| `--color-canvas` | `#f5f7fa` | Page background |
| `--color-border` | `#e2e8f0` | Panel edges and the dashed drop area |
| `--color-danger-600` | `#c0392b` | The failed state |
| `--color-muted-500` | `#64748b` | Secondary text |
| Type | Inter, or the system UI stack | Headings are semibold, body is regular |
| Radius | 6 pixels on panels and buttons, 8 on the drop area | |
| Spacing | a 4 pixel scale, panels padded 24, rail width 240 | |

**Layout**

```
+--------------------------------------------------------------+
| header, brand-900, 56 tall: logo | search | bell | user menu  |
+--------------------------------------------------------------+
| nav, brand-800, 40 tall: Dashboard  Upload Center  Settings   |
+------------------+-------------------------------------------+
| rail, 240 wide   | main panel, canvas background             |
| Upload History   |   cloud icon                              |
| Storage Usage    |   h1  Secure Enterprise File Upload       |
| Recent Activity  |   dashed drop area + Browse Files         |
|                  |   upload table: Name Uploaded Time ETA    |
+------------------+-------------------------------------------+
| footer: copyright left, links right                          |
+--------------------------------------------------------------+
```

**Component inventory**

| Component | New or existing | Notes |
|---|---|---|
| `AppHeader` | new | Search, notification bell with an unread count, user menu with the organization switcher (AC-17) |
| `AppNav` | new | Three tabs, active state from the current route |
| `SideRail` | new | Container for the three rail panels, collapsible below the large breakpoint |
| `UploadHistoryPanel` | new | Today's completed count and total bytes |
| `StorageUsagePanel` | new | Percentage, bar, and the used against quota line |
| `RecentActivityPanel` | new | Audit events, scoped to what the viewer may see |
| `DropZone` | new | Drag, drop, folder support, keyboard operable, drag over state |
| `UploadTable` and `UploadRow` | new | Progress, badges, retry, copy link. Becomes stacked cards on a narrow screen |
| `StatusBadge` | new | `QUEUED`, `UPLOADING`, `VALIDATING`, `PUBLISHED`, `PRIVATE`, `FAILED` |
| Button, Input, Table, Progress, Badge, Dialog, DropdownMenu, Toast, Skeleton, Tooltip | shadcn/ui | Copied into the repository, so they are ours to edit |
| `CopyLinkButton` | new | Copies the public address and confirms visibly (AC-9) |

**Upload queue behaviour** (AC-5, AC-6, AC-7). One client side store holds every upload as `{ id, file, status, bytesSent, total, startedAt, throughputSamples, error, publicUrl }`. A scheduler runs at most 3 concurrent uploads. Progress comes from the upload's own progress events, since the bytes never reach our server. The estimate is computed from a rolling window of the last 5 samples, and is withheld until at least 2 seconds and 5 percent have elapsed, so it never shows an absurd first number. Status moves `queued` → `uploading` → `validating` (the server is checking) → `published` or `private`, or `failed` at any point. The store survives a component remount but not a page reload; a reload shows any still processing file from the server instead, so nothing is silently lost.

**Screen states** (AC-12): the drop area has a resting state, a drag over state, and a disabled state when the quota is exhausted. The table has an empty state ("Nothing uploading. Drop a file to start."), a loading skeleton for server provided rows, and an error state with a retry. Each rail panel has its own skeleton and its own error state, so one failing panel does not blank the page.

**Accessibility** (AC-14): the drop area is a real `button` with a label, so it is reachable by tab and activated by space or enter, with drag and drop as an enhancement rather than the only route. The upload table is a real `table` with a caption and header scopes. Progress is announced through one polite live region that reports at meaningful moments (started, half way, finished, failed) rather than on every progress event, because announcing every update makes a screen reader unusable. Every state carries text or an icon as well as colour. The failed state is red plus the word `FAILED` plus a reason.

**Interface surface**: the page is a server component that reads the session, the storage usage, the recent activity, and any in flight files, then hands them to a client component that owns the upload queue. Uploading calls `requestUpload` and `finalizeUpload` from child [0003](0003-uploads-and-public-vcard-urls.md) as server actions and puts the bytes to R2 directly. Status while validating comes from `getUploadStatus` polled every 2 seconds, with the poll stopping once every file has settled. No new endpoints are introduced by this spec.

**Key invariants**:
1. The page never renders a control for something the caller's role does not permit. It hides it, and the server checks again anyway.
2. The browser never sees an R2 credential. It only ever sees a single signed link scoped to one key.
3. Displayed progress is client side truth about transferred bytes, and displayed status after that is server side truth. The two are never mixed in one indicator.
4. Nothing in the navigation points at a route that does not exist.

**Security model**: every application route requires a session and is redirected to sign in otherwise (AC-16). Role gating comes from `requireOrgRole()` in child [0001](0001-authentication-and-sessions.md), never from a client side check. Recent Activity shows organization wide audit events to owners and admins and only the viewer's own events to a member. The search field searches the current organization's files only.

**Configuration required**: none new. The product name shown in the header comes from `NEXT_PUBLIC_APP_NAME`, defaulting to a placeholder until a real name is chosen.

**Critical test scenarios**:
- Happy path: drop two `.vcf` files, both reach published, both show a copyable address, and Storage Usage updates without a refresh. Verifies **AC-3**, **AC-9**, **AC-10**.
- Folder drop: dropping a folder of five cards queues all five. Verifies **AC-3**.
- Keyboard only: tab to the upload control, activate it with a key, and complete an upload with no mouse at all. Verifies **AC-4**.
- Concurrency: ten files queued show exactly 3 uploading and 7 `QUEUED`, and the queue drains without intervention. Verifies **AC-6**.
- Failure and retry: a deliberately failed part shows `FAILED - Retry` with a reason, and retry resumes from the last completed part rather than from zero. Verifies **AC-7**.
- Pre rejection: a file over the cap never shows a progress bar, only a rejection with both numbers. Verifies **AC-8**.
- Leaving: navigating away mid upload warns, and dropping the network pauses then resumes. Verifies **AC-13**.
- Screen reader: the live region announces start, half way, finish, and failure, and nothing in between. Verifies **AC-14**.
- Narrow screen: at 360 pixels the rail is behind a control and the table is stacked cards with no horizontal scrolling. Verifies **AC-15**.
- Unauthenticated: every application route redirects to sign in and returns to the requested route afterwards, while a public vCard address still serves without a session. Verifies **AC-16**.
- Organization switch: a user in two organizations switches and every panel reloads for the new one. Verifies **AC-17**.
- Navigation: every tab in the navigation resolves to a real page. Verifies **AC-2**.

## Build plan

Thin end to end slices (the assumed default). The shell comes first because every later screen sits inside it, but it is built against real session data rather than as a mock.

1. Project styling foundation: Tailwind v4 with the `@theme` tokens above, the shadcn/ui components listed, and the base typography. Satisfies the token half of **AC-1**.
2. App shell: header, navigation, rail container, main panel, footer, laid out to the mock, rendering the real signed in user and role. Satisfies **AC-1**, **AC-2**.
3. Route protection and the redirect back to the requested route after signing in. Satisfies **AC-16**.
4. Thin end to end slice: the drop area plus a one row upload table wired to `requestUpload`, a real put to R2, `finalizeUpload`, and a settled status. Satisfies **AC-3**, **AC-5** in part.
5. The upload queue store and scheduler: concurrency of 3, the `QUEUED` badge, and automatic promotion. Satisfies **AC-6**.
6. Progress, transferred bytes, and the rolling estimate with its withholding rule. Satisfies **AC-5**.
7. Failure states, readable reasons, and retry that resumes from the last completed part. Satisfies **AC-7**.
8. Pre upload rejection for the cap and the quota, shown without a progress bar. Satisfies **AC-8**.
9. Published address display with the copy control and its confirmation. Satisfies **AC-9**.
10. Rail panels: Upload History, Storage Usage with live refresh, and Recent Activity with its role scoping. Satisfies **AC-10**, **AC-11**.
11. Empty, loading, and error states for every list and every panel. Satisfies **AC-12**.
12. Leave warning, offline detection, and resume. Satisfies **AC-13**.
13. Accessibility pass: the live region, accessible names, focus rings, contrast, and non colour signals. Satisfies **AC-14**, **AC-18**.
14. Responsive pass down to 360 pixels, including the collapsing rail and the stacked cards. Satisfies **AC-15**.
15. Organization switcher in the user menu. Satisfies **AC-17**.
16. The test suite from Critical test scenarios: component tests in Vitest and the browser flows in Playwright, including a keyboard only run and a narrow viewport run. Covers every acceptance criterion above.
