import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { downloadPdfFromForm } from './browser-automation.js';
import { buildFieldsObject, parseStudentTable } from './pdf-extractor.js';

// Decode Google service account credentials from base64 env var (for Render deployment)
if (process.env.GOOGLE_CREDENTIALS_BASE64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const credPath = path.join(os.tmpdir(), 'google-credentials.json');
  fs.writeFileSync(credPath, Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64'));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
  console.log('[PROCESSOR] Google credentials decoded from GOOGLE_CREDENTIALS_BASE64');
}

const drive = google.drive('v3');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '19vqYbaZ9sljtROSlVIZFnp5IaTGroyHT';

/**
 * Main processor with pdf-parse field extraction and Google Drive upload
 */
export async function processSecureEmail({ htmlContent, htmlBase64, messageId, attachmentId, emailSubject }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nursing-trip-'));
  console.log(`[PROCESSOR] Working dir: ${tmpDir}`);

  const htmlFilename = 'securedoc.html';
  const htmlPath = path.join(tmpDir, htmlFilename);

  try {
    // ===== STEP 1: Fetch HTML from Microsoft Graph =====
    if (!htmlContent && !htmlBase64 && messageId && attachmentId) {
      console.log('[PROCESSOR] Fetching attachment from Graph API...');

      const tokenResp = await fetch(
        `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.MS_CLIENT_ID,
            client_secret: process.env.MS_CLIENT_SECRET,
            scope: 'https://graph.microsoft.com/.default'
          })
        }
      );
      const tokenData = await tokenResp.json();
      if (!tokenData.access_token) throw new Error('Failed to get MS token');

      const userEmail = process.env.MS_USER_EMAIL;
      const attachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${messageId}/attachments/${attachmentId}/$value`;
      const attachResp = await fetch(attachUrl, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      if (!attachResp.ok) throw new Error(`Graph fetch failed: ${attachResp.status}`);

      const arrayBuffer = await attachResp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const { gunzipSync } = await import('zlib');
      try { htmlContent = gunzipSync(buffer).toString('utf-8'); }
      catch(e) { htmlContent = buffer.toString('utf-8'); }
    }

    if (!htmlContent) throw new Error('No HTML content available');

    // ===== STEP 2: Write HTML to disk =====
    await fs.writeFile(htmlPath, htmlContent, 'utf-8');
    console.log(`[PROCESSOR] HTML written: ${(htmlContent.length / 1024).toFixed(1)}KB`);

    // ===== STEP 3: Use Puppeteer to decrypt and download PDF =====
    console.log('[PROCESSOR] Starting Puppeteer to decrypt envelope...');
    const pdfPath = await downloadPdfFromForm({ formAction: null }, htmlPath, tmpDir);
    console.log('[PROCESSOR] PDF downloaded to:', pdfPath);

    // ===== STEP 4: Extract fields using pdf-parse + regex =====
    console.log('[PROCESSOR] Extracting fields with pdf-parse...');
    const extractedData = await extractFieldsWithPdfParse(pdfPath, emailSubject);
    console.log('[PROCESSOR] Extracted data:', JSON.stringify(extractedData, null, 2));

    // ===== STEP 5: Parse email subject for Confirm ID and Trip Code =====
    const metadata = parseEmailSubject(emailSubject || '');
    const pdfFilename = `${metadata.tripCode || 'UNKNOWN'}_${metadata.confirmId || Date.now()}.pdf`;

    // ===== STEP 6: Upload PDF to Google Drive =====
    console.log('[PROCESSOR] Uploading to Google Drive...');
    const driveFileId = await uploadToDrive(pdfPath, pdfFilename);
    const driveUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
    console.log('[PROCESSOR] Uploaded to Drive:', driveUrl);

    // ===== STEP 7: Clean up =====
    await fs.remove(tmpDir);

    return {
      success: true,
      driveUrl,
      driveFileId,
      pdfFilename,
      tripFields: {
        ...metadata,
        ...extractedData.tripFields
      },
      students: extractedData.students || []
    };

  } catch (error) {
    await fs.remove(tmpDir).catch(() => {});
    throw error;
  }
}

/**
 * Extract fields from PDF using pdf-parse + regex.
 * Runs entirely on-server — no cloud AI service needed.
 * HIPAA-safe: PDF data never leaves the Render container.
 */
async function extractFieldsWithPdfParse(pdfPath, emailSubject = '') {
  try {
    const pdfBuffer = await fs.readFile(pdfPath);
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(pdfBuffer);
    const text = data.text;
    console.log(`[PDFPARSE] Extracted text length: ${text.length}`);

    const fields = buildFieldsObject(text, {}, {}, emailSubject, 'pdf_parse');
    const students = fields.students || parseStudentTable(text);

    return {
      tripFields: {
        todaysDate: fields.todaysDate,
        overnightTrip: fields.overnight,
        startDate: fields.startDate,
        endDate: fields.endDate,
        startTime: fields.startTime,
        endTime: fields.endTime,
        destination: fields.destination,
        schoolName: fields.schoolName,
        address: fields.address,
        atsDbn: fields.atsDbn,
        district: fields.district,
        region: fields.region,
        requester: fields.personRequesting,
        phone1: fields.phone1,
        phone2: fields.phone2,
      },
      students
    };
  } catch (error) {
    console.error('[PDFPARSE] pdf-parse failed:', error.message);
    return { tripFields: {}, students: [] };
  }
}

/**
 * Upload PDF to Google Drive
 */
async function uploadToDrive(pdfPath, filename) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const authClient = await auth.getClient();
  google.options({ auth: authClient });

  const fileMetadata = {
    name: filename,
    parents: [DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType: 'application/pdf',
    body: fs.createReadStream(pdfPath),
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id',
    supportsAllDrives: true,
  });

  // Make file accessible to anyone with link
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,
  });

  return response.data.id;
}

/**
 * Parse email subject for Confirm ID and Trip Code
 * (These come from email, not PDF)
 */
function parseEmailSubject(subject) {
  const confirmMatch = subject.match(/Confirm ID:\s*(\d+)/i);
  const tripCodeMatch = subject.match(/\|\s*([A-Z0-9]+)\s*\|/);

  return {
    confirmId: confirmMatch ? confirmMatch[1] : null,
    tripCode: tripCodeMatch ? tripCodeMatch[1] : null,
    emailSubject: subject
  };
}
