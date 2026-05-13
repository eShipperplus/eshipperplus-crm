'use strict';

// HTTP-level integration tests for server.js. Mocks firebase-admin so no
// network or real Firestore is touched. Tests every API endpoint with the
// role permutations that matter (admin, rep, onboarding, finance, no auth).

const { mockStore, mockDb, mockTimestamp } = require('./_helpers/firestore-mock');

const mockAuth = {
  verifyIdToken: jest.fn(),
  setCustomUserClaims: jest.fn().mockResolvedValue(),
  deleteUser: jest.fn().mockResolvedValue(),
};

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn(), cert: jest.fn() }));
jest.mock('firebase-admin/firestore', () => {
  const helpers = require('./_helpers/firestore-mock');
  return {
    getFirestore: jest.fn(() => helpers.mockDb),
    FieldValue: { arrayUnion: () => 'arrayUnion-marker' },
    Timestamp: helpers.mockTimestamp,
  };
});
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn(() => mockAuth) }));

// Mock external services so they don't actually send / call APIs
const mockEmailService = {
  send: jest.fn().mockResolvedValue({ sent: false, dryRun: true }),
  welcomeEmail: jest.fn(() => ({ subject: 'welcome', html: '' })),
  newLeadNotification: jest.fn(() => ({ subject: 'new lead', html: '' })),
  duplicateAlert: jest.fn(() => ({ subject: 'dup', html: '' })),
  inactivityRep: jest.fn(() => ({ subject: 'i-rep', html: '' })),
  inactivityAdmin: jest.fn(() => ({ subject: 'i-adm', html: '' })),
  proposalApprovalRequest: jest.fn(() => ({ subject: 'pa', html: '' })),
  proposalApproved: jest.fn(() => ({ subject: 'ok', html: '' })),
  proposalRejected: jest.fn(() => ({ subject: 'rj', html: '' })),
  contractSent: jest.fn(() => ({ subject: 'cs', html: '' })),
  onboardingHandoff: jest.fn(() => ({ subject: 'ob', html: '' })),
  onboardingAdmin: jest.fn(() => ({ subject: 'oa', html: '' })),
  repReassigned: jest.fn(() => ({ subject: 'rr', html: '' })),
  reengagementDue: jest.fn(() => ({ subject: 're', html: '' })),
  inviteEmail: jest.fn(() => ({ subject: 'inv', html: '' })),
};
jest.mock('../services/email', () => mockEmailService);
jest.mock('../services/drive', () => ({ ensureClientFolder: jest.fn().mockResolvedValue({ id: null, dryRun: true }) }));
jest.mock('../services/docs', () => ({ generateContract: jest.fn().mockResolvedValue({ id: null, dryRun: true }) }));
jest.mock('../services/esign', () => ({ sendForSignature: jest.fn().mockResolvedValue({ sent: false, dryRun: true }) }));

const request = require('supertest');
let app;

beforeAll(() => {
  process.env.FIREBASE_SERVICE_ACCOUNT = '';
  process.env.GCP_PROJECT = 'test-project';
  app = require('../server.js');
});

beforeEach(() => {
  mockStore.reset();
  mockAuth.verifyIdToken.mockReset();
  Object.values(mockEmailService).forEach(fn => fn.mockClear?.());
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function asUser(uid, role, extra = {}) {
  mockAuth.verifyIdToken.mockResolvedValue({
    uid, email: extra.email || `${uid}@eshipperplus.com`, name: extra.name || uid,
  });
  mockStore.collections.crm_users = mockStore.collections.crm_users || {};
  mockStore.collections.crm_users[uid] = {
    uid, role,
    email: extra.email || `${uid}@eshipperplus.com`,
    displayName: extra.name || uid,
    ...extra,
  };
  return { Authorization: 'Bearer fake-token' };
}

function seedDeals(deals) {
  mockStore.collections.crm_deals = {};
  for (const d of deals) {
    mockStore.collections.crm_deals[d.id] = { ...d };
    delete mockStore.collections.crm_deals[d.id].id;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Health & Auth
// ═══════════════════════════════════════════════════════════════════════════
describe('Health & auth', () => {
  test('GET /api/health → 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/me without token → 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  test('GET /api/me with malformed Authorization header → 401', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'NotBearer xxx');
    expect(res.status).toBe(401);
  });

  test('GET /api/me invalid token → 401', async () => {
    mockAuth.verifyIdToken.mockRejectedValueOnce(new Error('bad token'));
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer x');
    expect(res.status).toBe(401);
  });

  test('GET /api/me valid token, existing user → returns role', async () => {
    const headers = asUser('u1', 'admin');
    const res = await request(app).get('/api/me').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.email).toBe('u1@eshipperplus.com');
  });

  test('first-time user with NO invite is rejected (no auto-provision)', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'newbie', email: 'newbie@eshipperplus.com', name: 'Newbie',
    });
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer x');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invite/i);
  });

  test('non-eshipperplus.com domain is rejected', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'outsider', email: 'someone@gmail.com', name: 'Outsider',
    });
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer x');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/eshipperplus\.com/);
  });

  test('first-time user WITH invite → picks up invited role', async () => {
    mockStore.collections.crm_invites = {
      'admin@eshipperplus.com': { email: 'admin@eshipperplus.com', role: 'admin', displayName: 'Admin Person' },
    };
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'admin1', email: 'admin@eshipperplus.com',
    });
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    // Invite should have been consumed
    expect(mockStore.collections.crm_invites['admin@eshipperplus.com']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Public lead intake
// ═══════════════════════════════════════════════════════════════════════════
describe('Public lead intake', () => {
  test('POST /public/leads/website creates a Tier 1 deal', async () => {
    const res = await request(app)
      .post('/public/leads/website')
      .send({
        companyName: 'Tiny Co', contactName: 'A', contactEmail: 'a@a.com',
        services: [{ name: 'Freight', monthlyRevenue: 1000 }],
      });
    expect(res.status).toBe(200);
    const deal = mockStore.collections.crm_deals[res.body.dealId];
    expect(deal.companyName).toBe('Tiny Co');
    expect(deal.source).toBe('Website');
    expect(deal.stage).toBe('New');
  });

  test('POST /public/leads/website missing companyName → 400', async () => {
    const res = await request(app)
      .post('/public/leads/website')
      .send({ contactEmail: 'a@a.com' });
    expect(res.status).toBe(400);
  });

  test('POST /public/leads/website missing email → 400', async () => {
    const res = await request(app)
      .post('/public/leads/website')
      .send({ companyName: 'X' });
    expect(res.status).toBe(400);
  });

  test('POST /public/leads/partner stamps source = Partner Portal + partnerRep', async () => {
    const res = await request(app)
      .post('/public/leads/partner')
      .send({
        companyName: 'P Co', contactEmail: 'p@p.com',
        partnerRep: { company: 'Acme', repName: 'Jordan' },
      });
    expect(res.status).toBe(200);
    const deal = mockStore.collections.crm_deals[res.body.dealId];
    expect(deal.source).toBe('Partner Portal');
    expect(deal.partnerRep).toEqual({ company: 'Acme', repName: 'Jordan' });
  });

  test('GET /public/partner-reps reads from crm_config', async () => {
    mockStore.collections.crm_config = {
      partner_rep_directory: { entries: [{ company: 'Acme', repName: 'Jordan' }] },
    };
    const res = await request(app).get('/public/partner-reps');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].repName).toBe('Jordan');
  });

  test('GET /public/partner-reps when config missing → empty array', async () => {
    const res = await request(app).get('/public/partner-reps');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deals — list / get / create / edit
// ═══════════════════════════════════════════════════════════════════════════
describe('Deals CRUD', () => {
  test('GET /api/deals requires auth', async () => {
    const res = await request(app).get('/api/deals');
    expect(res.status).toBe(401);
  });

  test('GET /api/deals returns list', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([
      { id: 'd1', companyName: 'A', stage: 'New', updatedAt: mockTimestamp.now() },
      { id: 'd2', companyName: 'B', stage: 'Qualified', updatedAt: mockTimestamp.now() },
    ]);
    const res = await request(app).get('/api/deals').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test('GET /api/deals?stage=New filters by stage', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([
      { id: 'd1', stage: 'New', companyName: 'A', updatedAt: mockTimestamp.now() },
      { id: 'd2', stage: 'Qualified', companyName: 'B', updatedAt: mockTimestamp.now() },
    ]);
    const res = await request(app).get('/api/deals?stage=New').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].stage).toBe('New');
  });

  test('GET /api/deals/:id returns single deal', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', companyName: 'X', stage: 'New' }]);
    const res = await request(app).get('/api/deals/d1').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe('X');
  });

  test('GET /api/deals/:id 404 for unknown id', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).get('/api/deals/missing').set(headers);
    expect(res.status).toBe(404);
  });

  test('POST /api/deals (rep creates) tags Manual Entry source', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).post('/api/deals').set(headers).send({
      companyName: 'New Co', contactEmail: 'x@x.com',
      services: [{ name: 'Warehousing', monthlyRevenue: 30000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('Manual Entry');
    expect(res.body.stage).toBe('New');
    expect(res.body.ownerUid).toBe('u1');
  });

  test('POST /api/deals onboarding role → 403 (only rep + admin can create)', async () => {
    const headers = asUser('u1', 'onboarding');
    const res = await request(app).post('/api/deals').set(headers).send({
      companyName: 'X', contactEmail: 'x@x.com',
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/deals/:id by owner allowed', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u1', companyName: 'X', stage: 'New' }]);
    const res = await request(app).patch('/api/deals/d1').set(headers).send({
      contactName: 'Jane',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.contactName).toBe('Jane');
  });

  test('PATCH /api/deals/:id by non-owner rep → 403', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u2', companyName: 'X', stage: 'New' }]);
    const res = await request(app).patch('/api/deals/d1').set(headers).send({
      contactName: 'Jane',
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/deals/:id by admin always allowed', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u2', companyName: 'X', stage: 'New' }]);
    const res = await request(app).patch('/api/deals/d1').set(headers).send({
      contactName: 'Jane',
    });
    expect(res.status).toBe(200);
  });

  test('PATCH stage via main endpoint → rejected (must use /stage)', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u1', companyName: 'X', stage: 'New' }]);
    const res = await request(app).patch('/api/deals/d1').set(headers).send({
      stage: 'Qualified',
    });
    expect(res.status).toBe(400);
  });

  test('PATCH services recalculates tier', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u1', companyName: 'X', stage: 'New' }]);
    const res = await request(app).patch('/api/deals/d1').set(headers).send({
      services: [{ name: 'Warehousing', monthlyRevenue: 30000 }],
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.tier).toBe(4);
    expect(mockStore.collections.crm_deals.d1.monthlyRevenue).toBe(30000);
    expect(mockStore.collections.crm_deals.d1.arr).toBe(360000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage transitions (R-10..R-24)
// ═══════════════════════════════════════════════════════════════════════════
describe('Stage transitions', () => {
  test('rep can move own deal stage', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{
      id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X',
      services: [{ name: 'Warehousing', monthlyRevenue: 10000 }], // 2.C requires services to advance
    }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Qualified',
    });
    expect(res.status).toBe(200);
  });

  test('rep cannot move another rep deal', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u2', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Qualified',
    });
    expect(res.status).toBe(403);
  });

  test('Qualified → Proposal Sent fires approval gate (R-12)', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'Qualified', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Proposal Sent',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_approval');
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('pending');
    // Stage should NOT advance until admin approves
    expect(mockStore.collections.crm_deals.d1.stage).toBe('Qualified');
  });

  test('Closed Lost requires loss reason (R-24)', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Closed Lost', reengagementDate: '2026-12-01',
    });
    expect(res.status).toBe(400);
  });

  test('Closed Lost requires re-engagement date (R-24)', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Closed Lost', lossReason: 'Price',
    });
    expect(res.status).toBe(400);
  });

  test('Closed Lost with both fields persists them', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Closed Lost', lossReason: 'Price', reengagementDate: '2026-12-01',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.lossReason).toBe('Price');
    expect(mockStore.collections.crm_deals.d1.reengagementDate).toBeDefined();
  });

  test('invalid stage name → 400', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'NonexistentStage',
    });
    expect(res.status).toBe(400);
  });

  test('cannot advance past New without at least one priced service (2.C)', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X', services: [] }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Qualified',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service/i);
  });

  test('CAN advance past New with a priced service', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{
      id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X',
      services: [{ name: 'Warehousing', monthlyRevenue: 10000 }],
    }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Qualified',
    });
    expect(res.status).toBe(200);
  });

  test('Closed Lost from New is allowed even with no services (2.C exemption)', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X', services: [] }]);
    const res = await request(app).post('/api/deals/d1/stage').set(headers).send({
      toStage: 'Closed Lost',
      lossReason: 'No response',
      reengagementDate: '2026-12-01',
    });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Approvals (R-13, R-14)
// ═══════════════════════════════════════════════════════════════════════════
describe('Proposal approvals', () => {
  test('approval requires admin', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', stage: 'Qualified', approvalStatus: 'pending', companyName: 'X', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/approval').set(headers).send({
      approved: true,
    });
    expect(res.status).toBe(403);
  });

  test('admin approves → stage advances to Proposal Sent', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', stage: 'Qualified', approvalStatus: 'pending', companyName: 'X', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/approval').set(headers).send({
      approved: true,
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.stage).toBe('Proposal Sent');
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('approved');
  });

  test('admin rejects with reason → stays in Qualified, reason stored', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', stage: 'Qualified', approvalStatus: 'pending', companyName: 'X', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/approval').set(headers).send({
      approved: false, reason: 'Discount too high',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.stage).toBe('Qualified');
    expect(mockStore.collections.crm_deals.d1.approvalStatus).toBe('rejected');
    expect(mockStore.collections.crm_deals.d1.rejectionReason).toBe('Discount too high');
  });

  test('approval on a deal with no pending approval → 400', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', stage: 'New', approvalStatus: undefined, companyName: 'X', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/approval').set(headers).send({
      approved: true,
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rep reassignment (R-10)
// ═══════════════════════════════════════════════════════════════════════════
describe('Rep reassignment', () => {
  test('rep cannot reassign', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    mockStore.collections.crm_users.u2 = { uid: 'u2', role: 'rep', email: 'u2@x.com', displayName: 'U2' };
    const res = await request(app).post('/api/deals/d1/reassign').set(headers).send({
      newOwnerUid: 'u2',
    });
    expect(res.status).toBe(403);
  });

  test('admin reassigns at any stage including Closed Won', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'Closed Won', companyName: 'X' }]);
    mockStore.collections.crm_users.u2 = { uid: 'u2', role: 'rep', email: 'u2@x.com', displayName: 'U2' };
    const res = await request(app).post('/api/deals/d1/reassign').set(headers).send({
      newOwnerUid: 'u2', reason: 'territory',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.ownerUid).toBe('u2');
    expect(mockStore.collections.crm_deals.d1.ownerName).toBe('U2');
  });

  test('reassign without newOwnerUid → 400', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    const res = await request(app).post('/api/deals/d1/reassign').set(headers).send({});
    expect(res.status).toBe(400);
  });

  test('reassign to the SAME rep is rejected (no-op guard)', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', ownerUid: 'u1', stage: 'New', companyName: 'X' }]);
    mockStore.collections.crm_users.u1 = { uid: 'u1', role: 'rep', email: 'u1@x.com', displayName: 'U1' };
    const res = await request(app).post('/api/deals/d1/reassign').set(headers).send({
      newOwnerUid: 'u1', reason: 'oops',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already assigned/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate decision
// ═══════════════════════════════════════════════════════════════════════════
describe('Duplicate decision', () => {
  test('admin marks not_duplicate → flag cleared', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', duplicateFlag: true, companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/duplicate-decision').set(headers).send({
      action: 'not_duplicate',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.duplicateFlag).toBe(false);
  });

  test('admin discards → deal hidden', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', duplicateFlag: true, companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/duplicate-decision').set(headers).send({
      action: 'discard',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_deals.d1.discarded).toBe(true);
  });

  test('rep cannot decide on duplicate', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', duplicateFlag: true, companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/duplicate-decision').set(headers).send({
      action: 'not_duplicate',
    });
    expect(res.status).toBe(403);
  });

  test('invalid action → 400', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/duplicate-decision').set(headers).send({
      action: 'unknown',
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Notes & activity log
// ═══════════════════════════════════════════════════════════════════════════
describe('Notes & activity', () => {
  test('any authenticated user can add note', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/notes').set(headers).send({
      text: 'Called and left voicemail',
    });
    expect(res.status).toBe(200);
  });

  test('empty note → 400', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    const res = await request(app).post('/api/deals/d1/notes').set(headers).send({
      text: '   ',
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/deals/:id/activity returns audit trail', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', companyName: 'X', stage: 'New', ownerUid: 'u1' }]);
    mockStore.collections.crm_activity = {
      a1: { dealId: 'd1', kind: 'note', detail: 'first', timestamp: mockTimestamp.now() },
      a2: { dealId: 'd1', kind: 'edit', detail: 'second', timestamp: mockTimestamp.now() },
      a3: { dealId: 'other', kind: 'note', timestamp: mockTimestamp.now() },
    };
    const res = await request(app).get('/api/deals/d1/activity').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Onboarding checklist (R-23)
// ═══════════════════════════════════════════════════════════════════════════
describe('Onboarding checklist', () => {
  test('admin can update checklist', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', stage: 'Onboarding', companyName: 'X', onboarding: { checklistState: [] } }]);
    const res = await request(app).patch('/api/deals/d1/onboarding').set(headers).send({
      checklistState: [{ id: 'intro', label: 'X', done: true }],
    });
    expect(res.status).toBe(200);
  });

  test('onboarding role can update checklist', async () => {
    const headers = asUser('kim', 'onboarding');
    seedDeals([{ id: 'd1', stage: 'Onboarding', companyName: 'X', onboarding: { checklistState: [] } }]);
    const res = await request(app).patch('/api/deals/d1/onboarding').set(headers).send({
      checklistState: [{ id: 'a', label: 'A', done: true }],
    });
    expect(res.status).toBe(200);
  });

  test('rep cannot update checklist (read-only per R-23)', async () => {
    const headers = asUser('u1', 'rep');
    seedDeals([{ id: 'd1', stage: 'Onboarding', companyName: 'X' }]);
    const res = await request(app).patch('/api/deals/d1/onboarding').set(headers).send({
      checklistState: [{ id: 'a', done: true }],
    });
    expect(res.status).toBe(403);
  });

  test('finance cannot update checklist', async () => {
    const headers = asUser('div', 'finance');
    seedDeals([{ id: 'd1', stage: 'Onboarding', companyName: 'X' }]);
    const res = await request(app).patch('/api/deals/d1/onboarding').set(headers).send({
      checklistState: [{ id: 'a', done: true }],
    });
    expect(res.status).toBe(403);
  });

  test('checklistState must be array', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([{ id: 'd1', stage: 'Onboarding', companyName: 'X' }]);
    const res = await request(app).patch('/api/deals/d1/onboarding').set(headers).send({
      checklistState: 'not-an-array',
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════
describe('Settings', () => {
  test('GET /api/settings/:key returns saved settings', async () => {
    const headers = asUser('admin1', 'admin');
    mockStore.collections.crm_config = {
      notification_rules: { inactivityRepDays: 5, inactivityAdminDays: 14 },
    };
    const res = await request(app).get('/api/settings/notification_rules').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.inactivityRepDays).toBe(5);
  });

  test('GET /api/settings/:key when missing → empty object', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).get('/api/settings/missing_key').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  test('PUT /api/settings/:key requires admin', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).put('/api/settings/notification_rules').set(headers).send({
      inactivityRepDays: 5,
    });
    expect(res.status).toBe(403);
  });

  test('PUT /api/settings/:key admin saves', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).put('/api/settings/notification_rules').set(headers).send({
      inactivityRepDays: 5, inactivityAdminDays: 14, enabledRules: { 'R-03': false },
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_config.notification_rules.inactivityRepDays).toBe(5);
    expect(mockStore.collections.crm_config.notification_rules.enabledRules['R-03']).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Notifications
// ═══════════════════════════════════════════════════════════════════════════
describe('Notifications', () => {
  test('GET /api/notifications returns own notifications only', async () => {
    const headers = asUser('u1', 'rep');
    mockStore.collections.crm_notifications = {
      n1: { recipientUid: 'u1', title: 'Mine', read: false, createdAt: mockTimestamp.now() },
      n2: { recipientUid: 'u2', title: 'Theirs', read: false, createdAt: mockTimestamp.now() },
    };
    const res = await request(app).get('/api/notifications').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Mine');
  });

  test('POST /api/notifications/:id/read marks read', async () => {
    const headers = asUser('u1', 'rep');
    mockStore.collections.crm_notifications = {
      n1: { recipientUid: 'u1', read: false, createdAt: mockTimestamp.now() },
    };
    const res = await request(app).post('/api/notifications/n1/read').set(headers);
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_notifications.n1.read).toBe(true);
  });

  test('POST /api/notifications/mark-all-read clears all unread for user', async () => {
    const headers = asUser('u1', 'rep');
    mockStore.collections.crm_notifications = {
      n1: { recipientUid: 'u1', read: false, createdAt: mockTimestamp.now() },
      n2: { recipientUid: 'u1', read: false, createdAt: mockTimestamp.now() },
      n3: { recipientUid: 'u2', read: false, createdAt: mockTimestamp.now() }, // someone else's
    };
    const res = await request(app).post('/api/notifications/mark-all-read').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(mockStore.collections.crm_notifications.n1.read).toBe(true);
    expect(mockStore.collections.crm_notifications.n2.read).toBe(true);
    expect(mockStore.collections.crm_notifications.n3.read).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard summary
// ═══════════════════════════════════════════════════════════════════════════
describe('Dashboard', () => {
  test('returns aggregate metrics across deals', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([
      { id: 'd1', stage: 'New', arr: 60000, ownerName: 'Sara', source: 'Website' },
      { id: 'd2', stage: 'Qualified', arr: 120000, ownerName: 'Sara', source: 'Website' },
      { id: 'd3', stage: 'Closed Won', arr: 240000, ownerName: 'James', source: 'Partner Portal' },
      { id: 'd4', stage: 'Closed Lost', arr: 100000, ownerName: 'Sara', source: 'Website' },
    ]);
    const res = await request(app).get('/api/dashboard').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.activeDeals).toBe(3); // excludes Closed Lost
    expect(res.body.pipelineValue).toBe(420000);
    expect(res.body.funnel.New.count).toBe(1);
    expect(res.body.funnel.Qualified.count).toBe(1);
    expect(res.body.funnel['Closed Won'].count).toBe(1);
    // Win rate: 1 won / (1 won + 1 lost) = 0.5
    expect(res.body.winRate).toBe(0.5);
  });

  test('byOwner aggregates by ownerUid', async () => {
    const headers = asUser('admin1', 'admin');
    seedDeals([
      { id: 'd1', stage: 'New', arr: 100, ownerUid: 'u1', ownerName: 'Sara' },
      { id: 'd2', stage: 'New', arr: 200, ownerUid: 'u1', ownerName: 'Sara' },
      { id: 'd3', stage: 'New', arr: 50, ownerUid: 'u2', ownerName: 'James' },
    ]);
    const res = await request(app).get('/api/dashboard').set(headers);
    const sara = res.body.byOwner.find(o => o.uid === 'u1');
    expect(sara.deals).toBe(2);
    expect(sara.pipeline).toBe(300);
  });

  test('handles empty Firestore', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).get('/api/dashboard').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.activeDeals).toBe(0);
    expect(res.body.pipelineValue).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Users / invites (admin only)
// ═══════════════════════════════════════════════════════════════════════════
describe('Users & invites', () => {
  test('GET /api/users — any authed user', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).get('/api/users').set(headers);
    expect(res.status).toBe(200);
  });

  test('POST /api/users/invite — admin only', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).post('/api/users/invite').set(headers).send({
      email: 'NEW@x.com', displayName: 'N', role: 'rep',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_invites['new@x.com']).toBeDefined();
    expect(mockStore.collections.crm_invites['new@x.com'].role).toBe('rep');
  });

  test('invite invalid role → 400', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).post('/api/users/invite').set(headers).send({
      email: 'a@x.com', role: 'wizard',
    });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/users/:uid changes role', async () => {
    const headers = asUser('admin1', 'admin');
    mockStore.collections.crm_users = {
      ...mockStore.collections.crm_users,
      target: { uid: 'target', role: 'rep', email: 't@x.com', displayName: 'T' },
    };
    const res = await request(app).patch('/api/users/target').set(headers).send({
      role: 'finance',
    });
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_users.target.role).toBe('finance');
  });

  test('PATCH /api/users invalid role → 400', async () => {
    const headers = asUser('admin1', 'admin');
    mockStore.collections.crm_users = {
      ...mockStore.collections.crm_users,
      target: { uid: 'target', role: 'rep', email: 't@x.com', displayName: 'T' },
    };
    const res = await request(app).patch('/api/users/target').set(headers).send({
      role: 'overlord',
    });
    expect(res.status).toBe(400);
  });

  test('DELETE /api/users/:uid removes user', async () => {
    const headers = asUser('admin1', 'admin');
    mockStore.collections.crm_users.target = {
      uid: 'target', role: 'rep', email: 't@x.com', displayName: 'T',
    };
    const res = await request(app).delete('/api/users/target').set(headers);
    expect(res.status).toBe(200);
    expect(mockStore.collections.crm_users.target).toBeUndefined();
  });

  test('cannot delete self', async () => {
    const headers = asUser('admin1', 'admin');
    const res = await request(app).delete('/api/users/admin1').set(headers);
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CSV Import (Leads)
// ═══════════════════════════════════════════════════════════════════════════
describe('CSV lead import', () => {
  test('rejects unauthenticated', async () => {
    const res = await request(app)
      .post('/api/leads/import')
      .attach('file', Buffer.from('Company Name,Contact Email\nAcme,a@a.com\n'), 'leads.csv');
    expect(res.status).toBe(401);
  });

  test('rejects onboarding role', async () => {
    const headers = asUser('u1', 'onboarding');
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from('Company Name,Contact Email\nAcme,a@a.com\n'), 'leads.csv');
    expect(res.status).toBe(403);
  });

  test('400 when no file', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).post('/api/leads/import').set(headers);
    expect(res.status).toBe(400);
  });

  test('imports a valid CSV with one row', async () => {
    const headers = asUser('u1', 'rep');
    const csv = 'Company Name,Contact Email,Contact Name\nAcme Inc,a@a.com,Jane Doe\n';
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.dealIds).toHaveLength(1);
  });

  test('reports per-row errors for missing required fields', async () => {
    const headers = asUser('u1', 'rep');
    const csv = 'Company Name,Contact Email\nAcme Inc,a@a.com\n,b@b.com\nNoEmail Co,\n';
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(2);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].row).toBe(3);
    expect(res.body.errors[1].row).toBe(4);
  });

  test('parses per-service columns into the services array', async () => {
    const headers = asUser('u1', 'rep');
    const csv = [
      'Company Name,Contact Email,Freight $,Freight Model,Freight Volume,Warehousing & Fulfillment $,Warehousing & Fulfillment Model',
      'Acme,a@a.com,5000,one_time,3 trucks,30000,monthly',
    ].join('\n');
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const dealId = res.body.dealIds[0];
    const deal = mockStore.collections.crm_deals[dealId];
    expect(deal.services).toHaveLength(2);
    const freight = deal.services.find(s => s.name === 'Freight');
    expect(freight.monthlyRevenue).toBe(5000);
    expect(freight.revenueModel).toBe('one_time');
    expect(freight.volume).toBe('3 trucks');
    const warehousing = deal.services.find(s => s.name === 'Warehousing & Fulfillment');
    expect(warehousing.monthlyRevenue).toBe(30000);
    expect(warehousing.revenueModel).toBe('monthly');
  });

  test('rejects invalid stage', async () => {
    const headers = asUser('u1', 'rep');
    const csv = 'Company Name,Contact Email,Stage\nAcme,a@a.com,NotAStage\n';
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0].error).toMatch(/Invalid stage/);
  });

  test('resolves owner by email when provided', async () => {
    const headers = asUser('admin1', 'admin');
    mockStore.collections.crm_users.sara = {
      uid: 'sara', email: 'sara@eshipperplus.com', displayName: 'Sara K.', role: 'rep',
    };
    const csv = 'Company Name,Contact Email,Owner Email\nAcme,a@a.com,sara@eshipperplus.com\n';
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const dealId = res.body.dealIds[0];
    expect(mockStore.collections.crm_deals[dealId].ownerUid).toBe('sara');
  });

  test('400 on empty CSV', async () => {
    const headers = asUser('u1', 'rep');
    const csv = 'Company Name,Contact Email\n';
    const res = await request(app)
      .post('/api/leads/import')
      .set(headers)
      .attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(400);
  });

  test('GET /api/leads/import-template returns a CSV', async () => {
    const headers = asUser('u1', 'rep');
    const res = await request(app).get('/api/leads/import-template').set(headers);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text).toContain('Company Name');
    expect(res.text).toContain('Contact Email');
    expect(res.text).toContain('Freight $');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cron + webhooks
// ═══════════════════════════════════════════════════════════════════════════
describe('Cron + webhooks', () => {
  test('cron without secret → 401', async () => {
    process.env.CRON_SECRET = 'expected';
    const res = await request(app).post('/cron/inactivity-sweep');
    expect(res.status).toBe(401);
  });

  test('cron with wrong secret → 401', async () => {
    process.env.CRON_SECRET = 'expected';
    const res = await request(app)
      .post('/cron/inactivity-sweep')
      .set('X-Cron-Secret', 'wrong');
    expect(res.status).toBe(401);
  });

  test('cron with correct secret → 200', async () => {
    process.env.CRON_SECRET = 'expected';
    const res = await request(app)
      .post('/cron/inactivity-sweep')
      .set('X-Cron-Secret', 'expected');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inactivity).toBeDefined();
    expect(res.body.reengagement).toBeDefined();
  });

  test('eSignature webhook ignores non-completed status', async () => {
    const res = await request(app).post('/webhooks/esignature').send({
      docId: 'doc1', status: 'pending',
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('eSignature webhook 404 when no deal matches', async () => {
    const res = await request(app).post('/webhooks/esignature').send({
      docId: 'doc-unknown', status: 'completed',
    });
    expect(res.status).toBe(404);
  });
});
