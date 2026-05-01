'use strict';

// Gmail-based transactional email. Uses nodemailer with Gmail SMTP via an
// app password, matching the warehouse-billing project. A full Gmail API
// integration (OAuth2 + domain-wide delegation) is a v2 upgrade.

const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM = process.env.EMAIL_FROM || SMTP_USER;
const APP_URL = process.env.PUBLIC_APP_URL || 'https://eshipperplus-crm';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn('[email] SMTP_USER/SMTP_PASS not set — emails will be logged, not sent.');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function send({ to, subject, html, text, cc, replyTo }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };

  const tx = getTransporter();
  const payload = {
    from: FROM,
    to: recipients.join(', '),
    cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    subject,
    text: text || stripHtml(html),
    html,
    replyTo,
  };

  if (!tx) {
    console.log('[email:dry-run]', JSON.stringify({ to: payload.to, subject }, null, 0));
    return { sent: false, dryRun: true };
  }
  const info = await tx.sendMail(payload);
  return { sent: true, id: info.messageId };
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Template helpers ────────────────────────────────────────────────────────
// Centralising copy here makes R-04 template text configurable in one place.

function welcomeEmail({ companyName, contactName }) {
  return {
    subject: `Thanks for reaching out to eShipper Plus — we received your request`,
    html: `
      <p>Hi ${esc(contactName) || 'there'},</p>
      <p>Thanks for contacting <strong>eShipper Plus</strong>. We received your request for
      <strong>${esc(companyName)}</strong> and a member of our team will be in touch within one business day.</p>
      <p>— The eShipper Plus Team</p>
    `,
  };
}

function newLeadNotification({ deal, tier }) {
  return {
    subject: `New lead (Tier ${tier}): ${deal.companyName} — ${deal.source}`,
    html: `
      <p>A new lead has entered the pipeline.</p>
      <ul>
        <li><strong>Company:</strong> ${esc(deal.companyName)}</li>
        <li><strong>Contact:</strong> ${esc(deal.contactName || '')} · ${esc(deal.contactEmail || '')}</li>
        <li><strong>Source:</strong> ${esc(deal.source)}</li>
        <li><strong>Tier:</strong> ${tier} (${monthlyRevenueLabel(deal)})</li>
        <li><strong>Services:</strong> ${(deal.services || []).map(s => esc(s.name) + ' $' + (s.monthlyRevenue || 0)).join(', ') || '—'}</li>
        <li><strong>Assigned rep:</strong> ${esc(deal.ownerName || 'Unassigned')}</li>
      </ul>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal in CRM →</a></p>
    `,
  };
}

function duplicateAlert({ newDeal, existing, matchReasons }) {
  return {
    subject: `Possible duplicate lead — ${newDeal.companyName}`,
    html: `
      <p>A new submission looks like a possible duplicate of an existing deal.</p>
      <p><strong>Match reason:</strong> ${matchReasons.join(', ')}</p>
      <table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial">
        <tr><th></th><th>New submission</th><th>Existing deal</th></tr>
        <tr><td>Company</td><td>${esc(newDeal.companyName)}</td><td>${esc(existing.companyName)}</td></tr>
        <tr><td>Contact</td><td>${esc(newDeal.contactName || '')}</td><td>${esc(existing.contactName || '')}</td></tr>
        <tr><td>Email</td><td>${esc(newDeal.contactEmail || '')}</td><td>${esc(existing.contactEmail || '')}</td></tr>
        <tr><td>Phone</td><td>${esc(newDeal.contactPhone || '')}</td><td>${esc(existing.contactPhone || '')}</td></tr>
        <tr><td>Source</td><td>${esc(newDeal.source)}</td><td>${esc(existing.source)}</td></tr>
        <tr><td>Stage</td><td>${esc(newDeal.stage)}</td><td>${esc(existing.stage)}</td></tr>
        <tr><td>Owner</td><td>${esc(newDeal.ownerName || '')}</td><td>${esc(existing.ownerName || '')}</td></tr>
        <tr><td>Value</td><td>${monthlyRevenueLabel(newDeal)}</td><td>${monthlyRevenueLabel(existing)}</td></tr>
      </table>
      <p><a href="${APP_URL}/#deal/${newDeal.id}">Review new deal →</a> ·
         <a href="${APP_URL}/#deal/${existing.id}">Review existing →</a></p>
    `,
  };
}

function inactivityRep({ deal, days }) {
  return {
    subject: `Inactivity alert: ${deal.companyName} (${days} days)`,
    html: `
      <p>No activity has been logged on <strong>${esc(deal.companyName)}</strong> for ${days} days.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function inactivityAdmin({ deal, days, ownerName }) {
  return {
    subject: `Escalation: ${deal.companyName} — ${days} days inactive (${ownerName})`,
    html: `
      <p><strong>${esc(deal.companyName)}</strong> has had no activity for ${days} days.
      Assigned rep: <strong>${esc(ownerName || 'Unassigned')}</strong>.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function proposalApprovalRequest({ deal, rep }) {
  return {
    subject: `Proposal approval needed: ${deal.companyName}`,
    html: `
      <p><strong>${esc(rep.displayName)}</strong> is requesting approval to send a proposal for
      <strong>${esc(deal.companyName)}</strong> (${monthlyRevenueLabel(deal)}).</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Review and approve →</a></p>
    `,
  };
}

function proposalApproved({ deal, approver }) {
  return {
    subject: `Proposal approved: ${deal.companyName}`,
    html: `
      <p>${esc(approver.displayName)} approved the proposal for <strong>${esc(deal.companyName)}</strong>.
      The proposal PDF is attached to the deal — please review and send it to the client manually.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function proposalRejected({ deal, approver, reason }) {
  return {
    subject: `Proposal rework needed: ${deal.companyName}`,
    html: `
      <p>${esc(approver.displayName)} rejected the proposal for <strong>${esc(deal.companyName)}</strong>.</p>
      <p><strong>Rework notes:</strong> ${esc(reason || '(none provided)')}</p>
      <p>The deal remains in Qualified. <a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function contractSent({ deal }) {
  return {
    subject: `Contract sent: ${deal.companyName} — ARR ${arrLabel(deal)}`,
    html: `
      <p>Closed Won: <strong>${esc(deal.companyName)}</strong> — ARR <strong>${arrLabel(deal)}</strong>.
      Contract generated from template and sent via Google Workspace eSignature.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function onboardingHandoff({ deal, rep, onboardingManager }) {
  return {
    subject: `Onboarding kickoff: ${deal.companyName}`,
    html: `
      <p>Hi ${esc(onboardingManager.displayName)},</p>
      <p><strong>${esc(deal.companyName)}</strong> has signed the contract and is ready for onboarding.</p>
      <ul>
        <li><strong>Contact:</strong> ${esc(deal.contactName || '')} · ${esc(deal.contactEmail || '')} · ${esc(deal.contactPhone || '')}</li>
        <li><strong>Services:</strong> ${(deal.services || []).map(s => esc(s.name)).join(', ') || '—'}</li>
        <li><strong>ARR:</strong> ${arrLabel(deal)}</li>
        <li><strong>Sales rep (cc):</strong> ${esc(rep?.displayName || 'Unassigned')}</li>
      </ul>
      <p>T+1 SLA active. <a href="${APP_URL}/#onboarding/${deal.id}">Open onboarding checklist →</a></p>
    `,
    cc: rep?.email,
  };
}

function onboardingAdmin({ deal }) {
  return {
    subject: `Onboarding started: ${deal.companyName} — ARR ${arrLabel(deal)} confirmed`,
    html: `
      <p><strong>${esc(deal.companyName)}</strong> has signed and entered onboarding.
      ARR <strong>${arrLabel(deal)}</strong> is confirmed.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function repReassigned({ deal, oldRepName }) {
  return {
    subject: `You have been assigned ${deal.companyName}`,
    html: `
      <p>You have been assigned <strong>${esc(deal.companyName)}</strong> — previously owned by
      <strong>${esc(oldRepName || 'Unassigned')}</strong>.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

function reengagementDue({ deal }) {
  return {
    subject: `Re-engagement due: ${deal.companyName}`,
    html: `
      <p>The re-engagement date for <strong>${esc(deal.companyName)}</strong> (Closed Lost) has arrived.
      Consider reaching out to the contact again.</p>
      <p><a href="${APP_URL}/#deal/${deal.id}">Open deal →</a></p>
    `,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function monthlyRevenueTotal(deal) {
  return (deal.services || []).reduce((sum, s) => sum + (Number(s.monthlyRevenue) || 0), 0);
}
function monthlyRevenueLabel(deal) {
  const m = monthlyRevenueTotal(deal);
  return '$' + m.toLocaleString() + '/mo';
}
function arrLabel(deal) {
  const arr = monthlyRevenueTotal(deal) * 12;
  return '$' + arr.toLocaleString();
}

module.exports = {
  send,
  welcomeEmail,
  newLeadNotification,
  duplicateAlert,
  inactivityRep,
  inactivityAdmin,
  proposalApprovalRequest,
  proposalApproved,
  proposalRejected,
  contractSent,
  onboardingHandoff,
  onboardingAdmin,
  repReassigned,
  reengagementDue,
};
