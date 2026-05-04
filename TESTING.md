# eShipper Plus CRM — Test Plan

End-to-end regression checklist for Phase 1 MVP. Walk through this whenever you deploy a meaningful change. Estimated full-pass time: ~30 minutes.

## How to use this doc

- **Before each deploy** to production: run the **Smoke** section (5 min).
- **Before each release** (every 1–2 weeks): run **Smoke + every section** (~30 min).
- **After a bug fix**: run the section that covers the area + **Smoke**.
- Tick boxes inline (`[x]`) or copy the section into a fresh doc per release.

Fields to fill in once per pass at the top:

```
Tester:       _______________
Date:         _______________
Environment:  [ ] Local (localhost:8080)   [ ] Production (crm.eshipperplus.com / *.run.app)
Branch / commit: _______________
```

---

## 0. Smoke Test (5 min)

The fastest way to know "is anything obviously broken?". Run before every deploy.

- [ ] Live URL loads → purple sign-in screen appears (no flash of mockup data)
- [ ] `https://eshipper-f56c3.firebaseapp.com/__/firebase/init.json` returns JSON
- [ ] Sign in with `your-name@eshipperplus.com` → land on Dashboard
- [ ] Dashboard top metrics show numbers (real or zero, not "—")
- [ ] Sidebar badges show numbers
- [ ] Click Pipeline → kanban renders → no 503 / red toasts
- [ ] Open `/website-form` in another tab → submit a test lead → returns to "Thanks!" page
- [ ] Back on CRM → wait 30s OR click the dashboard nav → new lead is reflected (Active Deals went up by 1)
- [ ] No red errors in the browser Console (F12)
- [ ] No errors in Cloud Run logs (last 5 min)

If any of these fail → **stop**, fix before considering the deploy successful.

---

## 1. Authentication & Authorization

### 1a. Sign-in flow

- [ ] Click "Sign in with Google" → redirect (or popup) to Google's sign-in page
- [ ] Picking an `@eshipperplus.com` Workspace account succeeds → land on dashboard
- [ ] Picking a non-Workspace account (personal Gmail) → either rejected or signed in as `rep`
  - If you have `provider.setCustomParameters({ hd: 'eshipperplus.com' })` enabled (currently removed): non-Workspace silently bounces
- [ ] Existing user with `crm_invites` record → role assigned per the invite
- [ ] User with no invite → auto-created with `rep` role
- [ ] User document in `crm_users` collection updates `lastSeen` on each sign-in

### 1b. Sign-out flow

- [ ] Click sidebar user card → confirm prompt → page reloads to sign-in screen
- [ ] After sign-out, all `/api/*` requests return 401

### 1c. Role-based UI

Sign in as each role (or change your role via Firestore for testing):

- [ ] **admin**: sees Notification Rules + User Management + Settings nav items
- [ ] **rep**: does NOT see those nav items
- [ ] **onboarding**: does NOT see those nav items
- [ ] **finance**: does NOT see those nav items
- [ ] Sidebar shows correct role label under your name

### 1d. Role-based API enforcement

Open Network tab while signed in as a `rep`. Confirm these all return 403:

- [ ] `POST /api/users/invite` → 403
- [ ] `PATCH /api/users/:uid` → 403
- [ ] `DELETE /api/users/:uid` → 403
- [ ] `POST /api/deals/:id/approval` → 403
- [ ] `POST /api/deals/:id/reassign` → 403
- [ ] `PUT /api/settings/notification_rules` → 403

---

## 2. Lead Intake (R-01..R-06)

### 2a. Website form

- [ ] Open `/website-form` (no auth required)
- [ ] Form validates: empty Company / Email / Name → blocked
- [ ] Submit valid form → success page appears
- [ ] CRM dashboard reflects the new lead within 30s
- [ ] Pipeline → New column has the lead
- [ ] Deal record's `source` field = `Website`
- [ ] Welcome email arrives at the contact email (R-04)
- [ ] Admin emails (Aamer, Ahmed) receive new-lead notification (R-03)
- [ ] Tier auto-classified per monthly revenue (R-02):
  - $0–$4,999/mo → Tier 1
  - $5,000–$9,999 → Tier 2
  - $10,000–$24,999 → Tier 3
  - $25,000+ → Tier 4

### 2b. Partner portal

- [ ] Open `/partner` → rep dropdown is populated from `crm_config/partner_rep_directory`
- [ ] Empty rep selection → blocked with a clear message
- [ ] Submit valid form → success page
- [ ] Deal record's `source` = `Partner Portal`
- [ ] Deal record's `partnerRep` = `{company, repName}` (R-06)
- [ ] Activity log on the deal shows "Partner attribution logged"
- [ ] Welcome email sent to contact (R-04)
- [ ] Admin emails sent (R-03)

### 2c. Manual lead entry (CRM-internal)

- [ ] Sign in as `rep` or `admin`
- [ ] Sidebar → Manual Lead Entry → form renders single-column on mobile
- [ ] Submit a deal with at least Company + Email
- [ ] Deal appears in Pipeline immediately (no 30s wait)
- [ ] Deal record's `source` = `Manual Entry`
- [ ] **No welcome email sent** (R-04 explicitly excludes Manual Entry)
- [ ] Admin emails STILL sent (R-03 fires regardless of source)

### 2d. Duplicate detection (R-05)

Submit a second lead that should be flagged as a duplicate:

- [ ] Same company name (case-insensitive, ≥80% match): "Acme Inc." vs "ACME inc" → flagged
- [ ] Same contact email (exact): two leads with `mike@arctic.ca` → flagged
- [ ] Same company + phone (both must match): even if email differs → flagged

When flagged:

- [ ] Deal still enters pipeline at New (not blocked)
- [ ] Admin (Aamer + Ahmed) receive duplicate alert email with side-by-side comparison
- [ ] In-app notification fires for admin
- [ ] Deal Detail (admin view): shows `⚠ Possible duplicate` banner with "Not a duplicate" / "Discard" buttons
- [ ] Deal Detail (rep view): does NOT show the banner
- [ ] Click "Not a duplicate" → flag clears, banner disappears, activity log shows "Duplicate cleared"
- [ ] Click "Discard" → deal hidden from pipeline + leads list

---

## 3. Pipeline / Stage Transitions (R-10..R-19)

### 3a. Stage advancement

- [ ] Drag a New deal → Qualified column → no error toast → stage updates
- [ ] R-11: New → Qualified resets `inactivitySince` and `inactivityRepNotified` flags
- [ ] R-12: Qualified → Proposal Sent → toast says "Proposal approval requested" → deal stays in Qualified visually
  - Admin receives email + in-app: "Proposal approval needed"
  - Approval status = `pending`
- [ ] As admin, click on the deal → click an Approve button → deal advances to Proposal Sent
- [ ] R-13: Rep receives in-app notification "Proposal approved"
- [ ] If admin rejects (with reason) → R-14: deal stays in Qualified, rep sees "rework" notification with the reason
- [ ] R-15: Proposal Sent → Negotiation: `proposalSentAt` is logged
- [ ] R-16 advisory only — no blocking on Negotiation → Closed Won

### 3b. Closed Won / Contract / Onboarding

- [ ] Move a deal to Closed Won
- [ ] R-17: Drive folder created at `CRM Clients/<Company Name>` (visible to the deploy SA email)
- [ ] R-17: Contract Doc generated from template (if `CONTRACT_TEMPLATE_DOC_ID` is set)
- [ ] R-18: Admin email "Contract sent: <Company>"
- [ ] eSignature request fires (or dry-runs if `ESIGN_ENABLED` not set) — check Cloud Run logs for `[esign:dry-run]`
- [ ] R-19 (when signature webhook fires): deal auto-advances to Onboarding
- [ ] R-20: `onboarding` field populated on deal: `{assignedUid, slaDueAt (T+1), checklistState}`
- [ ] R-21: handoff email to onboarding manager (Kim) with rep cc'd
- [ ] R-22: admin email "Onboarding started"

### 3c. Closed Lost (R-24, R-25, R-26)

- [ ] Click "Mark Lost" → modal opens
- [ ] Try to confirm without filling loss reason → blocked
- [ ] Try to confirm without filling re-engagement date → blocked
- [ ] Fill both → confirm → deal moves to Closed Lost
- [ ] Deal record has `lossReason` and `reengagementDate` set
- [ ] R-25: when re-engagement date is reached and the daily cron fires → assigned rep gets email + in-app notification
- [ ] R-26: activity log shows "Re-engagement due"

### 3d. Rep reassignment (R-10)

- [ ] As **admin**, on any deal → "Change Rep" button visible → click → modal
- [ ] Pick a new rep + reason → confirm
- [ ] Activity log shows "Rep reassigned: Old Name → New Name"
- [ ] New rep receives email + in-app notification
- [ ] As **rep** (signed in as the OLD rep), open the deal: it's read-only — Edit buttons disabled / 403 on save
- [ ] Reassignment works at every stage including Closed Won, Contract, Onboarding, Closed Lost

---

## 4. Inactivity (R-07, R-08)

This requires either time travel (manually editing `lastActivityAt` in Firestore) or waiting days. Easiest test:

- [ ] In Firestore Console, edit a deal's `lastActivityAt` to 4 days ago
- [ ] Manually fire the cron:
  ```
  Invoke-WebRequest -Method POST `
    -Uri "$PUBLIC_APP_URL/cron/inactivity-sweep" `
    -Headers @{"X-Cron-Secret"="<your CRON_SECRET>"}
  ```
- [ ] Response shows `repFired: 1`
- [ ] Assigned rep gets email "Inactivity alert: <Company> (4 days)"
- [ ] In-app notification appears for the rep
- [ ] Deal's `inactivityRepNotified` = true (won't fire again)
- [ ] Set `lastActivityAt` to 8 days ago + `inactivityAdminNotified` = false → fire cron again
- [ ] Response shows `adminFired: 1`
- [ ] Admin (Aamer + Ahmed) get escalation email

---

## 5. Notifications

- [ ] Bell badge in sidebar shows correct unread count
- [ ] Notifications screen shows newest first
- [ ] Click "Mark read" on one → that one greys out, badge count decrements
- [ ] Click "Mark all as read" → all notifications grey out, badge = 0
- [ ] Each notification with a `dealId` → clicking it opens that deal's Detail screen
- [ ] Refresh the page → read state persists

---

## 6. Notification Rules (Settings)

Admin only.

- [ ] Navigate to Notification Rules → table loads
- [ ] R-07 day input shows current threshold (default 3, after save persists)
- [ ] R-08 day input shows current threshold (default 7, after save persists)
- [ ] R-09 (Phase 2) is greyed out, can't be edited
- [ ] Toggle off R-03 → click Save Changes → toast "saved"
- [ ] Submit a new lead via `/website-form` → admin email NOT sent, in-app NOT created
- [ ] Toggle R-03 back on → save → next lead admin emails fire again
- [ ] Reload the page → toggle states persist
- [ ] Sign in as a non-admin → cannot access Settings → 403 on the API

---

## 7. User Management (admin only)

### 7a. List

- [ ] User Management screen shows only real users from `crm_users` collection
- [ ] No mockup users (Sara K., James T., Kim W., Divyanka K., Aamer A.) unless they actually signed in
- [ ] Your own row labeled "(you)"
- [ ] Last Seen column shows relative time

### 7b. Invite

- [ ] Click "+ Invite User" → modal
- [ ] Submit empty email → blocked
- [ ] Submit valid email + role → toast "Invited X as Y"
- [ ] In Firestore, `crm_invites/<email-lowercase>` created
- [ ] When the invitee signs in for the first time, they pick up the assigned role
- [ ] Invite document is consumed (deleted) after sign-in

### 7c. Edit

- [ ] Click Edit on any row → modal pre-fills name/email/role
- [ ] Email field is disabled (cannot change — that's the auth identity)
- [ ] Change role → Save → toast → list updates → row reflects new role
- [ ] If you change another user's role, their **next token refresh** picks up the new claim (sign out + back in)

### 7d. Delete

- [ ] Self-delete → button is hidden / not rendered for your own row
- [ ] Click Delete on another user → confirm prompt → user removed from `crm_users` AND Firebase Auth
- [ ] Trying to sign in with the deleted user's account → fails (auth account is gone)
- [ ] To re-onboard them: re-invite

---

## 8. Onboarding Checklist (R-23)

- [ ] When a deal moves to Onboarding stage, `onboarding.checklistState` is populated with default items
- [ ] As **admin** or **onboarding**: checklist items can be toggled
- [ ] As **rep**: checklist is read-only (PATCH returns 403)
- [ ] Toggling a checkbox calls `PATCH /api/deals/:id/onboarding` with the new state
- [ ] State persists across page reloads
- [ ] Activity log shows "Onboarding checklist updated"

---

## 9. Public intake pages

### 9a. Iframe embedding from eshipperplus.com

- [ ] On a staging page on eshipperplus.com, embed the iframe
- [ ] Iframe loads the form with no console errors
- [ ] X-Frame-Options does NOT block (header set to allow eshipperplus.com)
- [ ] Form submission still works from inside the iframe
- [ ] Branding is consistent (purple header, "eshipperplus.com →" link)

### 9b. Rate limiting

- [ ] Submit `/public/leads/website` more than 20 times in a minute → 21st returns 429
- [ ] Each request from a different IP → not rate-limited (independent buckets)

---

## 10. Responsiveness (mobile / tablet)

Use Chrome DevTools → device toolbar (`Ctrl+Shift+M`).

### Mobile (375px)

- [ ] Dashboard metrics stack vertically (1 column)
- [ ] Pipeline kanban scrolls horizontally
- [ ] Leads table: only Company + Stage visible, others hidden
- [ ] Deal Detail single-column
- [ ] Manual Lead Entry single-column, full-width inputs
- [ ] `/website-form` and `/partner` fully responsive

### Tablet (768px)

- [ ] All screens still usable
- [ ] Sidebar collapses to top bar at <900px

### Desktop (≥1280px)

- [ ] Full multi-column layout
- [ ] Sidebar always visible

---

## 11. Performance / Reliability

- [ ] First page load (cold start) < 5s
- [ ] Subsequent loads (warm) < 1s
- [ ] No memory leaks: open Pipeline → switch to Dashboard → switch to Leads → repeat 20 times → memory in DevTools stays stable
- [ ] Auto-refresh fires every 30s (visible in Network tab as `/api/deals`, `/api/dashboard`, etc.)
- [ ] Tab focus triggers a refresh (switch away and back)
- [ ] Cloud Run cold starts on idle (5+ min idle) → first request takes ~3s; subsequent fast

---

## 12. Cron / Scheduled jobs

If you set up Cloud Scheduler (or cron-job.org):

- [ ] Visit Cloud Scheduler in GCP Console → `crm-inactivity-sweep` job listed → status Healthy
- [ ] Manually trigger it → returns 200 with `{ok:true, inactivity:{...}, reengagement:{...}}`
- [ ] Without `X-Cron-Secret` header → 401

---

## 13. Data export

- [ ] Leads → Export CSV → file downloads as `eshipperplus-leads-YYYY-MM-DD.csv`
- [ ] Open in Excel/Sheets → column headers correct
- [ ] All visible (non-discarded, non-merged) deals are exported
- [ ] Special characters in company names (commas, quotes) are properly escaped

---

## Bugs to log when found

If anything fails, capture:

1. Which checkbox (e.g. "5. Mark all as read")
2. What you saw vs what was expected
3. Browser console errors (F12 → Console)
4. Cloud Run logs around that time (severity ≥ Error)
5. The deal ID / user ID / URL involved

File as a GitHub Issue on `eShipperplus/eshipperplus-crm` with those 5 fields.

---

## Run results template

Copy this into a release notes doc when running a full pass:

```
## Test pass — <date> — <build sha>

| Section | Pass | Fail | Notes |
|---|---|---|---|
| 0. Smoke | ✅ | | |
| 1. Auth | ✅ | | |
| 2. Lead intake | ✅ | | |
| 3. Stage transitions | ✅ | | |
| 4. Inactivity | ✅ | | |
| 5. Notifications | ✅ | | |
| 6. Notification Rules | ✅ | | |
| 7. User Management | ✅ | | |
| 8. Onboarding | ✅ | | |
| 9. Public intake | ✅ | | |
| 10. Responsiveness | ✅ | | |
| 11. Performance | ✅ | | |
| 12. Cron | ✅ | | |
| 13. Export | ✅ | | |

Bugs found: <issue links>
Cleared for production: yes/no
```
