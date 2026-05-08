'use strict';

// Unit tests for the pure functions in rules/engine.js — tier classification,
// monthly revenue rollup, duplicate detection. These don't touch Firestore;
// where the engine module needs `db`, we pass a fake.
//
// Run: npm test
// Watch: npm run test:watch

const rules = require('../rules/engine');

describe('tierFromMonthly', () => {
  test('classifies tier from monthly revenue per spec §9 (default thresholds)', () => {
    expect(rules.tierFromMonthly(0)).toBe(1);
    expect(rules.tierFromMonthly(4999)).toBe(1);
    expect(rules.tierFromMonthly(5000)).toBe(2);
    expect(rules.tierFromMonthly(9999)).toBe(2);
    expect(rules.tierFromMonthly(10000)).toBe(3);
    expect(rules.tierFromMonthly(24999)).toBe(3);
    expect(rules.tierFromMonthly(25000)).toBe(4);
    expect(rules.tierFromMonthly(1_000_000)).toBe(4);
  });

  test('boundary edge cases are inclusive on the lower bound', () => {
    expect(rules.tierFromMonthly(5000)).toBe(2); // not Tier 1
    expect(rules.tierFromMonthly(10000)).toBe(3); // not Tier 2
    expect(rules.tierFromMonthly(25000)).toBe(4); // not Tier 3
  });

  test('honors custom thresholds (4.2b)', () => {
    const custom = { tier2: 1000, tier3: 5000, tier4: 50000 };
    expect(rules.tierFromMonthly(500, custom)).toBe(1);
    expect(rules.tierFromMonthly(1000, custom)).toBe(2);
    expect(rules.tierFromMonthly(4999, custom)).toBe(2);
    expect(rules.tierFromMonthly(5000, custom)).toBe(3);
    expect(rules.tierFromMonthly(50000, custom)).toBe(4);
  });

  test('falls back to defaults when partial thresholds passed', () => {
    expect(rules.tierFromMonthly(7500, { tier2: 1000 })).toBe(2); // 1000 < 7500 < default 10000
  });
});

describe('monthlyRevenue (4.J — excludes one-time)', () => {
  test('sums monthly recurring + volume-based services', () => {
    const deal = {
      services: [
        { name: 'Warehousing', monthlyRevenue: 20000, revenueModel: 'monthly' },
        { name: 'Cross-Dock',  monthlyRevenue: 5000,  revenueModel: 'volume_based' },
      ],
    };
    expect(rules.monthlyRevenue(deal)).toBe(25000);
  });

  test('EXCLUDES one-time services from monthly total (4.J)', () => {
    const deal = {
      services: [
        { name: 'Warehousing', monthlyRevenue: 20000, revenueModel: 'monthly' },
        { name: 'Freight',     monthlyRevenue: 8000,  revenueModel: 'one_time' },
      ],
    };
    expect(rules.monthlyRevenue(deal)).toBe(20000);
    expect(rules.oneTimeTotal(deal)).toBe(8000);
    expect(rules.arr(deal)).toBe(240000); // 20K × 12, NOT 28K × 12
  });

  test('defaults missing revenueModel to monthly (back-compat)', () => {
    const deal = {
      services: [
        { name: 'Warehousing', monthlyRevenue: 20000 }, // no revenueModel
      ],
    };
    expect(rules.monthlyRevenue(deal)).toBe(20000);
  });

  test('treats missing services as 0', () => {
    expect(rules.monthlyRevenue({})).toBe(0);
    expect(rules.monthlyRevenue({ services: [] })).toBe(0);
    expect(rules.oneTimeTotal({})).toBe(0);
    expect(rules.arr({})).toBe(0);
  });

  test('coerces string revenues to numbers, ignores invalid', () => {
    const deal = {
      services: [
        { name: 'A', monthlyRevenue: '1000' },
        { name: 'B', monthlyRevenue: 'NaN-ish' },
        { name: 'C', monthlyRevenue: 500 },
      ],
    };
    expect(rules.monthlyRevenue(deal)).toBe(1500);
  });
});

describe('STAGES', () => {
  test('exposes the 8 stages in the canonical order', () => {
    expect(rules.STAGES).toEqual([
      'New', 'Qualified', 'Proposal Sent', 'Negotiation',
      'Closed Won', 'Contract', 'Onboarding', 'Closed Lost',
    ]);
  });
});

describe('defaultChecklist', () => {
  test('returns the onboarding checklist with done=false on every item', () => {
    const cl = rules.defaultChecklist();
    expect(Array.isArray(cl)).toBe(true);
    expect(cl.length).toBeGreaterThan(0);
    cl.forEach(item => {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('label');
      expect(item.done).toBe(false);
    });
  });
});

// ─── detectDuplicates — needs a fake `db` ────────────────────────────────────
//
// We mock the minimum surface of the Firestore client that detectDuplicates
// touches: db.collection('crm_deals').get() returning a snapshot with
// .docs[].id and .docs[].data().

function fakeDb(existingDeals) {
  return {
    collection() {
      return {
        async get() {
          return {
            docs: existingDeals.map(d => ({
              id: d.id,
              data: () => {
                // strip the synthetic `id` field the test fixtures use
                const { id, ...rest } = d;
                return rest;
              },
            })),
          };
        },
      };
    },
  };
}

describe('detectDuplicates (R-05)', () => {
  test('flags exact email match', async () => {
    const db = fakeDb([
      { id: 'a', companyName: 'Acme Inc', contactEmail: 'mike@arctic.ca' },
    ]);
    const candidate = { id: 'b', companyName: 'Totally Different', contactEmail: 'mike@arctic.ca' };
    const matches = await rules.detectDuplicates(db, candidate);
    expect(matches).toHaveLength(1);
    expect(matches[0].existing.id).toBe('a');
    expect(matches[0].reasons.some(r => /email/i.test(r))).toBe(true);
  });

  test('flags fuzzy company name match (>=80%)', async () => {
    const db = fakeDb([
      { id: 'a', companyName: 'Arctic Cold Storage', contactEmail: 'a@a.com' },
    ]);
    const candidate = { id: 'b', companyName: 'Arctic Cold Storages', contactEmail: 'b@b.com' };
    const matches = await rules.detectDuplicates(db, candidate);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].reasons.some(r => /company/i.test(r))).toBe(true);
  });

  test('does NOT flag unrelated companies', async () => {
    const db = fakeDb([
      { id: 'a', companyName: 'Apple', contactEmail: 'tim@apple.com' },
    ]);
    const candidate = { id: 'b', companyName: 'Microsoft', contactEmail: 'satya@microsoft.com' };
    expect(await rules.detectDuplicates(db, candidate)).toEqual([]);
  });

  test('flags company + phone match (both required)', async () => {
    const db = fakeDb([
      { id: 'a', companyName: 'Acme', contactPhone: '4165550182', contactEmail: 'a@a.com' },
    ]);
    // Same company, same phone, different email → flagged
    const candidate = { id: 'b', companyName: 'Acme', contactPhone: '+1 (416) 555-0182', contactEmail: 'b@b.com' };
    const matches = await rules.detectDuplicates(db, candidate);
    expect(matches.length).toBeGreaterThan(0);
  });

  test('does NOT flag company-only match without phone+email', async () => {
    const db = fakeDb([
      { id: 'a', companyName: 'Common Name LLC', contactPhone: '111', contactEmail: 'a@a.com' },
    ]);
    // Different phone, different email → company alone (low similarity) shouldn't trigger
    const candidate = { id: 'b', companyName: 'Acme Logistics', contactPhone: '999', contactEmail: 'b@b.com' };
    expect(await rules.detectDuplicates(db, candidate)).toEqual([]);
  });

  test('case-insensitive company match', async () => {
    const db = fakeDb([{ id: 'a', companyName: 'TerraFlex Supply' }]);
    const candidate = { id: 'b', companyName: 'TERRAFLEX SUPPLY' };
    const matches = await rules.detectDuplicates(db, candidate);
    expect(matches.length).toBeGreaterThan(0);
  });

  test('does not match self', async () => {
    const db = fakeDb([{ id: 'self', companyName: 'Acme', contactEmail: 'a@a.com' }]);
    const candidate = { id: 'self', companyName: 'Acme', contactEmail: 'a@a.com' };
    expect(await rules.detectDuplicates(db, candidate)).toEqual([]);
  });
});
