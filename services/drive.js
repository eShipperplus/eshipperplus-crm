'use strict';

// Google Drive service — creates a per-client folder, uploads contract PDFs,
// and returns shareable links. Uses Application Default Credentials on Cloud
// Run (the Cloud Run service account must have Drive scope).
//
// For local dev, set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON
// that has been shared on the root folder.

const { google } = require('googleapis');

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

function getAuthClient() {
  return new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });
}

async function getDrive() {
  const authClient = await getAuthClient().getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

async function ensureClientFolder(companyName) {
  if (!ROOT_FOLDER_ID) {
    console.warn('[drive] GOOGLE_DRIVE_FOLDER_ID not set — skipping folder creation.');
    return { id: null, webViewLink: null, dryRun: true };
  }
  const drive = await getDrive();
  const safeName = companyName.replace(/['"\\]/g, '').slice(0, 120);

  // Look for an existing folder with the same name under the root
  const q = `'${ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' ` +
            `and name='${safeName}' and trashed=false`;
  const existing = await drive.files.list({ q, fields: 'files(id,name,webViewLink)', pageSize: 1 });
  if (existing.data.files && existing.data.files.length) {
    return existing.data.files[0];
  }
  const created = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [ROOT_FOLDER_ID],
    },
    fields: 'id,name,webViewLink',
  });
  return created.data;
}

async function uploadBuffer({ folderId, name, mimeType, buffer }) {
  const drive = await getDrive();
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: require('stream').Readable.from(buffer) },
    fields: 'id,name,webViewLink,webContentLink',
  });
  return res.data;
}

module.exports = { ensureClientFolder, uploadBuffer };
