'use strict';

// eShipper Plus CRM — Phase 1 MVP backend
// Cloud Run (Node/Express) + Firestore + Firebase Auth (Google SSO)
// All rule logic lives in rules/engine.js. All external integrations live in services/*.

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const rules = require('./rules/engine');
const esignService = require('./services/esign');

// ─── Firebase init ──────────────────────────────────────────────────────────
const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
const PROJECT_ID = process.env.GCP_PROJECT || 'eshipper-f56c3';
initializeApp(saEnv
  ? { credential: cert(JSON.parse(saEnv)), projectId: PROJECT_ID }
  : { projectId: PROJECT_ID });

const db = getFirestore();
const auth = getAuth();

// ─── Constants ──────────────────────────────────────────────────────────────
const ROLES = ['admin', 'rep', 'onboarding', 'finance'];
const STAGES = rules.STAGES;

const STAGE_PROGRESSION = {
  'New': ['Qualified', 'Closed Lost'],
  'Qualified': ['Proposal Sent', 'Closed Lost'],
  'Proposal Sent': ['Negotiation', 'Qualified', 'Closed Lost'],
  'Negotiation': ['Closed Won', 'Proposal Sent', 'Closed Lost'],
  'Closed Won': ['Contract', 'Onboarding'],
  'Contract': ['Onboarding', 'Closed Won'],
  'Onboarding': [],
  'Closed Lost': ['New'],
};

// ─── Express setup ──────────────────────────────────────────────────────────
const app = express();
app.use(helmet({
  contentSecurityPolicy: false,
  // Firebase Auth popup needs to read from the popup window — strict COOP breaks it
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
});
app.use('/api/', apiLimiter);

// Public intake endpoints get a tighter limit (abuse protection)
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
});
app.use('/public/', publicLimiter);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Auth middleware ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  try {
    const decoded = await auth.verifyIdToken(header.slice(7));
    req.uid = decoded.uid;
    req.email = decoded.email;

    const userRef = db.collection('crm_users').doc(decoded.uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      // Check for an invite that pre-sets role
      const inviteSnap = await db.collection('crm_invites').doc(decoded.email.toLowerCase()).get();
      const invite = inviteSnap.exists ? inviteSnap.data() : null;
      const role = invite?.role || 'rep';
      const userData = {
        uid: decoded.uid,
        email: decoded.email,
        displayName: invite?.displayName || decoded.name || decoded.email.split('@')[0],
        role,
        createdAt: Timestamp.now(),
        lastSeen: Timestamp.now(),
      };
      await userRef.set(userData);
      if (invite) inviteSnap.ref.delete().catch(() => {});
      auth.setCustomUserClaims(decoded.uid, { role }).catch(() => {});
      req.user = userData;
    } else {
      const data = snap.data();
      userRef.update({ lastSeen: Timestamp.now() }).catch(() => {});
      if (decoded.role !== data.role) {
        auth.setCustomUserClaims(decoded.uid, { role: data.role }).catch(() => {});
      }
      req.user = data;
    }
    next();
  } catch (err) {
    console.error('requireAuth error:', err.message);
    return res.status(401).json({ error: 'Invalid auth token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Session / me ───────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    uid: req.uid, email: req.user.email, displayName: req.user.displayName,
    role: req.user.role,
  });
});

// ─── Users (admin only for writes; all authenticated for read) ──────────────
app.get('/api/users', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_users').orderBy('displayName').get();
  res.json(snap.docs.map(d => d.data()));
});

app.post('/api/users/invite', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, displayName, role } = req.body || {};
  if (!email || !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid payload' });
  await db.collection('crm_invites').doc(email.toLowerCase()).set({
    email: email.toLowerCase(), displayName: displayName || email,
    role, invitedBy: req.uid, invitedAt: Timestamp.now(),
  });
  res.json({ ok: true });
});

app.patch('/api/users/:uid', requireAuth, requireRole('admin'), async (req, res) => {
  const allowed = ['role', 'displayName'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if (updates.role && !ROLES.includes(updates.role)) return res.status(400).json({ error: 'Invalid role' });
  await db.collection('crm_users').doc(req.params.uid).update(updates);
  if (updates.role) auth.setCustomUserClaims(req.params.uid, { role: updates.role }).catch(() => {});
  res.json({ ok: true });
});

app.delete('/api/users/:uid', requireAuth, requireRole('admin'), async (req, res) => {
  if (req.params.uid === req.uid) return res.status(400).json({ error: 'Cannot delete yourself' });
  await db.collection('crm_users').doc(req.params.uid).delete();
  auth.deleteUser(req.params.uid).catch(() => {});
  res.json({ ok: true });
});

// ─── Deals ──────────────────────────────────────────────────────────────────
app.get('/api/deals', requireAuth, async (req, res) => {
  // Reps/onboarding/finance see all read-only; admin also has all; filtering is client-side
  const q = db.collection('crm_deals');
  let snap;
  if (req.query.stage) {
    snap = await q.where('stage', '==', req.query.stage).orderBy('updatedAt', 'desc').get();
  } else {
    snap = await q.orderBy('updatedAt', 'desc').limit(500).get();
  }
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.get('/api/deals/:id', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_deals').doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  res.json({ id: snap.id, ...snap.data() });
});

app.post('/api/deals', requireAuth, requireRole('admin', 'rep'), async (req, res) => {
  const payload = sanitizeDealInput(req.body);
  payload.source = payload.source || 'Manual Entry';
  payload.stage = 'New';
  payload.ownerUid = payload.ownerUid || req.uid;
  payload.ownerName = (await userName(payload.ownerUid)) || req.user.displayName;
  payload.createdAt = Timestamp.now();
  payload.updatedAt = Timestamp.now();
  payload.lastActivityAt = Timestamp.now();
  payload.createdBy = req.uid;

  const docRef = await db.collection('crm_deals').add(payload);
  rules.onLeadSubmit(db, docRef.id).catch(err => console.error('onLeadSubmit error', err));
  res.json({ id: docRef.id, ...payload });
});

app.patch('/api/deals/:id', requireAuth, requireRole('admin', 'rep'), async (req, res) => {
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const current = snap.data();

  // Rep ownership: only the assigned rep or an admin can edit (old rep is read-only after reassignment)
  if (req.user.role === 'rep' && current.ownerUid !== req.uid) {
    return res.status(403).json({ error: 'Deal is read-only — assigned to another rep' });
  }
  // Stage moves happen through /stage — reject stage changes here
  if ('stage' in req.body && req.body.stage !== current.stage) {
    return res.status(400).json({ error: 'Use POST /api/deals/:id/stage to change stage' });
  }
  // Onboarding checklist: rep read-only (R-23)
  if (req.user.role === 'rep' && req.body.onboarding) {
    return res.status(403).json({ error: 'Onboarding checklist is read-only for reps' });
  }

  const updates = sanitizeDealInput(req.body, { partial: true });
  updates.updatedAt = Timestamp.now();
  updates.lastActivityAt = Timestamp.now();

  // Recalculate tier if services changed (R-02)
  if (req.body.services) {
    const monthly = rules.monthlyRevenue({ services: req.body.services });
    updates.tier = rules.tierFromMonthly(monthly);
    updates.monthlyRevenue = monthly;
    updates.arr = monthly * 12;
  }

  await ref.update(updates);
  await db.collection('crm_activity').add({
    dealId: req.params.id, kind: 'edit',
    actorUid: req.uid, actorName: req.user.displayName,
    timestamp: Timestamp.now(),
    detail: Object.keys(updates).filter(k => !['updatedAt', 'lastActivityAt'].includes(k)).join(', '),
  });
  res.json({ ok: true });
});

// Stage transition — soft prompts only, Closed Lost requires loss reason + re-engagement date
app.post('/api/deals/:id/stage', requireAuth, requireRole('admin', 'rep'), async (req, res) => {
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const deal = snap.data();

  if (req.user.role === 'rep' && deal.ownerUid !== req.uid) {
    return res.status(403).json({ error: 'Deal is read-only' });
  }

  const { toStage, reason, lossReason, reengagementDate } = req.body || {};
  if (!STAGES.includes(toStage)) return res.status(400).json({ error: 'Invalid stage' });

  // R-24 — Closed Lost requires loss reason + re-engagement date
  if (toStage === 'Closed Lost') {
    if (!lossReason || !reengagementDate) {
      return res.status(400).json({ error: 'Loss reason and re-engagement date are required' });
    }
  }

  // R-12 — Qualified → Proposal Sent: approval gate (not a hard block, but the
  // API short-circuits: it flips the deal into "pending approval" state and
  // does NOT change the stage until the admin approves.
  if (deal.stage === 'Qualified' && toStage === 'Proposal Sent' &&
      deal.approvalStatus !== 'approved') {
    await ref.update({
      approvalStatus: 'pending',
      approvalRequestedAt: Timestamp.now(),
      approvalRequestedBy: req.uid,
      updatedAt: Timestamp.now(),
    });
    // Fire the notification side of R-12
    await rules.onStageChange(db, {
      dealId: req.params.id, fromStage: deal.stage, toStage: 'Proposal Sent',
      actor: req.user, reason,
    });
    return res.json({ status: 'pending_approval' });
  }

  const updates = {
    stage: toStage,
    updatedAt: Timestamp.now(),
    lastActivityAt: Timestamp.now(),
  };
  if (toStage === 'Closed Lost') {
    updates.lossReason = lossReason;
    updates.reengagementDate = Timestamp.fromDate(new Date(reengagementDate));
    updates.reengagementNotified = false;
  }
  await ref.update(updates);

  rules.onStageChange(db, {
    dealId: req.params.id,
    fromStage: deal.stage, toStage,
    actor: req.user, reason,
  }).catch(err => console.error('onStageChange error', err));

  res.json({ ok: true, stage: toStage });
});

// R-13, R-14 — approval decision
app.post('/api/deals/:id/approval', requireAuth, requireRole('admin'), async (req, res) => {
  const { approved, reason } = req.body || {};
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const deal = snap.data();
  if (deal.approvalStatus !== 'pending') {
    return res.status(400).json({ error: 'No pending approval for this deal' });
  }

  if (approved) {
    // Advance to Proposal Sent now that approval is granted
    await ref.update({ stage: 'Proposal Sent', updatedAt: Timestamp.now(), lastActivityAt: Timestamp.now() });
  }
  await rules.onApprovalDecision(db, {
    dealId: req.params.id, approved, approver: req.user, reason,
  });
  res.json({ ok: true });
});

// R-10 — admin-only rep reassignment at any stage
app.post('/api/deals/:id/reassign', requireAuth, requireRole('admin'), async (req, res) => {
  const { newOwnerUid, reason } = req.body || {};
  if (!newOwnerUid) return res.status(400).json({ error: 'newOwnerUid required' });
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const deal = snap.data();
  const oldOwnerUid = deal.ownerUid;

  const newOwnerName = await userName(newOwnerUid);
  await ref.update({
    ownerUid: newOwnerUid, ownerName: newOwnerName,
    updatedAt: Timestamp.now(), lastActivityAt: Timestamp.now(),
  });
  await rules.onRepReassign(db, {
    dealId: req.params.id, oldOwnerUid, newOwnerUid, actor: req.user, reason,
  });
  res.json({ ok: true });
});

// Mark duplicate decision (admin only)
app.post('/api/deals/:id/duplicate-decision', requireAuth, requireRole('admin'), async (req, res) => {
  const { action, mergeTargetId } = req.body || {}; // action: 'not_duplicate' | 'merge' | 'discard'
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });

  if (action === 'not_duplicate') {
    await ref.update({
      duplicateFlag: false, duplicateClearedBy: req.uid, duplicateClearedAt: Timestamp.now(),
    });
    await db.collection('crm_activity').add({
      dealId: req.params.id, kind: 'duplicate_cleared',
      actorUid: req.uid, actorName: req.user.displayName, timestamp: Timestamp.now(),
    });
  } else if (action === 'discard') {
    await ref.update({ discarded: true, discardedAt: Timestamp.now(), discardedBy: req.uid });
    await db.collection('crm_activity').add({
      dealId: req.params.id, kind: 'discarded',
      actorUid: req.uid, actorName: req.user.displayName, timestamp: Timestamp.now(),
    });
  } else if (action === 'merge' && mergeTargetId) {
    await ref.update({ mergedInto: mergeTargetId, mergedAt: Timestamp.now(), mergedBy: req.uid });
    await db.collection('crm_activity').add({
      dealId: req.params.id, kind: 'merged',
      detail: `Merged into ${mergeTargetId}`,
      actorUid: req.uid, actorName: req.user.displayName, timestamp: Timestamp.now(),
    });
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }
  res.json({ ok: true });
});

// Notes — any authenticated user who can edit the deal
app.post('/api/deals/:id/notes', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Empty note' });
  const ref = db.collection('crm_deals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });

  await db.collection('crm_activity').add({
    dealId: req.params.id, kind: 'note', detail: text.trim(),
    actorUid: req.uid, actorName: req.user.displayName,
    timestamp: Timestamp.now(),
  });
  await ref.update({ lastActivityAt: Timestamp.now() });
  res.json({ ok: true });
});

app.get('/api/deals/:id/activity', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_activity')
    .where('dealId', '==', req.params.id)
    .orderBy('timestamp', 'desc').limit(100).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// Onboarding checklist — admin + onboarding role only (R-23: rep read-only)
app.patch('/api/deals/:id/onboarding', requireAuth, requireRole('admin', 'onboarding'), async (req, res) => {
  const { checklistState } = req.body || {};
  if (!Array.isArray(checklistState)) return res.status(400).json({ error: 'checklistState array required' });
  await db.collection('crm_deals').doc(req.params.id).update({
    'onboarding.checklistState': checklistState,
    lastActivityAt: Timestamp.now(),
  });
  await db.collection('crm_activity').add({
    dealId: req.params.id, kind: 'onboarding_update',
    actorUid: req.uid, actorName: req.user.displayName, timestamp: Timestamp.now(),
  });
  res.json({ ok: true });
});

// ─── Public lead intake ─────────────────────────────────────────────────────
// Website form (R-01, R-03, R-04)
app.post('/public/leads/website', async (req, res) => {
  const deal = buildLeadFromPublicBody(req.body, 'Website');
  if (!deal) return res.status(400).json({ error: 'Invalid submission' });
  const docRef = await db.collection('crm_deals').add({
    ...deal, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastActivityAt: Timestamp.now(),
  });
  rules.onLeadSubmit(db, docRef.id).catch(err => console.error(err));
  res.json({ ok: true, dealId: docRef.id });
});

// Partner portal (R-01, R-03, R-04, R-06)
app.post('/public/leads/partner', async (req, res) => {
  const deal = buildLeadFromPublicBody(req.body, 'Partner Portal');
  if (!deal) return res.status(400).json({ error: 'Invalid submission' });
  // partnerRep: { company, repName } from the Settings → Partner Rep Directory
  if (req.body.partnerRep) {
    deal.partnerRep = {
      company: String(req.body.partnerRep.company || '').slice(0, 200),
      repName: String(req.body.partnerRep.repName || '').slice(0, 200),
    };
  }
  const docRef = await db.collection('crm_deals').add({
    ...deal, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastActivityAt: Timestamp.now(),
  });
  rules.onLeadSubmit(db, docRef.id).catch(err => console.error(err));
  res.json({ ok: true, dealId: docRef.id });
});

// Partner rep directory (for the public partner page to populate its dropdown)
app.get('/public/partner-reps', async (req, res) => {
  const snap = await db.collection('crm_config').doc('partner_rep_directory').get();
  res.json(snap.exists ? (snap.data().entries || []) : []);
});

// ─── Settings ───────────────────────────────────────────────────────────────
app.get('/api/settings/:key', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_config').doc(req.params.key).get();
  res.json(snap.exists ? snap.data() : {});
});

app.put('/api/settings/:key', requireAuth, requireRole('admin'), async (req, res) => {
  await db.collection('crm_config').doc(req.params.key).set({
    ...req.body, updatedAt: Timestamp.now(), updatedBy: req.uid,
  }, { merge: true });
  res.json({ ok: true });
});

// Partner rep directory — CSV/Excel upload (admin only)
app.post('/api/settings/partner-rep-directory/upload',
  requireAuth, requireRole('admin'), upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const entries = parseRepDirectory(req.file.buffer, req.file.originalname);
    if (!entries.length) return res.status(400).json({ error: 'No valid rows (need Company Name + Rep Name columns)' });
    await db.collection('crm_config').doc('partner_rep_directory').set({
      entries, uploadedAt: Timestamp.now(), uploadedBy: req.uid,
      filename: req.file.originalname, rowCount: entries.length,
    });
    res.json({ ok: true, count: entries.length });
  });

function parseRepDirectory(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let rows;
  if (ext === 'csv') {
    rows = csvParse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  return rows
    .map(r => {
      const company = r['Company Name'] || r['company'] || r['Company'] || r['company_name'];
      const repName = r['Rep Name'] || r['rep'] || r['Rep'] || r['rep_name'];
      return company && repName ? { company: String(company).trim(), repName: String(repName).trim() } : null;
    })
    .filter(Boolean);
}

// ─── Notifications ──────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_notifications')
    .where('recipientUid', '==', req.uid)
    .orderBy('createdAt', 'desc').limit(100).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await db.collection('crm_notifications').doc(req.params.id).update({
    read: true, readAt: Timestamp.now(),
  });
  res.json({ ok: true });
});

app.post('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_notifications')
    .where('recipientUid', '==', req.uid).where('read', '==', false).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, { read: true, readAt: Timestamp.now() }));
  await batch.commit();
  res.json({ ok: true, count: snap.size });
});

// ─── Dashboard summary ─────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  const snap = await db.collection('crm_deals').get();
  const deals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const active = deals.filter(d => !['Closed Lost'].includes(d.stage) && !d.discarded && !d.mergedInto);
  const totalPipeline = active.reduce((s, d) => s + (d.arr || 0), 0);

  const stageWeight = {
    'New': 0.10, 'Qualified': 0.25, 'Proposal Sent': 0.40,
    'Negotiation': 0.65, 'Closed Won': 0.90, 'Contract': 0.95,
    'Onboarding': 1.00, 'Closed Lost': 0,
  };
  const weighted = active.reduce((s, d) => s + (d.arr || 0) * (stageWeight[d.stage] || 0), 0);

  const won = deals.filter(d => ['Closed Won', 'Contract', 'Onboarding'].includes(d.stage)).length;
  const lost = deals.filter(d => d.stage === 'Closed Lost').length;
  const winRate = (won + lost) ? won / (won + lost) : 0;

  // Funnel
  const funnel = {};
  for (const stage of STAGES) {
    const stageDeals = active.filter(d => d.stage === stage);
    funnel[stage] = { count: stageDeals.length, value: stageDeals.reduce((s, d) => s + (d.arr || 0), 0) };
  }

  // By owner
  const byOwner = {};
  for (const d of active) {
    const key = d.ownerUid || 'unassigned';
    byOwner[key] = byOwner[key] || { uid: key, name: d.ownerName || 'Unassigned', deals: 0, pipeline: 0 };
    byOwner[key].deals += 1;
    byOwner[key].pipeline += (d.arr || 0);
  }

  // Sources
  const bySource = {};
  for (const d of active) bySource[d.source || 'Unknown'] = (bySource[d.source || 'Unknown'] || 0) + 1;

  res.json({
    activeDeals: active.length,
    pipelineValue: totalPipeline,
    weightedForecast: weighted,
    winRate,
    avgDealSize: active.length ? totalPipeline / active.length : 0,
    funnel,
    byOwner: Object.values(byOwner),
    bySource,
  });
});

// ─── Cron / webhooks ────────────────────────────────────────────────────────
// Cloud Scheduler hits this daily — requires X-Cron-Secret header
app.post('/cron/inactivity-sweep', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Forbidden' });
  }
  const settingsSnap = await db.collection('crm_config').doc('notification_rules').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const inactivity = await rules.sweepInactivity(db, settings);
  const reengagement = await rules.sweepReengagement(db);
  res.json({ ok: true, inactivity, reengagement });
});

// eSignature webhook — Workspace posts here when a document is signed
app.post('/webhooks/esignature', async (req, res) => {
  const { docId, status } = req.body || {};
  if (status !== 'completed' || !docId) return res.status(200).json({ ignored: true });
  const snap = await db.collection('crm_deals').where('contractDocId', '==', docId).limit(1).get();
  if (snap.empty) return res.status(404).json({ error: 'Deal not found for doc' });
  const deal = snap.docs[0];
  await rules.onSignatureComplete(db, { dealId: deal.id });
  res.json({ ok: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function sanitizeDealInput(body, { partial = false } = {}) {
  const out = {};
  const allowed = [
    'companyName', 'contactName', 'contactEmail', 'contactPhone',
    'industry', 'source', 'ownerUid', 'services', 'notes',
    'partnerRep', 'website',
  ];
  for (const k of allowed) if (k in body) out[k] = body[k];
  if (!partial) {
    if (!out.companyName) return null;
  }
  // Normalise services: array of { name, monthlyRevenue }
  if (out.services && Array.isArray(out.services)) {
    out.services = out.services
      .filter(s => s && s.name)
      .map(s => ({
        name: String(s.name).slice(0, 60),
        monthlyRevenue: Number(s.monthlyRevenue) || 0,
      }));
  }
  return out;
}

function buildLeadFromPublicBody(body, source) {
  if (!body?.companyName || !body?.contactEmail) return null;
  return {
    companyName: String(body.companyName).slice(0, 200),
    contactName: String(body.contactName || '').slice(0, 200),
    contactEmail: String(body.contactEmail).slice(0, 200),
    contactPhone: String(body.contactPhone || '').slice(0, 40),
    industry: String(body.industry || '').slice(0, 60),
    website: String(body.website || '').slice(0, 200),
    notes: String(body.notes || '').slice(0, 2000),
    source,
    stage: 'New',
    services: Array.isArray(body.services) ? body.services
      .filter(s => s && s.name)
      .map(s => ({ name: String(s.name).slice(0, 60), monthlyRevenue: Number(s.monthlyRevenue) || 0 }))
      : [],
    createdBy: null,
    ownerUid: null,
    ownerName: 'Unassigned',
  };
}

async function userName(uid) {
  if (!uid) return null;
  const snap = await db.collection('crm_users').doc(uid).get();
  return snap.exists ? snap.data().displayName : null;
}

// ─── SPA fallback ──────────────────────────────────────────────────────────
app.get('/partner', (req, res) => res.sendFile(path.join(__dirname, 'public/partner.html')));
app.get('/website-form', (req, res) => res.sendFile(path.join(__dirname, 'public/website-form.html')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/') ||
      req.path.startsWith('/cron/') || req.path.startsWith('/webhooks/')) return next();
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ─── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`CRM server listening on :${PORT}`));
