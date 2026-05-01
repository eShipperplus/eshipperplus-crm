# eShipper Plus CRM — Phase 1 MVP

Sales pipeline, partner intake, and onboarding handoff. Implements the 26 MVP rules from `eShipperPlus_CRM_MVP_Spec_v2.docx`.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Backend | Node 20 / Express on Cloud Run | `server.js`, region `northamerica-northeast1` |
| Database | Firestore | `crm_*` collections |
| Auth | Firebase Auth + Google SSO | Workspace-restricted via `hd` param |
| Hosting | Cloud Run serves both the API and the static `public/` SPA | single origin, no CORS headaches |
| Email | Gmail SMTP via nodemailer | see `services/email.js` |
| Contract gen | Google Docs template | `services/docs.js` |
| Files | Google Drive per-client folders | `services/drive.js` |
| eSignature | Google Workspace eSignature | `services/esign.js` — webhook on `/webhooks/esignature` |
| Scheduled rules | Cloud Scheduler → `/cron/inactivity-sweep` | daily 9am ET |

## Repo layout

```
eshipperplus-crm/
├── server.js                  Express backend + API routes
├── rules/engine.js            R-01..R-26 rule engine
├── services/
│   ├── email.js               Gmail SMTP + all templates
│   ├── drive.js               Per-client folders
│   ├── docs.js                Contract generation from template
│   └── esign.js               Workspace eSignature wrapper
├── public/
│   ├── index.html             CRM app (from approved mockup)
│   ├── app.js                 Client logic, Google SSO, API wiring
│   ├── partner.html           Standalone partner lead submission page
│   └── website-form.html      Standalone website intake form (embed target)
├── dev_setup.js               One-shot seed: invites, config, sample partner reps
├── Dockerfile                 Container build
├── cloudbuild.yaml            GCP Cloud Build → Artifact Registry → Cloud Run
├── firestore.rules            Deny-by-default; admin SDK bypasses
├── firestore.indexes.json     Composite indexes
└── .github/workflows/deploy.yml  Push-to-main → deploy
```

## Firestore collections

| Collection | Purpose |
|---|---|
| `crm_users`    | User profile + role (`admin`, `rep`, `onboarding`, `finance`) |
| `crm_invites`  | Pre-set role for a Google Workspace email before first sign-in |
| `crm_deals`    | Every lead/deal. Includes tier, duplicateFlag, approvalStatus, onboarding checklist |
| `crm_activity` | Per-deal audit trail (stage changes, notes, reassignments, rule firings) |
| `crm_notifications` | Per-user in-app notifications |
| `crm_config/notification_rules`    | Inactivity thresholds, recipient overrides |
| `crm_config/partner_rep_directory` | Partner rep dropdown entries |

## Local dev

```bash
npm install
export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/service-account.json)"
export SMTP_USER=someone@eshipperplus.com
export SMTP_PASS='your-gmail-app-password'
export PUBLIC_APP_URL=http://localhost:8080
npm run seed      # writes invites + default config
npm run dev       # starts :8080 with --watch
```

Open `http://localhost:8080` and sign in with a Google Workspace account that was seeded as an invite (or add your own into `dev_setup.js`).

### Firebase web config

Edit the three constants in `public/app.js` or inject them via `<script>window.__FIREBASE_API_KEY__='...'</script>` before the module loads. The API key is safe to expose — security is enforced server-side by the Admin SDK.

## First deploy (production)

1. **GCP project setup** — enable Firestore (Native mode, region `northamerica-northeast1`), Firebase Authentication with Google provider, Cloud Run, Cloud Build, Artifact Registry, Cloud Scheduler.
2. **Service account** — create a service account with: Cloud Run Admin, Firebase Admin, Firestore User, Drive/Docs API (if using the full contract generation), Cloud Scheduler Admin. Download its JSON key.
3. **GitHub secrets** — set in the repo settings:
   - `GCP_SA_KEY` — the JSON from step 2
   - `GCP_PROJECT_ID`, `FIREBASE_PROJECT_ID`
   - `FIREBASE_SA_JSON` — same JSON (used at runtime on Cloud Run)
   - `SMTP_USER`, `SMTP_PASS` — Gmail app password
   - `GOOGLE_DRIVE_FOLDER_ID` — root folder for per-client contract folders
   - `CONTRACT_TEMPLATE_DOC_ID` — Doc ID of the contract template (Phase 2 — outstanding input per spec §10)
   - `PUBLIC_APP_URL` — e.g. `https://crm.eshipperplus.com`
   - `CRON_SECRET` — any random string; used by Cloud Scheduler → Cloud Run
4. **Seed** — run `node dev_setup.js` once against the production project with the SA creds exported.
5. **Push to main** — the GitHub Action builds, deploys to Cloud Run, installs Firestore indexes, and registers the `crm-inactivity-sweep` Cloud Scheduler job.

## Rule coverage

Every ✅ MVP rule from the spec maps to code:

| Rule | Trigger | File |
|---|---|---|
| R-01 create deal on any form submission | `POST /public/leads/*`, `POST /api/deals` | `server.js` + `rules.onLeadSubmit` |
| R-02 auto-classify tier from monthly revenue | on submit + on service edit | `rules.tierFromMonthly` |
| R-03 notify admins on new lead | always | `rules.onLeadSubmit` |
| R-04 welcome email on web/partner submit | not on Manual Entry | `rules.onLeadSubmit` |
| R-05 duplicate detection + admin alert | on submit | `rules.detectDuplicates` |
| R-06 tag partner rep from directory | partner portal only | `rules.onLeadSubmit` |
| R-07 inactivity T+3 (editable) | daily cron | `rules.sweepInactivity` |
| R-08 inactivity T+7 (editable) | daily cron | `rules.sweepInactivity` |
| R-09 T+30 auto-stall | *Phase 2 — not built* | — |
| R-10 admin rep reassignment any stage | `POST /api/deals/:id/reassign` | `rules.onRepReassign` |
| R-11 New → Qualified resets inactivity | `POST /api/deals/:id/stage` | `rules.onStageChange` |
| R-12 Qualified → Proposal: approval gate | `POST /api/deals/:id/stage` short-circuits | `server.js`, `rules.onStageChange` |
| R-13 notify rep on approval | `POST /api/deals/:id/approval` | `rules.onApprovalDecision` |
| R-14 rejection stays in Qualified + rework notes | same | `rules.onApprovalDecision` |
| R-15 log proposal send date | `Proposal Sent → Negotiation` | `rules.onStageChange` |
| R-16 soft prompt on discount (Negotiation → Closed Won) | client-side advisory only (no blocking) | `public/app.js` |
| R-17 auto-generate contract on Closed Won | `services/docs.generateContract` | `rules.onStageChange` |
| R-18 notify admins on Closed Won | `rules.onStageChange` |
| R-19 on eSignature complete → advance to Onboarding | `POST /webhooks/esignature` | `rules.onSignatureComplete` |
| R-20 create onboarding record, assign, T+1 SLA | on Onboarding stage | `rules.onStageChange` |
| R-21 handoff email to Kim (cc rep) | same | `services/email.onboardingHandoff` |
| R-22 notify admins onboarding confirmed | same | `rules.onStageChange` |
| R-23 onboarding checklist rep-readonly | `PATCH /api/deals/:id/onboarding` role gate | `server.js` |
| R-24 Closed Lost requires loss reason + re-engage date | `POST /api/deals/:id/stage` validation | `server.js` |
| R-25 re-engagement date reached → notify rep | daily cron | `rules.sweepReengagement` |
| R-26 log re-engagement to reporting | same | `rules.sweepReengagement` |

## Permissions summary

| Action | Who |
|---|---|
| View dashboard, pipeline, leads | all authenticated |
| Create/edit deal | assigned rep, admin |
| Change stage | assigned rep, admin |
| Approve proposal | admin only |
| Reassign rep | admin only |
| Resolve duplicate flag | admin only |
| Edit onboarding checklist | admin, onboarding role (rep read-only) |
| Partner rep directory upload | admin only |
| Settings / notification rules | admin only |
| User management | admin only |

## Outstanding inputs (per spec §10)

These do not block build but block full test pass:
- Onboarding checklist task content (Kim W. + Ahmed)
- Contract template Doc ID (Ahmed / Legal)
- Initial partner rep directory CSV (Ahmed)
- Duplicate fuzzy-match threshold confirmation — currently 80% (Ahmed/Aamer)
- Inactivity thresholds T+3/T+7 confirmation (Ahmed)

## Phase 2 (not built, architecture accommodates)

Meeting flow + Gemini notetaker · Proposal PDF auto-gen · WMS export · Profitability panel · AI lead scoring · T+30 auto-stall · Multi-step nurture · Apollo.io · Full tasks · Mobile quick-capture · Gmail sync · ML stage probabilities.
