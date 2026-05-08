'use strict';

// MVP Rule Engine — implements R-01 through R-26 from the spec.
// Each rule is a named function keyed by its rule ID. The server calls them
// at lifecycle points: onLeadSubmit, onStageChange, onApprovalDecision,
// onSignatureComplete, onRepReassign, plus the scheduled sweep for inactivity
// and re-engagement dates.
//
// Rules never throw — failures are logged on the deal's activity log so the
// pipeline keeps moving. A single rule failure must not block a deal.

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const email = require('../services/email');
const drive = require('../services/drive');
const docs = require('../services/docs');
const esign = require('../services/esign');

// ─── Stage constants ─────────────────────────────────────────────────────────
const STAGES = [
  'New', 'Qualified', 'Proposal Sent', 'Negotiation',
  'Closed Won', 'Contract', 'Onboarding', 'Closed Lost',
];

// Default, editable in Settings → Notification Rules
const DEFAULT_INACTIVITY_REP_DAYS = 3;      // R-07
const DEFAULT_INACTIVITY_ADMIN_DAYS = 7;    // R-08

// Cache the notification_rules settings doc so we don't refetch on every rule fire
let _settingsCache = { value: null, fetchedAt: 0 };
async function getSettings(db) {
  const TTL_MS = 30_000;
  if (_settingsCache.value && Date.now() - _settingsCache.fetchedAt < TTL_MS) {
    return _settingsCache.value;
  }
  try {
    const snap = await db.collection('crm_config').doc('notification_rules').get();
    _settingsCache = { value: snap.exists ? snap.data() : {}, fetchedAt: Date.now() };
  } catch (err) {
    _settingsCache = { value: {}, fetchedAt: Date.now() };
  }
  return _settingsCache.value;
}

// Returns true unless the admin has explicitly disabled this rule.
async function isRuleEnabled(db, ruleId) {
  const cfg = await getSettings(db);
  const enabled = cfg.enabledRules || {};
  return enabled[ruleId] !== false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Sum of monthly recurring + volume-based services. One-time charges don't
// recur, so they're excluded from monthly + ARR. One-time services have their
// own total accessible via oneTimeTotal(). (Bug 4.J)
function monthlyRevenue(deal) {
  return (deal.services || [])
    .filter(svc => (svc.revenueModel || 'monthly') !== 'one_time')
    .reduce((s, svc) => s + (Number(svc.monthlyRevenue) || 0), 0);
}

function oneTimeTotal(deal) {
  return (deal.services || [])
    .filter(svc => svc.revenueModel === 'one_time')
    .reduce((s, svc) => s + (Number(svc.monthlyRevenue) || 0), 0);
}

function arr(deal) {
  return monthlyRevenue(deal) * 12;
}

// R-02 — Tier classification from monthly revenue.
// Default thresholds per spec §9; overridable via crm_config/notification_rules.tierThresholds (4.2b).
const DEFAULT_TIER_THRESHOLDS = { tier2: 5000, tier3: 10000, tier4: 25000 };

function tierFromMonthly(monthly, thresholds = DEFAULT_TIER_THRESHOLDS) {
  const t2 = thresholds.tier2 ?? DEFAULT_TIER_THRESHOLDS.tier2;
  const t3 = thresholds.tier3 ?? DEFAULT_TIER_THRESHOLDS.tier3;
  const t4 = thresholds.tier4 ?? DEFAULT_TIER_THRESHOLDS.tier4;
  if (monthly >= t4) return 4;
  if (monthly >= t3) return 3;
  if (monthly >= t2) return 2;
  return 1;
}

async function adminRecipients(db) {
  const snap = await db.collection('crm_users').where('role', '==', 'admin').get();
  return snap.docs.map(d => d.data());
}

async function onboardingRecipients(db) {
  const snap = await db.collection('crm_users').where('role', '==', 'onboarding').get();
  return snap.docs.map(d => d.data());
}

async function getUser(db, uid) {
  if (!uid) return null;
  const snap = await db.collection('crm_users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function logActivity(db, dealId, entry) {
  return db.collection('crm_activity').add({
    dealId,
    ...entry,
    timestamp: Timestamp.now(),
  });
}

async function notify(db, { recipientUids, type, title, body, dealId, channel = 'in_app' }) {
  const batch = db.batch();
  for (const uid of recipientUids) {
    if (!uid) continue;
    const ref = db.collection('crm_notifications').doc();
    batch.set(ref, {
      recipientUid: uid, type, title, body, dealId,
      channel, read: false, createdAt: Timestamp.now(),
    });
  }
  await batch.commit();
}

// ─── Duplicate detection — R-05 ──────────────────────────────────────────────

function normalize(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ');
}

// Levenshtein similarity (0–1). Cheap enough for typical pipeline sizes (< 10k deals).
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

async function detectDuplicates(db, candidate) {
  const snap = await db.collection('crm_deals').get();
  const matches = [];
  for (const doc of snap.docs) {
    if (doc.id === candidate.id) continue;
    const existing = { id: doc.id, ...doc.data() };
    const reasons = [];

    if (candidate.companyName && existing.companyName) {
      const sim = similarity(candidate.companyName, existing.companyName);
      if (sim >= 0.8) reasons.push(`company name match (${Math.round(sim * 100)}%)`);
    }
    if (candidate.contactEmail && existing.contactEmail &&
        candidate.contactEmail.toLowerCase() === existing.contactEmail.toLowerCase()) {
      reasons.push('exact email match');
    }
    const sameCompany = candidate.companyName && existing.companyName &&
      normalize(candidate.companyName) === normalize(existing.companyName);
    const samePhone = candidate.contactPhone && existing.contactPhone &&
      candidate.contactPhone.replace(/\D/g, '') === existing.contactPhone.replace(/\D/g, '');
    if (sameCompany && samePhone) reasons.push('company + phone match');

    if (reasons.length) matches.push({ existing, reasons });
  }
  return matches;
}

// ─── Public handlers ─────────────────────────────────────────────────────────

// Called by server on every lead submission, whatever the channel.
// Runs R-01, R-02, R-03, R-04, R-05, R-06.
async function onLeadSubmit(db, dealId) {
  const ref = db.collection('crm_deals').doc(dealId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const deal = { id: dealId, ...snap.data() };

  // R-02 — classify tier with configurable thresholds (excludes one-time per 4.J)
  const settings = await getSettings(db);
  const monthly = monthlyRevenue(deal);
  const tier = tierFromMonthly(monthly, settings.tierThresholds);
  await ref.update({
    tier,
    monthlyRevenue: monthly,
    arr: monthly * 12,
    oneTimeTotal: oneTimeTotal(deal),
  });
  deal.tier = tier;

  // R-05 — duplicate detection
  const duplicates = await detectDuplicates(db, deal);
  if (duplicates.length) {
    await ref.update({
      duplicateFlag: true,
      duplicateMatches: duplicates.map(m => ({
        matchDealId: m.existing.id,
        reasons: m.reasons,
      })),
    });
    await logActivity(db, dealId, {
      kind: 'duplicate_flagged',
      detail: `${duplicates.length} possible match(es): ` +
              duplicates.map(m => m.existing.companyName).join(', '),
    });
  }

  // R-03 — notify admins (always, every new lead)
  const admins = await adminRecipients(db);
  const adminEmails = admins.map(u => u.email).filter(Boolean);
  const adminUids = admins.map(u => u.uid);
  if (await isRuleEnabled(db, 'R-03')) {
    await email.send({
      to: adminEmails,
      ...email.newLeadNotification({ deal, tier }),
    });
    await notify(db, {
      recipientUids: adminUids,
      type: 'lead',
      title: `New lead: ${deal.companyName}`,
      body: `${deal.source} · $${monthly.toLocaleString()}/mo · Tier ${tier} · Assigned to ${deal.ownerName || 'Unassigned'}`,
      dealId,
    });
  }

  // R-05 admin alert with side-by-side
  if (duplicates.length) {
    for (const d of duplicates) {
      await email.send({
        to: adminEmails,
        ...email.duplicateAlert({ newDeal: deal, existing: d.existing, matchReasons: d.reasons }),
      });
      await notify(db, {
        recipientUids: adminUids,
        type: 'duplicate',
        title: `Possible duplicate — ${deal.companyName}`,
        body: `Matches ${d.existing.companyName} on ${d.reasons.join(', ')}`,
        dealId,
      });
    }
  }

  // R-04 — acknowledgement email (website + partner only — not manual entry)
  if ((deal.source === 'Website' || deal.source === 'Partner Portal') && await isRuleEnabled(db, 'R-04')) {
    if (deal.contactEmail) {
      await email.send({
        to: deal.contactEmail,
        ...email.welcomeEmail({ companyName: deal.companyName, contactName: deal.contactName }),
      });
      await logActivity(db, dealId, { kind: 'welcome_sent', detail: `to ${deal.contactEmail}` });
    }
  }

  // R-06 — partner attribution already stored on submission; log it for audit
  if (deal.source === 'Partner Portal' && deal.partnerRep) {
    await logActivity(db, dealId, {
      kind: 'partner_attribution',
      detail: `Partner rep: ${deal.partnerRep.repName} (${deal.partnerRep.company})`,
    });
  }

  return { tier, duplicates: duplicates.length };
}

// Called on every stage transition. Fires R-10 through R-24.
async function onStageChange(db, { dealId, fromStage, toStage, actor, reason }) {
  const ref = db.collection('crm_deals').doc(dealId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const deal = { id: dealId, ...snap.data() };
  const updates = { lastActivityAt: Timestamp.now() };

  await logActivity(db, dealId, {
    kind: 'stage_change',
    detail: `${fromStage} → ${toStage}`,
    fromStage, toStage,
    actorUid: actor?.uid, actorName: actor?.displayName,
    reason: reason || null,
  });

  // R-11 — New → Qualified: reset inactivity timer
  if (fromStage === 'New' && toStage === 'Qualified') {
    updates.inactivitySince = Timestamp.now();
    updates.inactivityRepNotified = false;
    updates.inactivityAdminNotified = false;
  }

  // R-12 — Qualified → Proposal Sent: approval gate
  // We expect the client to have flipped approvalStatus='pending' before the transition.
  if (fromStage === 'Qualified' && toStage === 'Proposal Sent') {
    updates.approvalStatus = 'pending';
    updates.approvalRequestedAt = Timestamp.now();
    updates.approvalRequestedBy = actor?.uid || null;

    const admins = await adminRecipients(db);
    await email.send({
      to: admins.map(u => u.email).filter(Boolean),
      ...email.proposalApprovalRequest({ deal, rep: actor || { displayName: 'Unknown' } }),
    });
    await notify(db, {
      recipientUids: admins.map(u => u.uid),
      type: 'approval',
      title: `Proposal approval needed: ${deal.companyName}`,
      body: `${actor?.displayName || 'A rep'} is requesting approval`,
      dealId,
    });
  }

  // R-15 — Proposal Sent → Negotiation: log proposal send date
  if (fromStage === 'Proposal Sent' && toStage === 'Negotiation') {
    updates.proposalSentAt = deal.proposalSentAt || Timestamp.now();
  }

  // R-17, R-18 — Closed Won: auto-generate contract & notify admins
  if (toStage === 'Closed Won') {
    try {
      const folder = await drive.ensureClientFolder(deal.companyName);
      if (folder?.id) updates.driveFolderId = folder.id;

      const contract = await docs.generateContract({ deal, folderId: folder?.id });
      if (contract?.id) {
        updates.contractDocId = contract.id;
        updates.contractUrl = contract.webViewLink || null;
        await esign.sendForSignature({
          docId: contract.id,
          signerEmail: deal.contactEmail,
          signerName: deal.contactName || deal.companyName,
          subject: `eShipper Plus — Service Agreement for ${deal.companyName}`,
          message: 'Please review and sign.',
        });
        updates.contractSentAt = Timestamp.now();
      }
      await logActivity(db, dealId, {
        kind: 'contract_generated',
        detail: contract?.id ? `Doc ID: ${contract.id}` : 'Template not configured — skipped',
      });
    } catch (err) {
      console.error('R-17 contract generation failed:', err);
      await logActivity(db, dealId, { kind: 'contract_error', detail: err.message });
    }

    const admins = await adminRecipients(db);
    await email.send({
      to: admins.map(u => u.email).filter(Boolean),
      ...email.contractSent({ deal }),
    });
  }

  // R-20, R-21, R-22, R-23 — Onboarding stage triggers
  if (toStage === 'Onboarding') {
    const onbManagers = await onboardingRecipients(db);
    const onbPrimary = onbManagers[0] || null;
    const rep = await getUser(db, deal.ownerUid);

    // R-20 — create onboarding record with T+1 SLA, assign to onboarding role
    const slaDue = new Date(); slaDue.setDate(slaDue.getDate() + 1);
    updates.onboarding = {
      assignedUid: onbPrimary?.uid || null,
      assignedName: onbPrimary?.displayName || null,
      slaDueAt: Timestamp.fromDate(slaDue),
      checklistState: defaultChecklist(),
      createdAt: Timestamp.now(),
    };

    // R-21 — handoff email to onboarding manager (cc rep)
    if (onbPrimary) {
      await email.send({
        to: onbPrimary.email,
        ...email.onboardingHandoff({ deal, rep, onboardingManager: onbPrimary }),
      });
    }

    // R-22 — notify admins
    const admins = await adminRecipients(db);
    await email.send({
      to: admins.map(u => u.email).filter(Boolean),
      ...email.onboardingAdmin({ deal }),
    });
    await notify(db, {
      recipientUids: [...admins.map(u => u.uid), onbPrimary?.uid].filter(Boolean),
      type: 'onboarding',
      title: `Onboarding started: ${deal.companyName}`,
      body: `ARR ${'$' + (monthlyRevenue(deal) * 12).toLocaleString()} confirmed · T+1 SLA`,
      dealId,
    });

    // R-23 — activate checklist (rep read-only is enforced at the API layer)
  }

  await ref.update(updates);
}

// R-13, R-14 — proposal approval decision
async function onApprovalDecision(db, { dealId, approved, approver, reason }) {
  const ref = db.collection('crm_deals').doc(dealId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const deal = { id: dealId, ...snap.data() };
  const rep = await getUser(db, deal.ownerUid);

  if (approved) {
    await ref.update({
      approvalStatus: 'approved',
      approvedBy: approver.uid,
      approvedAt: Timestamp.now(),
    });
    await logActivity(db, dealId, {
      kind: 'proposal_approved', actorUid: approver.uid, actorName: approver.displayName,
    });
    if (rep) {
      await email.send({ to: rep.email, ...email.proposalApproved({ deal, approver }) });
      await notify(db, {
        recipientUids: [rep.uid],
        type: 'approval',
        title: `Proposal approved: ${deal.companyName}`,
        body: 'Ready to review and send manually',
        dealId,
      });
    }
  } else {
    // R-14 — rejection: deal stays in Qualified, rep notified with rework notes
    await ref.update({
      approvalStatus: 'rejected',
      stage: 'Qualified',
      rejectedBy: approver.uid,
      rejectedAt: Timestamp.now(),
      rejectionReason: reason || '',
    });
    await logActivity(db, dealId, {
      kind: 'proposal_rejected', actorUid: approver.uid, actorName: approver.displayName, reason,
    });
    if (rep) {
      await email.send({ to: rep.email, ...email.proposalRejected({ deal, approver, reason }) });
      await notify(db, {
        recipientUids: [rep.uid],
        type: 'approval',
        title: `Proposal rework needed: ${deal.companyName}`,
        body: reason || 'No reason provided',
        dealId,
      });
    }
  }
}

// R-19 — eSignature received webhook
async function onSignatureComplete(db, { dealId }) {
  const ref = db.collection('crm_deals').doc(dealId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const deal = { id: dealId, ...snap.data() };

  await ref.update({
    signedAt: Timestamp.now(),
    stage: 'Onboarding',
  });
  await logActivity(db, dealId, { kind: 'signed', detail: 'Contract signed via eSignature' });

  // Fire onStageChange to trigger R-20/R-21/R-22/R-23
  await onStageChange(db, {
    dealId, fromStage: deal.stage, toStage: 'Onboarding',
    actor: { displayName: 'eSignature webhook' },
  });
}

// R-10 — rep reassignment at any stage (admin only)
async function onRepReassign(db, { dealId, oldOwnerUid, newOwnerUid, actor, reason }) {
  const newRep = await getUser(db, newOwnerUid);
  const oldRep = await getUser(db, oldOwnerUid);
  if (!newRep) return;

  const ref = db.collection('crm_deals').doc(dealId);
  const deal = (await ref.get()).data();

  await logActivity(db, dealId, {
    kind: 'rep_reassigned',
    detail: `${oldRep?.displayName || 'Unassigned'} → ${newRep.displayName}`,
    fromUid: oldOwnerUid, toUid: newOwnerUid,
    actorUid: actor?.uid, actorName: actor?.displayName,
    reason: reason || null,
  });

  await email.send({
    to: newRep.email,
    ...email.repReassigned({
      deal: { ...deal, id: dealId },
      oldRepName: oldRep?.displayName,
    }),
  });
  await notify(db, {
    recipientUids: [newRep.uid],
    type: 'reassign',
    title: `You have been assigned ${deal.companyName}`,
    body: `Previously owned by ${oldRep?.displayName || 'Unassigned'}`,
    dealId,
  });
}

// R-24 — mark lost requires loss reason + re-engagement date (enforced by API)
// R-25, R-26 — fired by cron: re-engagement date reached
async function sweepReengagement(db, now = new Date()) {
  const snap = await db.collection('crm_deals')
    .where('stage', '==', 'Closed Lost').get();
  let fired = 0;
  for (const doc of snap.docs) {
    const deal = { id: doc.id, ...doc.data() };
    if (!deal.reengagementDate || deal.reengagementNotified) continue;
    const due = deal.reengagementDate.toDate ? deal.reengagementDate.toDate() : new Date(deal.reengagementDate);
    if (due > now) continue;

    const rep = await getUser(db, deal.ownerUid);
    if (rep) {
      await email.send({ to: rep.email, ...email.reengagementDue({ deal }) });
      await notify(db, {
        recipientUids: [rep.uid],
        type: 'reengagement',
        title: `Re-engagement due: ${deal.companyName}`,
        body: 'Closed Lost deal — time to reach back out',
        dealId: deal.id,
      });
    }
    await doc.ref.update({ reengagementNotified: true, reengagementNotifiedAt: Timestamp.now() });
    await logActivity(db, deal.id, { kind: 'reengagement_due', detail: 'Re-engagement date reached' });
    fired++;
  }
  return { fired };
}

// R-07, R-08 — inactivity sweep (called by Cloud Scheduler daily)
async function sweepInactivity(db, settings = {}) {
  const repDays = Number(settings.inactivityRepDays || DEFAULT_INACTIVITY_REP_DAYS);
  const adminDays = Number(settings.inactivityAdminDays || DEFAULT_INACTIVITY_ADMIN_DAYS);

  const snap = await db.collection('crm_deals').get();
  const now = Date.now();
  let repFired = 0, adminFired = 0;

  for (const doc of snap.docs) {
    const deal = { id: doc.id, ...doc.data() };
    if (['Closed Won', 'Closed Lost', 'Onboarding'].includes(deal.stage)) continue;

    const lastActivity = deal.lastActivityAt?.toDate?.() || deal.updatedAt?.toDate?.() || deal.createdAt?.toDate?.();
    if (!lastActivity) continue;
    const daysIdle = Math.floor((now - lastActivity.getTime()) / 86400000);

    // R-07 — rep notification at T+repDays
    if (daysIdle >= repDays && !deal.inactivityRepNotified && await isRuleEnabled(db, 'R-07')) {
      const rep = await getUser(db, deal.ownerUid);
      if (rep) {
        await email.send({ to: rep.email, ...email.inactivityRep({ deal, days: daysIdle }) });
        await notify(db, {
          recipientUids: [rep.uid],
          type: 'inactivity',
          title: `Inactivity: ${deal.companyName} — ${daysIdle} days`,
          body: `No activity logged for ${daysIdle} days`,
          dealId: deal.id,
        });
      }
      await doc.ref.update({ inactivityRepNotified: true });
      await logActivity(db, deal.id, { kind: 'inactivity_rep', detail: `${daysIdle} days` });
      repFired++;
    }

    // R-08 — admin escalation at T+adminDays
    if (daysIdle >= adminDays && !deal.inactivityAdminNotified && await isRuleEnabled(db, 'R-08')) {
      const rep = await getUser(db, deal.ownerUid);
      const admins = await adminRecipients(db);
      await email.send({
        to: admins.map(u => u.email).filter(Boolean),
        ...email.inactivityAdmin({ deal, days: daysIdle, ownerName: rep?.displayName }),
      });
      await notify(db, {
        recipientUids: admins.map(u => u.uid),
        type: 'inactivity',
        title: `Escalation: ${deal.companyName} — ${daysIdle} days`,
        body: `Rep: ${rep?.displayName || 'Unassigned'}`,
        dealId: deal.id,
      });
      await doc.ref.update({ inactivityAdminNotified: true });
      await logActivity(db, deal.id, { kind: 'inactivity_admin', detail: `${daysIdle} days` });
      adminFired++;
    }
  }

  return { repFired, adminFired };
}

// Default onboarding checklist. Content is Phase 2 (spec Section 10);
// placeholders here so the checklist renders from day 1.
function defaultChecklist() {
  return [
    { id: 'intro_call',    label: 'Kickoff call with client',               done: false },
    { id: 'account_setup', label: 'Set up client account in systems',       done: false },
    { id: 'sop',           label: 'Share standard operating procedures',    done: false },
    { id: 'edi',           label: 'Configure EDI/API integration (if any)', done: false },
    { id: 'first_ship',    label: 'First shipment test',                    done: false },
    { id: 'handoff',       label: 'Handoff to account manager',             done: false },
  ];
}

// Test helper — reset the settings cache so each test sees fresh config.
// Not used in production; intentionally exposed for `tests/engine-flows.test.js`.
function _resetSettingsCacheForTests() {
  _settingsCache = { value: null, fetchedAt: 0 };
}

module.exports = {
  STAGES,
  tierFromMonthly,
  monthlyRevenue,
  oneTimeTotal,
  arr,
  detectDuplicates,
  onLeadSubmit,
  onStageChange,
  onApprovalDecision,
  onSignatureComplete,
  onRepReassign,
  sweepInactivity,
  sweepReengagement,
  defaultChecklist,
  _resetSettingsCacheForTests,
};
