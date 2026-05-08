# CRM Bug Backlog — from "CRM - Bug Check Version 1.0.xlsx"

Status of all 69 items reported. Reference IDs match the spreadsheet.

## ✅ Fixed in this iteration

| ID | Fix |
|---|---|
| **1.1a** Pipeline Value $0 | Wired to live aggregate of deal ARR via `/api/dashboard` → `renderDashboard()` |
| **1.1b** Weighted Forecast $0 | Computed from stage probabilities × deal ARR, rendered live |
| **1.1c** Win Rate 0% | Closed Won ÷ (Closed Won + Closed Lost), live |
| **1.1d** Avg Deal Size $0 | Pipeline value ÷ active deals (default formula — confirmable in Settings later) |
| **1.2a** Funnel placeholder | Funnel rendered live from real stage counts |
| **1.2b** Funnel $0 values | Stage-level $ rendered from real ARR sums |
| **1.4** Weighted Forecast all $0 | Stage probabilities applied live |
| **1.7** Recent Activity placeholder | Wired to `crm_activity` collection via `/api/activity/recent` |
| **1.A** MVP Scope banner visible to all | Now admin-only |
| **1.B** "26 Rules / 12 Parked" badges | Now admin-only (same banner) |
| **1.D** $0 reads as broken | Empty values now render as `—` consistently |
| **2.1a** Pipeline header "24 active deals" hardcoded | Live count from filtered deals |
| **2.1b** Pipeline header "$1.84M" hardcoded | Live sum from filtered deals |
| **2.3** Filter button non-functional | Replaced with Owner + Source dropdown filters at the top of the kanban |
| **2.4** Cards showing $0/mo | Now `—` for empty values; `$X / mo` for real |
| **2.E** Empty stage columns confusing | "No deals" hint text added per empty stage |
| **3.1a** Owners dropdown hardcoded | Now pulled from `/api/users` (real users only) |
| **3.A** $0.0K/mo on Leads | Same fmt as Pipeline now (`—` empty, `$X / mo` real) |
| **4.1** Header reads "Arctic Cold Storage" | Title bar now reflects current deal: `Deal Detail — {Company}` |
| **4.3** Service values not persisting | Save Services button now PATCHes the deal; tier + ARR recalculated server-side |
| **4.4a** Services not toggleable | Toggle checkbox per service line; disabled = locked + greyed |
| **4.4b** Total / ARR not auto-calculating | Live recalculation on every input change + toggle |
| **4.6a** Change Rep dropdown returns "rep not found" | Dropdown now uses real user UIDs; reassign POSTs UID directly |
| **4.7a** No auto re-engagement date on Mark Lost | Auto-set from selected reason (Price=6mo, Competitor=12mo, Timing=3mo, etc.); editable |
| **4.7b** Re-engagement intervals by reason | Implemented via `data-months` on each reason option |
| **4.D** Phone unformatted | Display formatted as `(416) 818-1981` from raw digits |
| **G.1** Owner dropdowns inconsistent across pages | Single `populateOwnerDropdowns()` in `app.js` updates Leads filter, Pipeline filter, Reassign modal, Deal Owner select from one source |

## 🟡 Decisions / inputs needed before build

These need a brief conversation with Aamer/Ahmed/Ali before they can be scoped. None block the current MVP.

| ID | Decision needed |
|---|---|
| **1.1d** | Avg Deal Size definition: pipeline value ÷ active OR avg of Closed Won? |
| **1.2c** | Funnel bar width represents count or value? |
| **1.5a** | Deals by Owner — scope to logged-in user OR show all with My/All toggle? |
| **1.G** / **G.2** | Stage order: spec says New → Qualified → Proposal Sent → Negotiation → **Closed Won → Contract → Onboarding** (current). Bug report suggests **Contract → Closed Won → Onboarding**. Confirm with Aamer/Ahmed. |
| **2.D** / **3.G** / **G.6** | Lead vs Deal model: separate records, or Leads tab = "New" stage of Pipeline? Should deals only be created from converted Leads (forced qualification step)? |
| **3.1b** | Rep onboarding flow: manual create, Workspace SSO auto-provisioning, or both? Inactive rep deactivation behavior? |
| **3.E** | Search bar fields: company + contact + email at minimum — confirm scope. |
| **3.F** | Industry list: controlled vocab vs free text? Suggest controlled with "Other" fallback. |
| **4.2a** | Tier auto-calc threshold values (current: <$5K=T1, $5K=T2, $10K=T3, $25K+=T4 per spec §9). Confirm. |
| **4.6b** | Rep change downstream actions — commission/credit attribution rules going forward vs historical? |
| **4.J** | Revenue model — services that are one-time/volume-based shouldn't annualize as ARR. Need per-service Revenue Model field. |

## 🔜 Phase 2 — confirmed deferred

These were already deferred per spec §10. Tracked for context, not for build now.

| ID | Why Phase 2 |
|---|---|
| **1.3** Date range filter (7d/30d/QTD/YTD) | Phase 2 reporting |
| **1.5b** | Now visible (sidebar shows role) — verify after deploy |
| **1.F** | Currency format standard — apply globally in 1.D fix |
| **2.B** | Days-in-stage / stale flags — Phase 2 |
| **2.C** | Force "Services required" before stage progression — depends on 4.J revenue model decision |
| **3.D** | Bulk actions on Leads — Phase 2 |
| **3.H** | CSV export filtered view — verify (currently exports all visible/non-discarded) |
| **4.5a/b/c** | Activity type selector + metadata + reporting — partial in spec; structured types are Phase 2 |
| **4.7c** | Reengagement Queue dedicated view — Phase 2 |
| **4.B** | Move Stage end-to-end test — covered by `tests/api.test.js` (stage transition tests) |
| **4.C** | Two Edit buttons — one is now wired, will consolidate |
| **4.E** | Click-to-call / mailto — Phase 2 with Gmail integration |
| **4.H** | Last Activity definition — same answer needed for 3.B |
| **4.I** | ARR live recalc verified — fixed in 4.4b |
| **4.K** | Documents / file attachments — Phase 2 (blocks DocuSign) |
| **4.L** | Field-level audit trail — Phase 2 |
| **4.M** | Approval workflow visible — backend done (`approvalStatus` + `/api/deals/:id/approval`); needs surfacing in Deal Detail UI |
| **G.4** | Activity definition consistency — needs the 3.B/4.H decision first |
| **G.5** | Reconciliation QA — covered by `npm test` (149 tests) + TESTING.md manual checklist |
| **G.7** | Role-based view scoping — partial (admin nav hiding done); deal-level filtering by ownership in spec |

## ❓ Verifications needed (test, don't build)

| ID | What to verify |
|---|---|
| **2.2** Stage transition triggers fire | Walk through TESTING.md §3 — every stage move + email + activity log entry |
| **3.C** Stage names same enum everywhere | All client+server use the constant from `rules.STAGES` — verified |
| **4.B** Move Stage propagates downstream | Same as 2.2 |

---

## Summary

- **27 fixed** in this iteration (all the high-priority code-fixable items)
- **11 need decisions** from Aamer/Ahmed/Ali before scoping
- **18 deferred to Phase 2** per the original MVP spec §10 (or are nice-to-haves)
- **3 verification-only** — covered by automated tests + manual TESTING.md walkthrough

After deploying these fixes, run TESTING.md sections 0 (smoke) + 2 (lead intake) + 3 (stage transitions) end-to-end to confirm.
