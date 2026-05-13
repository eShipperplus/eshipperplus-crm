'use strict';

// Google Docs contract generation. Copies a template doc, substitutes the
// {{placeholders}}, and returns the new doc's ID (which can then be exported
// to PDF via Drive, or sent via Google Workspace eSignature).
//
// Template is identified by CONTRACT_TEMPLATE_DOC_ID. The template body should
// contain placeholders like {{companyName}}, {{contactName}}, {{arr}}, etc.

const { google } = require('googleapis');

const TEMPLATE_ID = process.env.CONTRACT_TEMPLATE_DOC_ID || '';

function getAuthClient() {
  return new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });
}

async function getClients() {
  const authClient = await getAuthClient().getClient();
  return {
    drive: google.drive({ version: 'v3', auth: authClient }),
    docs: google.docs({ version: 'v1', auth: authClient }),
  };
}

async function generateContract({ deal, folderId }) {
  if (!TEMPLATE_ID) {
    console.warn('[docs] CONTRACT_TEMPLATE_DOC_ID not set — skipping contract generation.');
    return { id: null, dryRun: true };
  }
  const { drive, docs } = await getClients();

  // 1) Copy the template into the client's folder.
  // supportsAllDrives lets the SA touch human-owned / shared folders.
  const copy = await drive.files.copy({
    fileId: TEMPLATE_ID,
    requestBody: {
      name: `${deal.companyName} — Service Agreement`,
      parents: folderId ? [folderId] : undefined,
    },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });
  const docId = copy.data.id;

  // 2) Replace placeholders
  const monthly = (deal.services || []).reduce((s, svc) => s + (Number(svc.monthlyRevenue) || 0), 0);
  const replacements = {
    '{{companyName}}': deal.companyName || '',
    '{{contactName}}': deal.contactName || '',
    '{{contactEmail}}': deal.contactEmail || '',
    '{{contactPhone}}': deal.contactPhone || '',
    '{{monthlyRevenue}}': '$' + monthly.toLocaleString(),
    '{{arr}}': '$' + (monthly * 12).toLocaleString(),
    '{{services}}': (deal.services || []).map(s => `${s.name}: $${s.monthlyRevenue}/mo`).join('\n'),
    '{{dealId}}': deal.id || '',
    '{{effectiveDate}}': new Date().toISOString().slice(0, 10),
  };

  const requests = Object.entries(replacements).map(([find, replace]) => ({
    replaceAllText: { containsText: { text: find, matchCase: true }, replaceText: String(replace) },
  }));
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  return copy.data;
}

async function exportPdf({ docId }) {
  const { drive } = await getClients();
  const res = await drive.files.export(
    { fileId: docId, mimeType: 'application/pdf', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

module.exports = { generateContract, exportPdf };
