'use strict';

// Tests for the email template helpers in services/email.js.
// We don't test the actual SMTP send (that needs network); we verify the
// template functions return well-formed { subject, html } objects with the
// expected content and proper HTML escaping (no XSS).

// Stub nodemailer so requiring the module doesn't try to set up a transport
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'fake' }),
  })),
}));

const email = require('../services/email');

describe('welcomeEmail (R-04)', () => {
  test('returns subject + html with company and contact name', () => {
    const r = email.welcomeEmail({ companyName: 'Acme Inc', contactName: 'Jane' });
    expect(r.subject).toContain('eShipper Plus');
    expect(r.html).toContain('Acme Inc');
    expect(r.html).toContain('Jane');
  });

  test('handles missing contactName gracefully', () => {
    const r = email.welcomeEmail({ companyName: 'Acme', contactName: undefined });
    expect(r.html).toContain('there'); // "Hi there,"
  });

  test('escapes HTML in company name (XSS prevention)', () => {
    const r = email.welcomeEmail({
      companyName: '<script>alert(1)</script>',
      contactName: 'Jane',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  test('escapes apostrophes and quotes', () => {
    const r = email.welcomeEmail({
      companyName: `Bob's "Best" Co`,
      contactName: 'X',
    });
    expect(r.html).toContain('Bob&#39;s');
    expect(r.html).toContain('&quot;Best&quot;');
  });
});

describe('newLeadNotification (R-03)', () => {
  test('includes tier, services, monthly revenue', () => {
    const deal = {
      id: 'd1',
      companyName: 'Acme',
      contactName: 'Jane',
      contactEmail: 'jane@acme.com',
      source: 'Website',
      services: [{ name: 'Warehousing', monthlyRevenue: 30000 }],
      ownerName: 'Sara',
    };
    const r = email.newLeadNotification({ deal, tier: 4 });
    expect(r.subject).toContain('Tier 4');
    expect(r.subject).toContain('Acme');
    expect(r.subject).toContain('Website');
    expect(r.html).toContain('jane@acme.com');
    expect(r.html).toContain('Warehousing');
    expect(r.html).toContain('30000');
    expect(r.html).toContain('Sara');
  });

  test('handles missing services as em-dash', () => {
    const r = email.newLeadNotification({
      deal: { companyName: 'X', source: 'Manual Entry', services: [] },
      tier: 1,
    });
    expect(r.html).toContain('—');
  });

  test('XSS-safe in companyName', () => {
    const r = email.newLeadNotification({
      deal: { companyName: '<img src=x onerror=alert(1)>', services: [] },
      tier: 1,
    });
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img');
  });
});

describe('duplicateAlert (R-05)', () => {
  test('side-by-side comparison includes both deals', () => {
    const r = email.duplicateAlert({
      newDeal: { companyName: 'Acme New', contactEmail: 'new@a.com', source: 'Website', stage: 'New', ownerName: 'Sara', services: [] },
      existing: { companyName: 'Acme', contactEmail: 'old@a.com', source: 'Manual', stage: 'Qualified', ownerName: 'James', services: [] },
      matchReasons: ['email match', 'company 95%'],
    });
    expect(r.subject).toContain('Acme New');
    expect(r.html).toContain('Acme New');
    expect(r.html).toContain('Acme');
    expect(r.html).toContain('email match');
    expect(r.html).toContain('company 95%');
  });
});

describe('inactivity emails (R-07, R-08)', () => {
  test('inactivityRep includes days idle and company', () => {
    const r = email.inactivityRep({
      deal: { id: 'd1', companyName: 'Acme', services: [] },
      days: 5,
    });
    expect(r.subject).toContain('Acme');
    expect(r.subject).toContain('5');
    expect(r.html).toContain('5 days');
  });

  test('inactivityAdmin includes rep name', () => {
    const r = email.inactivityAdmin({
      deal: { id: 'd1', companyName: 'Acme', services: [] },
      days: 10,
      ownerName: 'Sara',
    });
    expect(r.subject).toContain('Sara');
    expect(r.subject).toContain('10');
  });
});

describe('approval emails (R-12, R-13, R-14)', () => {
  test('proposalApprovalRequest includes rep + monthly revenue', () => {
    const r = email.proposalApprovalRequest({
      deal: { id: 'd1', companyName: 'Acme', services: [{ name: 'W', monthlyRevenue: 20000 }] },
      rep: { displayName: 'Sara', email: 'sara@x.com' },
    });
    expect(r.subject).toContain('Acme');
    expect(r.html).toContain('Sara');
    expect(r.html).toContain('20,000'); // formatted
  });

  test('proposalApproved includes approver name', () => {
    const r = email.proposalApproved({
      deal: { id: 'd1', companyName: 'Acme', services: [] },
      approver: { displayName: 'Ahmed' },
    });
    expect(r.subject).toContain('Acme');
    expect(r.html).toContain('Ahmed');
  });

  test('proposalRejected includes rework reason', () => {
    const r = email.proposalRejected({
      deal: { id: 'd1', companyName: 'Acme', services: [] },
      approver: { displayName: 'Ahmed' },
      reason: 'Discount too high',
    });
    expect(r.subject).toContain('rework');
    expect(r.html).toContain('Discount too high');
  });

  test('proposalRejected handles missing reason', () => {
    const r = email.proposalRejected({
      deal: { companyName: 'X', services: [] },
      approver: { displayName: 'Y' },
    });
    expect(r.html).toContain('(none provided)');
  });
});

describe('contract & onboarding (R-18, R-21, R-22)', () => {
  test('contractSent includes ARR', () => {
    const r = email.contractSent({
      deal: { id: 'd1', companyName: 'Acme', services: [{ name: 'W', monthlyRevenue: 25000 }] },
    });
    expect(r.subject).toContain('Acme');
    expect(r.subject).toContain('300,000'); // ARR
  });

  test('onboardingHandoff includes onboarding manager + cc rep', () => {
    const r = email.onboardingHandoff({
      deal: { id: 'd1', companyName: 'Acme', contactName: 'Jane', services: [{ name: 'W', monthlyRevenue: 25000 }] },
      rep: { displayName: 'Sara', email: 'sara@x.com' },
      onboardingManager: { displayName: 'Kim', email: 'kim@x.com' },
    });
    expect(r.subject).toContain('Acme');
    expect(r.html).toContain('Kim');
    expect(r.html).toContain('Jane');
    expect(r.cc).toBe('sara@x.com');
  });
});

describe('repReassigned (R-10)', () => {
  test('mentions the previous rep name', () => {
    const r = email.repReassigned({
      deal: { id: 'd1', companyName: 'Acme' },
      oldRepName: 'Sara K.',
    });
    expect(r.subject).toContain('Acme');
    expect(r.html).toContain('Sara K.');
  });

  test('handles undefined old rep gracefully', () => {
    const r = email.repReassigned({
      deal: { id: 'd1', companyName: 'Acme' },
      oldRepName: undefined,
    });
    expect(r.html).toContain('Unassigned');
  });
});

describe('reengagementDue (R-25)', () => {
  test('includes company name', () => {
    const r = email.reengagementDue({
      deal: { id: 'd1', companyName: 'Cascade Fulfillment' },
    });
    expect(r.subject).toContain('Cascade Fulfillment');
  });
});

describe('send() — top-level', () => {
  test('skips with no recipients', async () => {
    const r = await email.send({ to: [], subject: 'X', html: '<p>X</p>' });
    expect(r.skipped).toBe(true);
  });

  test('falls back to dry-run when SMTP unconfigured', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    // re-require to pick up env state (module-level transporter init reads on first send)
    jest.resetModules();
    const freshEmail = require('../services/email');
    const r = await freshEmail.send({ to: 'x@y.com', subject: 'X', html: '<p>X</p>' });
    // Either dryRun:true or sent:false depending on cached state
    expect(r.dryRun || r.sent === false).toBeTruthy();
  });
});
