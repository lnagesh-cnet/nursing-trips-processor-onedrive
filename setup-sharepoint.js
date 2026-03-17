#!/usr/bin/env node

/**
 * setup-sharepoint.js
 *
 * One-time setup script to provision the SharePoint structure for Nursing Trips.
 *
 * What it does:
 *   1. Creates a Microsoft 365 Group → auto-provisions a SharePoint team site
 *      Site URL: https://signtalkfoundation.sharepoint.com/sites/Operations
 *   2. Creates folder structure in the default document library:
 *      Shared Documents/
 *        └── Nursing Trips/
 *            ├── PDFs/
 *            │   └── 2026/
 *            │       ├── January/
 *            │       ├── February/
 *            │       └── ... (all 12 months)
 *            └── NursingTrips_Log.xlsx  (trip data backup)
 *   3. Creates an Excel workbook with the Trip_Details table (same columns as Google Sheet)
 *   4. Outputs the site ID, drive ID, and workbook item ID for env vars
 *
 * Prerequisites:
 *   - Azure app (MS_CLIENT_ID) must have these APPLICATION permissions:
 *       Group.ReadWrite.All      (create M365 group)
 *       Sites.ReadWrite.All      (access SharePoint)
 *       Files.ReadWrite.All      (upload files, manage Excel)
 *   - Admin consent granted in Azure Portal
 *
 * Usage:
 *   MS_TENANT_ID=xxx MS_CLIENT_ID=xxx MS_CLIENT_SECRET=xxx node setup-sharepoint.js
 *
 * After running, add these env vars to Render:
 *   SP_SITE_ID        → from output
 *   SP_DRIVE_ID       → from output
 *   SP_WORKBOOK_ID    → from output
 *   SP_TABLE_NAME     → TripDetails
 */

const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

const GROUP_DISPLAY_NAME = 'Operations';
const GROUP_MAIL_NICKNAME = 'operations';
const GROUP_DESCRIPTION = 'Operations team — nursing trips, coordination, and ops data';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const SHEET_HEADERS = [
  'emailReceived','pdfLink','requestType','confirmId','tripCode',
  'todaysDate','overnightTrip','startDate','endDate','startTime','endTime',
  'destination','schoolName','address','atsDbn','district','region',
  'requester','phone1','phone2','studentInitials','studentId','dob',
  'medicalNeeds','textTemplate','tripLiaison','tripLiaisonEmail','tripLiaisonPhone'
];

async function getToken() {
  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default'
      })
    }
  );
  const data = await resp.json();
  if (!data.access_token) {
    console.error('Token error:', data);
    throw new Error('Failed to get token. Check credentials and permissions.');
  }
  return data.access_token;
}

async function graphRequest(token, method, path, body = null) {
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`Graph ${method} ${path} → ${resp.status}`);
    console.error(text);
    throw new Error(`Graph API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET');
    process.exit(1);
  }

  console.log('=== SharePoint Setup for Nursing Trips ===\n');

  const token = await getToken();
  console.log('[1/6] Got Graph API token\n');

  // ── Step 1: Check if group already exists ──
  let group;
  try {
    const existing = await graphRequest(token, 'GET',
      `/groups?$filter=mailNickname eq '${GROUP_MAIL_NICKNAME}'&$select=id,displayName,mailNickname`
    );
    if (existing.value && existing.value.length > 0) {
      group = existing.value[0];
      console.log(`[2/6] Group "${group.displayName}" already exists (${group.id})`);
    }
  } catch (e) {
    // Group lookup failed, try creating
  }

  if (!group) {
    console.log('[2/6] Creating Microsoft 365 Group "Operations"...');
    group = await graphRequest(token, 'POST', '/groups', {
      displayName: GROUP_DISPLAY_NAME,
      mailNickname: GROUP_MAIL_NICKNAME,
      description: GROUP_DESCRIPTION,
      groupTypes: ['Unified'],
      mailEnabled: true,
      securityEnabled: false,
      visibility: 'Private'
    });
    console.log(`  Group created: ${group.id}`);
    console.log('  Waiting 30s for SharePoint site provisioning...');
    await sleep(30000);
  }

  // ── Step 2: Get the SharePoint site ──
  let site;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      site = await graphRequest(token, 'GET', `/groups/${group.id}/sites/root`);
      break;
    } catch (e) {
      if (attempt < 5) {
        console.log(`  Site not ready, waiting 15s (attempt ${attempt}/5)...`);
        await sleep(15000);
      } else {
        throw new Error('SharePoint site not provisioned after 5 attempts');
      }
    }
  }
  console.log(`[3/6] SharePoint site: ${site.webUrl}`);
  console.log(`  Site ID: ${site.id}\n`);

  // ── Step 3: Get the default document library drive ──
  const drive = await graphRequest(token, 'GET', `/sites/${site.id}/drive`);
  console.log(`[4/6] Document library drive: ${drive.id}`);

  // ── Step 4: Create folder structure ──
  console.log('[5/6] Creating folder structure...');

  // Create Nursing Trips root folder
  await graphRequest(token, 'POST', `/drives/${drive.id}/root/children`, {
    name: 'Nursing Trips',
    folder: {},
    '@microsoft.graph.conflictBehavior': 'replace'
  });
  console.log('  Created: Nursing Trips/');

  // Create PDFs subfolder
  await graphRequest(token, 'POST',
    `/drives/${drive.id}/root:/Nursing Trips:/children`,
    { name: 'PDFs', folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }
  );
  console.log('  Created: Nursing Trips/PDFs/');

  // Create year folder
  const year = new Date().getFullYear().toString();
  await graphRequest(token, 'POST',
    `/drives/${drive.id}/root:/Nursing Trips/PDFs:/children`,
    { name: year, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }
  );
  console.log(`  Created: Nursing Trips/PDFs/${year}/`);

  // Create month folders
  for (const month of MONTHS) {
    await graphRequest(token, 'POST',
      `/drives/${drive.id}/root:/Nursing Trips/PDFs/${year}:/children`,
      { name: month, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }
    );
  }
  console.log(`  Created 12 month folders under ${year}/`);

  // ── Step 5: Create Excel workbook with table ──
  console.log('[6/6] Creating Excel workbook...');

  // Upload an empty xlsx (Graph API can create a workbook by uploading)
  // We'll create a minimal xlsx using the workbook session API
  // First, upload an empty file
  const emptyXlsx = Buffer.from(
    'UEsDBBQAAAAIAAAAAACKIYazTAAAAE8AAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbHWOywrC' +
    'MBBE9/0KubdNXYjI0o0b19IfiMm0DW0emYni/5sUH+BuZs6ZYTr7cHbVjVIK3gu4agrByCuf' +
    'rR8K8T2d1zsokuiMnb2nQswUxaE7P/WK8yGWYkykZ4mp8kj6AxWliyFRfpF/2lpml/MbUKcp' +
    'PwN1XAAAAFBLAQIUABQAAAAIAAAAAIKIY azTAAAAE8AAAATAAAAAAAAAAAAIAAAAAAAAW0Nv' +
    'bnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAAAQABAEEAAAB9AAAAAAA=',
    'base64'
  );

  // Actually, let's use a simpler approach: create via Graph API session
  // Upload a placeholder, then use Excel API to set up the table
  const uploadPath = encodeURIComponent('Nursing Trips') + '/' + encodeURIComponent('NursingTrips_Log.xlsx');

  // Create workbook using the createSession approach — first upload minimal xlsx
  // Graph API can work with .xlsx created by PUT
  const createResp = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${drive.id}/root:/${uploadPath}:/content`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      },
      body: emptyXlsx
    }
  );

  if (!createResp.ok) {
    // If empty xlsx fails, try creating via workbook endpoint
    console.log('  Empty xlsx upload failed, trying alternative...');
    // Upload as empty file first
    const altResp = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${drive.id}/root:/${uploadPath}:/content`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        body: Buffer.alloc(0)
      }
    );
    if (!altResp.ok) {
      const errText = await altResp.text();
      console.error('  Could not create Excel file:', errText.slice(0, 200));
      console.log('\n  MANUAL STEP NEEDED:');
      console.log('  1. Go to the SharePoint site and create a blank Excel workbook');
      console.log('     named "NursingTrips_Log.xlsx" in the "Nursing Trips" folder');
      console.log('  2. Add a row with these headers in A1-AB1:');
      console.log(`     ${SHEET_HEADERS.join(', ')}`);
      console.log('  3. Select the header row → Insert → Table');
      console.log('  4. Rename the table to "TripDetails"');
    }
  }

  const workbookItem = createResp.ok ? await createResp.json() : null;

  if (workbookItem) {
    console.log(`  Workbook created: ${workbookItem.name} (${workbookItem.id})`);

    // Wait for Excel services to register the file
    await sleep(5000);

    // Add headers to the worksheet
    try {
      const headerValues = [SHEET_HEADERS];
      await graphRequest(token, 'PATCH',
        `/drives/${drive.id}/items/${workbookItem.id}/workbook/worksheets/Sheet1/range(address='A1:AB1')`,
        { values: headerValues }
      );
      console.log('  Headers written to row 1');

      // Create a table from the header row
      await graphRequest(token, 'POST',
        `/drives/${drive.id}/items/${workbookItem.id}/workbook/tables/add`,
        {
          address: 'Sheet1!A1:AB1',
          hasHeaders: true
        }
      );

      // Rename the table
      await graphRequest(token, 'PATCH',
        `/drives/${drive.id}/items/${workbookItem.id}/workbook/tables/1`,
        { name: 'TripDetails' }
      );
      console.log('  Table "TripDetails" created');
    } catch (e) {
      console.log('  Could not set up table automatically. Manual step needed:');
      console.log('  Open the workbook → select headers → Insert → Table → rename to "TripDetails"');
    }
  }

  // ── Output ──
  console.log('\n=== SETUP COMPLETE ===\n');
  console.log('Add these environment variables to Render:\n');
  console.log(`  SP_SITE_ID=${site.id}`);
  console.log(`  SP_DRIVE_ID=${drive.id}`);
  if (workbookItem) {
    console.log(`  SP_WORKBOOK_ID=${workbookItem.id}`);
  }
  console.log(`  SP_TABLE_NAME=TripDetails`);
  console.log(`  SP_PDF_BASE_PATH=Nursing Trips/PDFs`);
  console.log(`\nSharePoint site: ${site.webUrl}`);

  console.log('\n=== Azure App Permission Checklist ===');
  console.log('Ensure the app registration has these APPLICATION permissions:');
  console.log('  - Sites.ReadWrite.All');
  console.log('  - Files.ReadWrite.All');
  console.log('  - Group.ReadWrite.All (only needed for this setup script)');
  console.log('  - Mail.Read, Mail.ReadWrite (already have)');
  console.log('\nGrant admin consent in Azure Portal → App registrations → API permissions');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
