'use strict';

// One-shot seed for local dev + first deploy.
// Usage:
//   export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/sa.json)"
//   node dev_setup.js

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const sa = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;
if (!sa) {
  console.error('Set FIREBASE_SERVICE_ACCOUNT env var first');
  process.exit(1);
}

initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
const auth = getAuth();

// ─── Seed data ───────────────────────────────────────────────────────────────
const INVITES = [
  { email: 'ahmed@eshipperplus.com',   displayName: 'Ahmed D.',      role: 'admin' },
  { email: 'aamer@eshipperplus.com',   displayName: 'Aamer A.',      role: 'admin' },
  { email: 'sara@eshipperplus.com',    displayName: 'Sara K.',       role: 'rep' },
  { email: 'james@eshipperplus.com',   displayName: 'James T.',      role: 'rep' },
  { email: 'priya@eshipperplus.com',   displayName: 'Priya L.',      role: 'rep' },
  { email: 'kim@eshipperplus.com',     displayName: 'Kim W.',        role: 'onboarding' },
  { email: 'divyanka@eshipperplus.com', displayName: 'Divyanka K.',  role: 'finance' },
];

const NOTIFICATION_RULES = {
  inactivityRepDays: 3,
  inactivityAdminDays: 7,
  welcomeEmailEnabled: true,
  adminRecipientsOverride: [],
};

const PARTNER_REPS = [
  { company: 'Acme Logistics Brokers', repName: 'Jordan Smith' },
  { company: 'Acme Logistics Brokers', repName: 'Lina Chou' },
  { company: 'BlueDot Partners',       repName: 'Alex Morgan' },
];

// ─── Run ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Seeding invites...');
  for (const inv of INVITES) {
    await db.collection('crm_invites').doc(inv.email).set({
      ...inv, invitedAt: Timestamp.now(),
    });
    console.log(`  ↳ ${inv.email} (${inv.role})`);
  }

  console.log('Seeding notification_rules...');
  await db.collection('crm_config').doc('notification_rules').set({
    ...NOTIFICATION_RULES, updatedAt: Timestamp.now(),
  });

  console.log('Seeding partner_rep_directory...');
  await db.collection('crm_config').doc('partner_rep_directory').set({
    entries: PARTNER_REPS, uploadedAt: Timestamp.now(), rowCount: PARTNER_REPS.length,
  });

  console.log('Done. Invited users will get their role assigned on first sign-in via Google SSO.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
