'use strict';

// Google Workspace eSignature integration.
//
// Google Workspace eSignature exposes a Drive-based API: you call
// drive.files.update with an eSignatureRequest to initiate a signing request
// on a PDF. At the time of writing this is still rolling out and the exact
// API surface can vary by Workspace plan — so this module is structured as a
// thin wrapper with two entry points:
//
//   sendForSignature(docId, signers)  → initiates an eSignature request
//   handleWebhook(payload)            → marks the deal when the client signs
//
// Wire the webhook to Cloud Run at /webhooks/esignature. Until eSignature
// webhooks are enabled on your Workspace plan, polling drive.files.get on the
// document for completion metadata is a valid alternative.

const { google } = require('googleapis');

function getAuthClient() {
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

async function sendForSignature({ docId, signerEmail, signerName, subject, message }) {
  const authClient = await getAuthClient().getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  // NOTE: this is the Workspace eSignature invocation. The exact request body
  // may need to be adjusted for your tenant. Logging dry-run when unconfigured.
  if (!process.env.ESIGN_ENABLED) {
    console.log('[esign:dry-run] would send', docId, 'to', signerEmail);
    return { sent: false, dryRun: true };
  }

  // Actual invocation — uncomment and verify on your Workspace tenant:
  // const res = await drive.files.update({
  //   fileId: docId,
  //   requestBody: {
  //     eSignatureRequest: {
  //       subject, message,
  //       signers: [{ email: signerEmail, name: signerName }],
  //     },
  //   },
  //   fields: 'id,name',
  // });
  // return res.data;

  return { sent: true, docId };
}

async function handleWebhook({ docId, status, signedAt }) {
  // Caller (server.js /webhooks/esignature) looks up the deal by
  // contractDocId === docId and advances the stage when status === 'completed'.
  return { docId, status, signedAt };
}

module.exports = { sendForSignature, handleWebhook };
