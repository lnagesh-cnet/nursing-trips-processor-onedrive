import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { downloadPdfFromForm } from './browser-automation.js';
import { buildFieldsObject, parseStudentTable } from './pdf-extractor.js';

/**
 * Get a Microsoft Graph API access token using client credentials flow.
 * Reused for email attachment fetching, SharePoint upload, and Excel append.
 */
async function getMsGraphToken() {
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
  if (!tokenData.access_token) throw new Error('Failed to get MS Graph token');
  return tokenData.access_token;
}

/**
 * Main processor: PDF extraction + SharePoint upload (standalone backup service)
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

      const token = await getMsGraphToken();
      const userEmail = process.env.MS_USER_EMAIL;
      const attachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${messageId}/attachments/${attachmentId}/$value`;
      const attachResp = await fetch(attachUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
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

    const tripDate = extractedData.tripFields.startDate || extractedData.tripFields.todaysDate || '';

    // ===== STEP 6: Upload PDF to SharePoint =====
    console.log('[PROCESSOR] Uploading to SharePoint...');
    const sharePointUrl = await uploadToSharePoint(pdfPath, pdfFilename, tripDate);
    console.log('[PROCESSOR] Uploaded to SharePoint:', sharePointUrl);

    // ===== STEP 7: Clean up =====
    await fs.remove(tmpDir);

    return {
      success: true,
      sharePointUrl,
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
 * Upload PDF to SharePoint document library organized by year/month.
 * Uses Microsoft Graph API PUT endpoint which auto-creates folders.
 *
 * SharePoint path: Nursing Trips/PDFs/{Year}/{Month}/{filename}.pdf
 */
async function uploadToSharePoint(pdfPath, filename, tripDate) {
  const token = await getMsGraphToken();
  const driveId = process.env.SP_DRIVE_ID;
  const basePath = process.env.SP_PDF_BASE_PATH || 'Nursing Trips/PDFs';

  if (!driveId) {
    throw new Error('SP_DRIVE_ID not set — run setup-sharepoint.js first');
  }

  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  let year, month;
  const dateMatch = tripDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    year = dateMatch[3];
    month = monthNames[parseInt(dateMatch[1], 10) - 1] || 'Unknown';
  } else {
    const now = new Date();
    year = String(now.getFullYear());
    month = monthNames[now.getMonth()];
  }

  const filePath = `${basePath}/${year}/${month}/${filename}`;
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/content`;

  console.log(`[SHAREPOINT] Uploading to ${year}/${month}/`);
  const fileBuffer = await fs.readFile(pdfPath);

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/pdf'
    },
    body: fileBuffer
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`SharePoint upload failed (${uploadResp.status}): ${errText}`);
  }

  const fileData = await uploadResp.json();
  console.log(`[SHAREPOINT] File created: ${fileData.name} (${fileData.size} bytes)`);

  try {
    const shareResp = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${fileData.id}/createLink`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'view',
          scope: 'organization'
        })
      }
    );

    if (shareResp.ok) {
      const shareData = await shareResp.json();
      console.log('[SHAREPOINT] Sharing link created');
      return shareData.link.webUrl;
    }
  } catch (shareErr) {
    console.log('[SHAREPOINT] Could not create sharing link:', shareErr.message);
  }

  return fileData.webUrl;
}

/**
 * Append a row to the SharePoint Excel workbook (TripDetails table).
 * Called by the /append-row endpoint after N8n formats the full row.
 */
export async function appendToSharePointExcel(rowData) {
  const token = await getMsGraphToken();
  const driveId = process.env.SP_DRIVE_ID;
  const workbookId = process.env.SP_WORKBOOK_ID;
  const tableName = process.env.SP_TABLE_NAME || 'TripDetails';

  if (!driveId || !workbookId) {
    throw new Error('SP_DRIVE_ID or SP_WORKBOOK_ID not set — run setup-sharepoint.js first');
  }

  const columns = [
    'emailReceived','pdfLink','requestType','confirmId','tripCode',
    'todaysDate','overnightTrip','startDate','endDate','startTime','endTime',
    'destination','schoolName','address','atsDbn','district','region',
    'requester','phone1','phone2','studentInitials','studentId','dob',
    'medicalNeeds','textTemplate','tripLiaison','tripLiaisonEmail','tripLiaisonPhone'
  ];

  const values = [columns.map(col => rowData[col] || '')];

  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${workbookId}/workbook/tables/${tableName}/rows/add`;

  console.log(`[SHAREPOINT-EXCEL] Appending row: confirmId=${rowData.confirmId || 'N/A'}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`SharePoint Excel append failed (${resp.status}): ${errText}`);
  }

  const result = await resp.json();
  console.log('[SHAREPOINT-EXCEL] Row appended successfully');
  return result;
}

/**
 * Parse email subject for Confirm ID and Trip Code
 */
function parseEmailSubject(subject) {
  const confirmMatch = subject.match(/Confirm ID:\s*(\d+)/i);
  const tripCodeMatch = subject.match(/\|\s*([A-Z0-9]+(?:@[A-Z0-9]+)?)\s*\|/i);

  return {
    confirmId: confirmMatch ? confirmMatch[1] : null,
    tripCode: tripCodeMatch ? tripCodeMatch[1] : null,
    emailSubject: subject
  };
}
