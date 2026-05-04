'use strict';

// Rule engine flow tests — exercise the multi-step lifecycle functions
// (onLeadSubmit, onStageChange, sweepInactivity, etc.) through the
// in-memory Firestore mock. These tests verify the SPEC behaviour:
// when a deal moves to Closed Won, a contract is generated; when a lead
// arrives, admins get notified; etc.

const { mockStore, mockDb, mockTimestamp } = require('./_helpers/firestore-mock');

// Mock external services BEFORE requiring the engine
jest.mock('../services/email', () => ({
  send: jest.fn().mockResolvedValue({ sent: false, dryRun: true }),
  welcomeEmail: jest.fn(() => ({ subject: 'welcome', html: '' })),
  newLeadNotification: jest.fn(() => ({ subject: 'new', html: '' })),
  duplicateAlert: jest.fn(() => ({ subject: 'dup', html: '' })),
  inactivityRep: jest.fn(() => ({ subject: 'i-r', html: '' })),
  inactivityAdmin: jest.fn(() => ({ subject: 'i-a', html: '' })),
  proposalApprovalRequest: jest.fn(() => ({ subject: 'pa', html: '' })),
  proposalApproved: jest.fn(() => ({ subject: 'ok', html: '' })),
  proposalRejected: jest.fn(() => ({ subject: 'rj', html: '' })),
  contractSent: jest.fn(() => ({ subject: 'cs', html: '' })),
  onboardingHandoff: jest.fn(() => ({ subject: 'ob', html: '' })),
  onboardingAdmin: jest.fn(() => ({ subject: 'oa', html: '' })),
  repReassigned: jest.fn(() => ({ subject: 'rr', html: '' })),
  reengagementDue: jest.fn(() => ({ subject: 're', html: '' })),
}));
jest.mock('../services/drive', () => ({
  ensureClientFolder: jest.fn().mockResolvedValue({ id: 'folder1', webViewLink: 'http://drive/folder1' }),
}));
jest.mock('../services/docs', () => ({
  generateContract: jest.fn().mockResolvedValue({ id: 'doc1', webViewLink: 'http://docs/doc1' }),
}));
jest.mock('../services/esign', () => ({
  sendForSignature: jest.fn().mockResolvedValue({ sent: false, dryRun: true }),
}));

// Stub firebase-admin/firestore so engine.js can import Timestamp/FieldValue
jest.mock('firebase-admin/firestore', () => {
  const helpers = require('./_helpers/firestore-mock');
  return {
    Timestamp: helpers.mockTimestamp,
    FieldValue: { arrayUnion: () => 'arrayUnion-marker' },
  };
});

const rules = require('../rules/engine');
const emailService = require('../services/email');
const docsService = require('../services/docs');
const driveService = require('../services/drive');
const esignService = require('../services/esign');

beforeEach(() => {
  mockStore.reset();
  jest.clearAllMocks();
  rules._resetSettingsCacheForTests();
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function seedAdmins() {
  mockStore.collections.crm_users = {
    a1: { uid: 'a1', email: 'ahmed@x.com', displayName: 'Ahmed', role: 'admin' },
    a2: { uid: 'a2', email: 'aamer@x.com', displayName: 'Aamer', role: 'admin' },
  };
}
function seedOnboarding() {
  mockStore.collections.crm_users = {
    ...mockStore.collections.crm_users,
    k1: { uid: 'k1', email: 'kim@x.com', displayName: 'Kim W.', role: 'onboarding' },
  };
}
function seedDeal(id, overrides = {}) {
  mockStore.collections.crm_deals = mockStore.collections.crm_deals || {};
  mockStore.collections.crm_deals[id] = {
    companyName: 'Test Co',
    contactEmail: 'contact@test.com',
    stage: 'New',
    source: 'Website',
    services: [{ name: 'Warehousing', monthlyRevenue: 30000 }],
    createdAt: mockTimestamp.now(),
    updatedAt: mockTimestamp.now(),
    lastActivityAt: mockTimestamp.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// onLeadSubmit (R-01..R-06)
// ═══════════════════════════════════════════════════════════════════════════
describe('onLeadSubmit', () => {
  test('R-02: classifies tier from monthly revenue', async () => {
    seedAdmins();
    seedDeal('d1', { services: [{ name: 'Freight', monthlyRevenue: 15000 }] });
    await rules.onLeadSubmit(mockDb, 'd1');
    expect(mockStore.collections.crm_deals.d1.tier).toBe(3);
    expect(mockStore.collections.crm_deals.d1.monthlyRevenue).toBe(15000);
    expect(mockStore.collections.crm_deals.d1.arr).toBe(180000);
  });

  test('R-03: notifies admins via email AND in-app', async () => {
    seedAdmins();
    seedDeal('d1');
    await rules.onLeadSubmit(mockDb, 'd1');
    // Email send was called with admin recipients
    expect(emailService.send).toHaveBeenCalled();
    const sendCalls = emailService.send.mock.calls;
    const adminCall = sendCalls.find(c => Array.isArray(c[0].to) && c[0].to.includes('ahmed@x.com'));
    expect(adminCall).toBeDefined();
    // Notifications written for both admins
    const notifs = Object.values(mockStore.collections.crm_notifications || {});
    const leadNotifs = notifs.filter(n => n.type === 'lead');
    expect(leadNotifs.length).toBeGreaterThanOrEqual(2); // both admins
  });

  test('R-04: sends welcome email for Website source', async () => {
    seedAdmins();
    seedDeal('d1', { source: 'Website', contactEmail: 'lead@biz.com', contactName: 'Jane' });
    await rules.onLeadSubmit(mockDb, 'd1');
    const calls = emailService.send.mock.calls;
    const welcomeCall = calls.find(c => c[0].to === 'lead@biz.com');
    expect(welcomeCall).toBeDefined();
    expect(emailService.welcomeEmail).toHaveBeenCalled();
  });

  test('R-04: sends welcome email for Partner Portal source', async () => {
    seedAdmins();
    seedDeal('d1', { source: 'Partner Portal' });
    await rules.onLeadSubmit(mockDb, 'd1');
    expect(emailService.welcomeEmail).toHaveBeenCalled();
  });

  test('R-04: does NOT send welcome email for Manual Entry source', async () => {
    seedAdmins();
    seedDeal('d1', { source: 'Manual Entry' });
    await rules.onLeadSubmit(mockDb, 'd1');
    expect(emailService.welcomeEmail).not.toHaveBeenCalled();
  });

  test('R-05: flags duplicate when company matches existing deal', async () => {
    seedAdmins();
    seedDeal('existing', { companyName: 'Acme Inc', contactEmail: 'old@acme.com' });
    seedDeal('new', { companyName: 'Acme Inc', contactEmail: 'new@acme.com' });
    await rules.onLeadSubmit(mockDb, 'new');
    expect(mockStore.collections.crm_deals.new.duplicateFlag).toBe(true);
    expect(mockStore.collections.crm_deals.new.duplicateMatches).toHaveLength(1);
    expect(mockStore.collections.crm_deals.new.duplicateMatches[0].matchDealId).toBe('existing');
    // Duplicate alert email + notification fired
    expect(emailService.duplicateAlert).toHaveBeenCalled();
  });

  test('R-05: does NOT flag when no match', async () => {
    seedAdmins();
    seedDeal('existing', { companyName: 'Apple', contactEmail: 'a@apple.com' });
    seedDeal('new', { companyName: 'Microsoft', contactEmail: 'b@ms.com' });
    await rules.onLeadSubmit(mockDb, 'new');
    expect(mockStore.collections.crm_deals.new.duplicateFlag).toBeUndefined();
  });

  test('R-06: logs partner attribution for Partner Portal source', async () => {
    seedAdmins();
    seedDeal('d1', {
      source: 'Partner Portal',
      partnerRep: { company: 'Acme Brokers', repName: 'Jordan' },
    });
    await rules.onLeadSubmit(mockDb, 'd1');
    const activity = Object.values(mockStore.collections.crm_activity || {});
    const attr = activity.find(a => a.kind === 'partner_attribution');
    expect(attr).toBeDefined();
    expect(attr.detail).toContain('Jordan');
  });

  test('respects enabledRules: R-03 disabled → no admin notify', async () => {
    seedAdmins();
    mockStore.collections.crm_config = {
      notification_rules: { enabledRules: { 'R-03': false } },
    };
    // Force settings cache miss by waiting (or just test that the path works)
    seedDeal('d1');
    // Note: settings cache TTL is 30s; first call will fetch fresh
    // We can't reliably test the cache here without exposing it, but we
    // verify that with R-03 disabled, no admin email is sent.
    await rules.onLeadSubmit(mockDb, 'd1');
    const calls = emailService.send.mock.calls;
    // No call to admin emails
    const adminCalls = calls.filter(c => Array.isArray(c[0].to) &&
      (c[0].to.includes('ahmed@x.com') || c[0].to.includes('aamer@x.com')));
    expect(adminCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onStageChange (R-11..R-22)
// ═══════════════════════════════════════════════════════════════════════════
describe('onStageChange', () => {
  test('logs every stage change to crm_activity', async () => {
    seedAdmins();
    seedDeal('d1', { stage: 'New' });
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'New', toStage: 'Qualified',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    const activity = Object.values(mockStore.collections.crm_activity || {});
    const stageChange = activity.find(a => a.kind === 'stage_change');
    expect(stageChange).toBeDefined();
    expect(stageChange.fromStage).toBe('New');
    expect(stageChange.toStage).toBe('Qualified');
  });

  test('R-11: New → Qualified resets inactivity flags', async () => {
    seedAdmins();
    seedDeal('d1', { stage: 'New', inactivityRepNotified: true, inactivityAdminNotified: true });
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'New', toStage: 'Qualified',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    expect(mockStore.collections.crm_deals.d1.inactivityRepNotified).toBe(false);
    expect(mockStore.collections.crm_deals.d1.inactivityAdminNotified).toBe(false);
  });

  test('R-12: Qualified → Proposal Sent fires approval request', async () => {
    seedAdmins();
    seedDeal('d1', { stage: 'Qualified' });
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'Qualified', toStage: 'Proposal Sent',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    expect(emailService.proposalApprovalRequest).toHaveBeenCalled();
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('pending');
  });

  test('R-15: Proposal Sent → Negotiation logs proposalSentAt', async () => {
    seedAdmins();
    seedDeal('d1', { stage: 'Proposal Sent' });
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'Proposal Sent', toStage: 'Negotiation',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    expect(mockStore.collections.crm_deals.d1.proposalSentAt).toBeDefined();
  });

  test('R-17, R-18: Closed Won generates contract + notifies admins', async () => {
    seedAdmins();
    seedDeal('d1', { stage: 'Negotiation' });
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'Negotiation', toStage: 'Closed Won',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    expect(driveService.ensureClientFolder).toHaveBeenCalled();
    expect(docsService.generateContract).toHaveBeenCalled();
    expect(esignService.sendForSignature).toHaveBeenCalled();
    expect(emailService.contractSent).toHaveBeenCalled();
    expect(mockStore.collections.crm_deals.d1.driveFolderId).toBe('folder1');
    expect(mockStore.collections.crm_deals.d1.contractDocId).toBe('doc1');
  });

  test('R-20, R-21, R-22: Onboarding stage triggers handoff + checklist', async () => {
    seedAdmins();
    seedOnboarding();
    seedDeal('d1', {
      stage: 'Closed Won',
      ownerUid: 'u1',
      services: [{ name: 'Warehousing', monthlyRevenue: 25000 }],
    });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    await rules.onStageChange(mockDb, {
      dealId: 'd1', fromStage: 'Closed Won', toStage: 'Onboarding',
      actor: { uid: 'u1', displayName: 'Sara' },
    });
    const deal = mockStore.collections.crm_deals.d1;
    expect(deal.onboarding).toBeDefined();
    expect(deal.onboarding.assignedUid).toBe('k1');
    expect(deal.onboarding.checklistState.length).toBeGreaterThan(0);
    expect(deal.onboarding.slaDueAt).toBeDefined(); // T+1 SLA
    expect(emailService.onboardingHandoff).toHaveBeenCalled();
    expect(emailService.onboardingAdmin).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onApprovalDecision (R-13, R-14)
// ═══════════════════════════════════════════════════════════════════════════
describe('onApprovalDecision', () => {
  test('R-13: approved → notifies rep, marks approved', async () => {
    seedDeal('d1', { stage: 'Qualified', approvalStatus: 'pending', ownerUid: 'u1' });
    mockStore.collections.crm_users = {
      u1: { uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep' },
    };
    await rules.onApprovalDecision(mockDb, {
      dealId: 'd1', approved: true,
      approver: { uid: 'a1', displayName: 'Ahmed', email: 'ahmed@x.com' },
    });
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('approved');
    expect(emailService.proposalApproved).toHaveBeenCalled();
  });

  test('R-14: rejected → stays in Qualified, rep notified with reason', async () => {
    seedDeal('d1', { stage: 'Qualified', approvalStatus: 'pending', ownerUid: 'u1' });
    mockStore.collections.crm_users = {
      u1: { uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep' },
    };
    await rules.onApprovalDecision(mockDb, {
      dealId: 'd1', approved: false, reason: 'Discount too high',
      approver: { uid: 'a1', displayName: 'Ahmed' },
    });
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('rejected');
    expect(mockStore.collections.crm_deals.d1.stage).toBe('Qualified');
    expect(mockStore.collections.crm_deals.d1.rejectionReason).toBe('Discount too high');
    expect(emailService.proposalRejected).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onRepReassign (R-10)
// ═══════════════════════════════════════════════════════════════════════════
describe('onRepReassign', () => {
  test('logs reassignment, notifies new rep via email + in-app', async () => {
    seedDeal('d1', { ownerUid: 'u1' });
    mockStore.collections.crm_users = {
      u1: { uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep' },
      u2: { uid: 'u2', email: 'james@x.com', displayName: 'James', role: 'rep' },
    };
    await rules.onRepReassign(mockDb, {
      dealId: 'd1',
      oldOwnerUid: 'u1', newOwnerUid: 'u2',
      actor: { uid: 'admin1', displayName: 'Ahmed' },
      reason: 'territory',
    });
    const activity = Object.values(mockStore.collections.crm_activity || {});
    const reassign = activity.find(a => a.kind === 'rep_reassigned');
    expect(reassign).toBeDefined();
    expect(reassign.detail).toContain('Sara');
    expect(reassign.detail).toContain('James');
    expect(emailService.repReassigned).toHaveBeenCalled();
    // New rep got an in-app notification
    const notifs = Object.values(mockStore.collections.crm_notifications || {});
    const reassignNotif = notifs.find(n => n.type === 'reassign' && n.recipientUid === 'u2');
    expect(reassignNotif).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sweepInactivity (R-07, R-08)
// ═══════════════════════════════════════════════════════════════════════════
describe('sweepInactivity', () => {
  test('R-07: at T+repDays, notifies assigned rep', async () => {
    seedAdmins();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    seedDeal('d1', {
      stage: 'New', ownerUid: 'u1',
      lastActivityAt: mockTimestamp.fromDate(sevenDaysAgo),
    });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    const r = await rules.sweepInactivity(mockDb, { inactivityRepDays: 3, inactivityAdminDays: 14 });
    expect(r.repFired).toBe(1);
    expect(emailService.inactivityRep).toHaveBeenCalled();
    expect(mockStore.collections.crm_deals.d1.inactivityRepNotified).toBe(true);
  });

  test('R-08: at T+adminDays, escalates to admins', async () => {
    seedAdmins();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    seedDeal('d1', {
      stage: 'New', ownerUid: 'u1',
      lastActivityAt: mockTimestamp.fromDate(tenDaysAgo),
    });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    const r = await rules.sweepInactivity(mockDb, { inactivityRepDays: 3, inactivityAdminDays: 7 });
    expect(r.adminFired).toBe(1);
    expect(emailService.inactivityAdmin).toHaveBeenCalled();
    expect(mockStore.collections.crm_deals.d1.inactivityAdminNotified).toBe(true);
  });

  test('does not double-fire — once notified, skipped on next sweep', async () => {
    seedAdmins();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    seedDeal('d1', {
      stage: 'New', ownerUid: 'u1',
      lastActivityAt: mockTimestamp.fromDate(sevenDaysAgo),
      inactivityRepNotified: true, // already fired
    });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    const r = await rules.sweepInactivity(mockDb, { inactivityRepDays: 3, inactivityAdminDays: 14 });
    expect(r.repFired).toBe(0);
  });

  test('skips Closed Won, Closed Lost, Onboarding stages', async () => {
    seedAdmins();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    seedDeal('won', { stage: 'Closed Won', ownerUid: 'u1', lastActivityAt: mockTimestamp.fromDate(tenDaysAgo) });
    seedDeal('lost', { stage: 'Closed Lost', ownerUid: 'u1', lastActivityAt: mockTimestamp.fromDate(tenDaysAgo) });
    seedDeal('ob', { stage: 'Onboarding', ownerUid: 'u1', lastActivityAt: mockTimestamp.fromDate(tenDaysAgo) });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    const r = await rules.sweepInactivity(mockDb, { inactivityRepDays: 3, inactivityAdminDays: 7 });
    expect(r.repFired).toBe(0);
    expect(r.adminFired).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sweepReengagement (R-25, R-26)
// ═══════════════════════════════════════════════════════════════════════════
describe('sweepReengagement', () => {
  test('fires when reengagement date has passed and not yet notified', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    seedDeal('d1', {
      stage: 'Closed Lost',
      ownerUid: 'u1',
      reengagementDate: mockTimestamp.fromDate(yesterday),
    });
    mockStore.collections.crm_users = {
      u1: { uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep' },
    };
    const r = await rules.sweepReengagement(mockDb);
    expect(r.fired).toBe(1);
    expect(emailService.reengagementDue).toHaveBeenCalled();
    expect(mockStore.collections.crm_deals.d1.reengagementNotified).toBe(true);
  });

  test('does not fire if date is in the future', async () => {
    const tomorrow = new Date(Date.now() + 86400000);
    seedDeal('d1', {
      stage: 'Closed Lost',
      ownerUid: 'u1',
      reengagementDate: mockTimestamp.fromDate(tomorrow),
    });
    mockStore.collections.crm_users = {
      u1: { uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep' },
    };
    const r = await rules.sweepReengagement(mockDb);
    expect(r.fired).toBe(0);
  });

  test('does not double-fire on already-notified deals', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    seedDeal('d1', {
      stage: 'Closed Lost',
      ownerUid: 'u1',
      reengagementDate: mockTimestamp.fromDate(yesterday),
      reengagementNotified: true,
    });
    const r = await rules.sweepReengagement(mockDb);
    expect(r.fired).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onSignatureComplete (R-19)
// ═══════════════════════════════════════════════════════════════════════════
describe('onSignatureComplete', () => {
  test('R-19: marks signed and advances to Onboarding', async () => {
    seedAdmins();
    seedOnboarding();
    seedDeal('d1', { stage: 'Closed Won', contractDocId: 'doc1', ownerUid: 'u1' });
    mockStore.collections.crm_users.u1 = {
      uid: 'u1', email: 'sara@x.com', displayName: 'Sara', role: 'rep',
    };
    await rules.onSignatureComplete(mockDb, { dealId: 'd1' });
    expect(mockStore.collections.crm_deals.d1.signedAt).toBeDefined();
    expect(mockStore.collections.crm_deals.d1.stage).toBe('Onboarding');
    // R-20/R-21/R-22 should have fired through onStageChange chain
    expect(emailService.onboardingHandoff).toHaveBeenCalled();
  });
});
