# Nursing Trips Automation - IT Infrastructure Documentation

> **Version:** 5.0 (Outlook Trigger)
> **Last Updated:** February 26, 2026
> **Author:** Lavanya Nagesh / Engineering
> **Classification:** Internal - HIPAA Restricted

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Component Inventory](#3-component-inventory)
4. [Data Flow - End to End](#4-data-flow---end-to-end)
5. [N8n Workflow - Node-by-Node](#5-n8n-workflow---node-by-node)
6. [Render Processor Service](#6-render-processor-service)
7. [Microsoft Azure AD Configuration](#7-microsoft-azure-ad-configuration)
8. [Google Cloud Configuration](#8-google-cloud-configuration)
9. [Environment Variables & Secrets](#9-environment-variables--secrets)
10. [Network & Connectivity](#10-network--connectivity)
11. [Security & HIPAA Compliance](#11-security--hipaa-compliance)
12. [Deployment Procedures](#12-deployment-procedures)
13. [Monitoring & Alerting](#13-monitoring--alerting)
14. [Troubleshooting Runbook](#14-troubleshooting-runbook)
15. [Version History](#15-version-history)

---

## 1. System Overview

### Purpose

Automates the processing of NYC Department of Health (DOH) nursing trip request emails. Trip requests arrive as Cisco Secure Email envelopes containing encrypted PDF attachments. The system:

1. Detects new trip emails in an Outlook mailbox (polling every 60 seconds)
2. Classifies each email as **New**, **Modified**, or **Cancelled**
3. For New/Modified: decrypts the Cisco envelope, extracts structured data from the PDF, uploads the PDF to Google Drive
4. Writes a structured row to a Google Sheet for nursing coordinators
5. Tracks processed emails to prevent duplicates

### Business Context

- **Prior process:** Manual - coordinators opened each email, decrypted it, read the PDF, and typed data into a spreadsheet (~10+ hours/week)
- **Automation savings:** ~8 hours/week, eliminates transcription errors
- **Email volume:** ~15-25 trip emails per business day
- **Email types:** New requests (~70%), Modifications (~15%), Cancellations (~15%)
- **Users:** Nursing trip coordinators at Comprehensive Network Inc. (SIGNTALK FOUNDATION, INC.)
- **Mailbox:** lnagesh@comprehensivenet.com

---

## 2. Architecture Diagram

```
                                   INTERNET
    ============================================================================

    NYC DOH                                              Google Cloud
    +------------------+                                 +-------------------+
    | Cisco Secure     |  SMTP                           | Google Drive      |
    | Email Gateway    | ------>  Microsoft 365           | Folder: Nursing   |
    +------------------+         +------------------+    | Trip PDFs         |
                                 | Outlook Mailbox  |    | ID: 19vqYba...    |
                                 | lnagesh@compre.. |    +-------------------+
                                 +--------+---------+            ^
                                          |                      |
                                          | Microsoft Graph API  | Google Drive API
                                          | (OAuth2)             | (Service Account)
                                          v                      |
    Render Cloud                                                 |
    +=============================================================+
    |                                                             |
    |  +------------------+     HTTP POST      +----------------+ |
    |  | N8n Instance     | -----------------> | Processor      | |
    |  | (Workflow Engine)|    /process         | (Node.js +     | |
    |  |                  |                    | Puppeteer +    | |
    |  | Polls every 1min |                    | Chromium)      | |
    |  | via Outlook      | <----------------- |                | |
    |  | Trigger          |    JSON response   | Port 10000     | |
    |  +--------+---------+                    +----------------+ |
    |           |                                                 |
    +=============================================================+
                |
                | Google Sheets API
                | (Service Account)
                v
    +-------------------+
    | Google Sheets     |
    | N8N_Nursing_Trips |
    | Tab: Trip_Details |
    | ID: 1ukXEeN...    |
    +-------------------+
```

---

## 3. Component Inventory

### 3.1 N8n Workflow Engine

| Property | Value |
|----------|-------|
| **Service** | N8n (self-hosted on Render) |
| **URL** | https://n8n-lto2.onrender.com |
| **Workflow ID** | MxEZiPG2HiOO6Vp3 |
| **Workflow URL** | https://n8n-lto2.onrender.com/workflow/MxEZiPG2HiOO6Vp3 |
| **Node Count** | 14-15 nodes (depending on version) |
| **Trigger** | Microsoft Outlook Trigger (polling every 1 minute) |
| **Timezone** | America/New_York (EST/EDT) |
| **Tags** | nursing-trips, automation |

### 3.2 Render Processor Service

| Property | Value |
|----------|-------|
| **Service Name** | nursing-trips-processor |
| **URL** | https://nursing-trips-processor.onrender.com |
| **Runtime** | Docker (Node.js 20 + Chromium) |
| **Plan** | Standard |
| **Port** | 10000 |
| **Health Check** | GET / |
| **Source Repo** | https://github.com/lnagesh-cnet/nursing-trips-processor |
| **Branch** | main |

### 3.3 Microsoft 365 / Azure AD

| Property | Value |
|----------|-------|
| **Tenant ID** | 2d090015-90ea-4cce-92f0-1581080b0fc2 |
| **Mailbox** | lnagesh@comprehensivenet.com |
| **Azure App (N8n Trigger)** | n8n Email Parser - Comprehensive |
| **App Client ID** | a66e0bc0-d73f-4b3c-89a0-7ae7042ce1e6 |
| **Azure App (Processor)** | N8n Email Automation |
| **App Client ID** | c37e3adc-2f69-4656-9c1b-a9bb73abc714 |
| **N8n Credential Name** | Lavanya Microsoft Outlook account |
| **N8n Credential Type** | Microsoft Outlook OAuth2 API (microsoftOutlookOAuth2Api) |
| **OAuth Redirect URI** | https://n8n-lto2.onrender.com/rest/oauth2-credential/callback |
| **API Permissions** | Mail.Read, Mail.ReadWrite |

### 3.4 Google Workspace

| Property | Value |
|----------|-------|
| **Google Sheet Name** | N8N_Nursing_Trips |
| **Sheet ID** | 1ukXEeNhbNYOHERWV2NroELaR4jwQJoYL0900__m4ur0 |
| **Tab Name** | Trip_Details (gid: 1623775001) |
| **Sheet URL** | https://docs.google.com/spreadsheets/d/1ukXEeNhbNYOHERWV2NroELaR4jwQJoYL0900__m4ur0/edit?gid=1623775001 |
| **Google Drive Folder** | Nursing Trip PDFs |
| **Drive Folder ID** | 19vqYbaZ9sljtROSlVIZFnp5IaTGroyHT |
| **Drive Organization** | Year/Month subfolders (e.g., 2026/February/) |
| **Auth Type** | Google Service Account (Base64-encoded JSON key) |
| **N8n Credential Name** | Google Sheets account |
| **N8n Credential Type** | Google Service Account API |

### 3.5 GitHub Repository

| Property | Value |
|----------|-------|
| **Repository** | https://github.com/lnagesh-cnet/nursing-trips-processor |
| **Branch** | main |
| **Auto-Deploy** | Yes (Render watches main branch) |

---

## 4. Data Flow - End to End

### 4.1 New / Modified Trip Request (Full Pipeline)

```
Step  Action                                    Duration    Component
----  ----------------------------------------  ----------  -----------------
1     NYC DOH sends Cisco Secure Email          --          External
2     Email arrives in Outlook mailbox          --          Microsoft 365
3     N8n trigger polls, detects new email      ~1 min      N8n Trigger
4     Filter on Subject verifies STR pattern    <1ms        N8n Filter Node
5     Split Email List dedup check              <1ms        N8n Code Node
6     Log Email Details parses subject line     <1ms        N8n Code Node
      -> Extracts: requestType, confirmId,
         tripCode
7     Is Cancellation? routes to correct path   <1ms        N8n IF Node
8     Get Email Attachments via Graph API       1-3s        N8n HTTP Request
9     Find Securedoc Attachment                 <1ms        N8n Code Node
10    POST to Render processor                  30-120s     N8n -> Render
      /process {messageId, attachmentId}
11    Processor fetches HTML from Graph API     2-5s        Render (processor.js)
12    Processor writes HTML to temp disk        <1ms        Render (processor.js)
13    Puppeteer opens Cisco envelope in         10-30s      Render (browser-automation.js)
      headless Chromium, clicks "Open Online"
14    PDF link found, PDF downloaded            5-15s       Render (browser-automation.js)
15    pdf-parse extracts text from PDF          1-3s        Render (pdf-extractor.js)
16    Regex extracts all structured fields      <1ms        Render (pdf-extractor.js)
17    PDF uploaded to Google Drive              2-5s        Render (processor.js)
      (year/month subfolder, shared link)
18    JSON response returned to N8n             <1ms        Render -> N8n
19    Processing OK? checks success             <1ms        N8n IF Node
20    Log Trip Fields displays data             <1ms        N8n Code Node
21    Format Sheet Row builds single row        <1ms        N8n Code Node
      (students as comma-separated arrays)
22    Write to Google Sheets (append row)       1-2s        N8n Google Sheets
23    Mark Processed stores messageId           <1ms        N8n Code Node

TOTAL END-TO-END: ~45-180 seconds per email
```

### 4.2 Cancelled Trip Request (Fast Path)

```
Step  Action                                    Duration    Component
----  ----------------------------------------  ----------  -----------------
1-7   Same as above                             ~1 min      N8n
8     Format Cancelled Row                      <1ms        N8n Code Node
      -> Minimal row: confirmId, tripCode,
         requestType="Cancelled", emailReceived
9     Write to Google Sheets (append row)       1-2s        N8n Google Sheets
10    Mark Processed                            <1ms        N8n Code Node

TOTAL END-TO-END: ~1-2 seconds (no PDF processing)
```

### 4.3 Email Subject Format

| Type | Subject Pattern | Example |
|------|----------------|---------|
| **New** | `STR \| Confirm ID: XXXXXX \| TRIPCODE \| ...` | `STR \| Confirm ID: 309341 \| 22K315 \| ...` |
| **Modified** | `STR (Modified) \| Confirm ID: XXXXXX \| ...` | `STR (Modified) \| Confirm ID: 309341 \| 22K315 \| ...` |
| **Cancelled** | `STR (Cancelled) \| Confirm ID: XXXXXX \| ...` | `STR (Cancelled) \| Confirm ID: 317925 \| 20K170 \| ...` |

---

## 5. N8n Workflow - Node-by-Node

### Node 1: New Trip Email (Trigger)

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.microsoftOutlookTrigger |
| **Version** | 1 |
| **Credential** | Lavanya Microsoft Outlook account (microsoftOutlookOAuth2Api) |
| **Poll Interval** | Every 1 minute |
| **Trigger On** | Message Received |
| **Output** | Raw |
| **Read Status Filter** | Unread and read messages |
| **Custom Filter** | `contains(subject, 'Confirm ID') and startswith(subject, 'STR')` |
| **Internal State** | Tracks last-polled timestamp in workflow static data |

**Output schema:** Full Microsoft Graph message object including `id`, `subject`, `receivedDateTime`, `hasAttachments`, `body`, `from`, `toRecipients`.

### Node 2: Filter on Subject

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.filter |
| **Purpose** | Secondary subject validation (added by user) |
| **Condition** | Subject must match STR trip email pattern |

### Node 3: Split Email List (Dedup Safety Net)

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Prevents duplicate processing |
| **Mechanism** | Uses `$getWorkflowStaticData('global')` to maintain `processedIds` array |
| **State Management** | Stores up to 200 most recent message IDs |
| **Input** | Individual email items from trigger |
| **Output** | Only unprocessed emails (filtered) |

```javascript
// Core logic:
const staticData = $getWorkflowStaticData('global');
if (!staticData.processedIds) staticData.processedIds = [];
const items = $input.all();
const newItems = items.filter(item => !staticData.processedIds.includes(item.json.id));
if (newItems.length === 0) return [];
return newItems;
```

### Node 4: Log Email Details

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Parses request type, Confirm ID, and Trip Code from email subject |

**Regex patterns:**
- Request type: `/^STR\s*\(Modified\)/i` -> Modified, `/^STR\s*\(Cancell?ed\)/i` -> Cancelled, else -> New
- Confirm ID: `/Confirm\s*ID[:\s]+(\d+)/i`
- Trip Code: `/\|\s*([A-Z0-9]+(?:@[A-Z0-9]+)?)\s*\|/i`

**Output fields:** `messageId`, `subject`, `receivedDateTime`, `hasAttachments`, `requestType`, `confirmId`, `tripCode`

### Node 5: Is Cancellation?

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.if (v2) |
| **Condition** | `{{ $json.requestType }}` equals "Cancelled" (case-insensitive) |
| **TRUE path** | Format Cancelled Row (skip PDF processing) |
| **FALSE path** | Get Email Attachments (full pipeline) |

### Node 6: Format Cancelled Row (TRUE path)

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Builds minimal Google Sheets row for cancelled trips |
| **Fields populated** | confirmId, tripCode, requestType="Cancelled", emailReceived |
| **Fields empty** | All other 19 fields (dates, times, destination, students, etc.) |

### Node 7: Get Email Attachments (FALSE path)

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.httpRequest (v4.2) |
| **Auth** | Generic OAuth2 credential ("Microsoft") |
| **Method** | GET |
| **URL** | `https://graph.microsoft.com/v1.0/users/lnagesh@comprehensivenet.com/messages/{{ $json.messageId }}/attachments` |
| **Query** | `$select=id,name,contentType,size` |
| **Timeout** | 30 seconds |
| **Retry** | 2 attempts |

### Node 8: Find Securedoc Attachment

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Finds the Cisco Secure Email HTML attachment |
| **Logic** | Searches attachments array for filename containing "securedoc" (case-insensitive) |
| **If not found** | Returns empty array (skips remaining pipeline) |
| **Output** | `messageId`, `emailSubject`, `receivedDateTime`, `attachmentId`, `attachmentName`, `attachmentSize` |

### Node 9: Send to Render Processor

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.httpRequest (v4.2) |
| **Method** | POST |
| **URL** | https://nursing-trips-processor.onrender.com/process |
| **Body** | `{ "messageId": "...", "attachmentId": "...", "emailSubject": "..." }` |
| **Timeout** | 180 seconds (3 minutes) |
| **Retry** | 3 attempts with 10-second wait |
| **Content-Type** | application/json |

### Node 10: Processing OK?

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.if (v2) |
| **Condition** | `{{ $json.success }}` equals true (boolean) |
| **TRUE path** | Log Trip Fields -> Format Sheet Row |
| **FALSE path** | Processing Failed |

### Node 11: Log Trip Fields

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Displays extracted trip data for monitoring |
| **Output** | Flattened trip fields + `_fullResponse` passthrough |

### Node 12: Format Sheet Row

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Builds final Google Sheets row |
| **Student handling** | Multiple students concatenated as comma-separated values |
| **Request type source** | References `$('Log Email Details').first().json.requestType` |

### Node 13: Write to Google Sheets

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.googleSheets (v4.5) |
| **Operation** | Append |
| **Document** | By URL |
| **Sheet** | By URL |
| **Mapping** | Auto-map input data to column headers |
| **Credential** | Google Sheets account (Google Service Account API) |

**Column mapping (A-W):**

| Column | Header | Source | Example |
|--------|--------|--------|---------|
| A | confirmId | Email subject | 309341 |
| B | tripCode | Email subject / PDF | 22K315 |
| C | todaysDate | PDF | 02/23/2026 |
| D | overnightTrip | PDF | No |
| E | startDate | PDF | 02/25/2026 |
| F | endDate | PDF | 02/25/2026 |
| G | startTime | PDF | 8:30 AM |
| H | endTime | PDF | 1:30 PM |
| I | destination | PDF | New York Aquarium |
| J | schoolName | PDF | P.S. K315 |
| K | address | PDF | 2310 GLENWOOD ROAD |
| L | atsDbn | PDF | 22K315 |
| M | district | PDF | 22 |
| N | region | PDF | 6 |
| O | requester | PDF | Adeyinka Obajimi |
| P | phone1 | PDF | 718-421-9560 |
| Q | phone2 | PDF | 718-421-6161 |
| R | studentInitials | PDF (comma-sep) | BP, SD |
| S | studentId | PDF (comma-sep) | 2584910910, 256382854 |
| T | dob | PDF (comma-sep) | 06/01/2019, 01/12/2018 |
| U | medicalNeeds | PDF (comma-sep) | Meds: EMS Albuterol, ASTHMA |
| V | driveUrl | Google Drive | https://drive.google.com/file/d/... |
| W | requestType | Email subject | New / Modified / Cancelled |
| X | emailReceived | Email metadata | 2026-02-26T14:49:03Z |

### Node 14: Mark Processed

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Stores processed messageId to prevent re-processing |
| **Storage** | `$getWorkflowStaticData('global').processedIds` array |
| **Max IDs** | 200 (FIFO eviction) |

### Node 15: Processing Failed

| Property | Value |
|----------|-------|
| **Type** | n8n-nodes-base.code (v2) |
| **Purpose** | Logs error details when Render processor fails |
| **Behavior** | Email stays available for retry on next poll |

---

## 6. Render Processor Service

### 6.1 Service Architecture

```
Docker Container (node:20-slim + Chromium)
+-------------------------------------------------------+
|                                                       |
|  Express Server (port 10000)                          |
|  |                                                    |
|  +-- GET /          -> Health check                   |
|  |                                                    |
|  +-- POST /process  -> processSecureEmail()           |
|       |                                               |
|       +-- Step 1: Fetch HTML from MS Graph API        |
|       +-- Step 2: Write HTML to /tmp/                 |
|       +-- Step 3: Puppeteer -> Chromium               |
|       |     +-- Local HTTP server (random port)       |
|       |     +-- Load Cisco HTML                       |
|       |     +-- Click "Open Online"                   |
|       |     +-- Find PDF link (multi-strategy)        |
|       |     +-- Download PDF (validate %PDF- magic)   |
|       +-- Step 4: pdf-parse -> regex extraction       |
|       +-- Step 5: Parse email subject                 |
|       +-- Step 6: Upload PDF to Google Drive          |
|       +-- Step 7: Cleanup temp files                  |
|       +-- Return JSON response                        |
|                                                       |
+-------------------------------------------------------+
```

### 6.2 Source Files

| File | Size | Purpose |
|------|------|---------|
| `src/server.js` | 1.9 KB | Express HTTP server, routes |
| `src/processor.js` | 9.3 KB | Main orchestrator (7-step pipeline) |
| `src/browser-automation.js` | 17.3 KB | Puppeteer/Chromium automation |
| `src/pdf-extractor.js` | 8.8 KB | PDF text extraction + regex parsing |
| `src/html-parser.js` | 4.4 KB | Cisco envelope HTML parsing (Cheerio) |

### 6.3 Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4.18.2 | HTTP server |
| puppeteer-core | ^21.0.0 | Browser automation (uses system Chromium) |
| cheerio | ^1.0.0-rc.12 | HTML parsing for Cisco envelope |
| pdf-parse | ^1.1.1 | PDF text extraction |
| googleapis | ^171.4.0 | Google Drive API client |
| fs-extra | ^11.2.0 | File system utilities |

### 6.4 Docker Configuration

- **Base image:** node:20-slim (Debian)
- **System packages:** chromium + 15 shared library dependencies (X11, NSS, ATK, ALSA, etc.)
- **Chromium path:** /usr/bin/chromium
- **User:** Non-root `appuser` (security hardening)
- **Port:** 10000 (Render convention)
- **Crash dumps:** /tmp/crashes

### 6.5 API Specification

**POST /process**

Request:
```json
{
  "messageId": "AAMkAGI2...",
  "attachmentId": "AAMkAGI2...attachmentId...",
  "emailSubject": "STR | Confirm ID: 309341 | 22K315 | ..."
}
```

Response (success):
```json
{
  "success": true,
  "elapsed": "45.2s",
  "tripFields": {
    "confirmId": "309341",
    "tripCode": "22K315",
    "todaysDate": "02/23/2026",
    "overnightTrip": "No",
    "startDate": "02/25/2026",
    "endDate": "02/25/2026",
    "startTime": "8:30 AM",
    "endTime": "1:30 PM",
    "destination": "New York Aquarium",
    "schoolName": "P.S. K315",
    "address": "2310 GLENWOOD ROAD",
    "atsDbn": "22K315",
    "district": "22",
    "region": "6",
    "requester": "Adeyinka Obajimi",
    "phone1": "718-421-9560",
    "phone2": "718-421-6161"
  },
  "students": [
    { "initials": "BP", "studentId": "2584910910", "dob": "06/01/2019", "medicalNeeds": "Meds: EMS Albuterol" }
  ],
  "driveUrl": "https://drive.google.com/file/d/...",
  "pdfFilename": "309341_22K315_20260225.pdf"
}
```

Response (error):
```json
{
  "success": false,
  "error": "No securedoc attachment found",
  "elapsed": "2.1s"
}
```

---

## 7. Microsoft Azure AD Configuration

### 7.1 App Registrations

**App 1: n8n Email Parser - Comprehensive** (used by N8n Outlook Trigger)

| Property | Value |
|----------|-------|
| Client ID | a66e0bc0-d73f-4b3c-89a0-7ae7042ce1e6 |
| Created | February 5, 2026 |
| Redirect URI | https://n8n-lto2.onrender.com/rest/oauth2-credential/callback |
| API Permissions | Mail.Read (delegated) |
| Secret Expiry | Check Azure portal |

**App 2: N8n Email Automation** (used by Render processor + N8n HTTP Request nodes)

| Property | Value |
|----------|-------|
| Client ID | c37e3adc-2f69-4656-9c1b-a9bb73abc714 |
| Created | February 17, 2026 |
| API Permissions | Mail.Read, Mail.ReadWrite (application) |
| Auth Flow | Client credentials (no user interaction) |
| Secret Expiry | Check Azure portal |

### 7.2 Microsoft Graph API Endpoints Used

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `GET /v1.0/users/{email}/messages` | N8n Trigger (internal) | Poll for new emails |
| `GET /v1.0/users/{email}/messages/{id}/attachments` | N8n HTTP Request | List email attachments |
| `GET /v1.0/users/{email}/messages/{id}/attachments/{id}/$value` | Render Processor | Download attachment binary |

### 7.3 OAuth2 URLs

| URL | Value |
|-----|-------|
| Authorization | https://login.microsoftonline.com/2d090015-90ea-4cce-92f0-1581080b0fc2/oauth2/v2.0/authorize |
| Token | https://login.microsoftonline.com/2d090015-90ea-4cce-92f0-1581080b0fc2/oauth2/v2.0/token |
| Redirect | https://n8n-lto2.onrender.com/rest/oauth2-credential/callback |

---

## 8. Google Cloud Configuration

### 8.1 Google Sheets

| Property | Value |
|----------|-------|
| Spreadsheet | N8N_Nursing_Trips |
| ID | 1ukXEeNhbNYOHERWV2NroELaR4jwQJoYL0900__m4ur0 |
| Tab | Trip_Details (gid: 1623775001) |
| Auth | Google Service Account |
| Write Mode | Append (never updates existing rows) |
| Column Mapping | Auto-map by header name (columns A-X) |

### 8.2 Google Drive

| Property | Value |
|----------|-------|
| Parent Folder | Nursing Trip PDFs |
| Folder ID | 19vqYbaZ9sljtROSlVIZFnp5IaTGroyHT |
| Subfolder Structure | `{Year}/{Month}/` (e.g., `2026/February/`) |
| File Naming | `{confirmId}_{tripCode}_{tripDate}.pdf` |
| Sharing | Anyone with link can view |
| Auth | Same service account as Sheets |

### 8.3 Service Account

- Credentials stored as Base64-encoded JSON in `GOOGLE_CREDENTIALS_BASE64` environment variable
- Must have Editor access to the Google Sheet
- Must have Writer access to the Google Drive folder

---

## 9. Environment Variables & Secrets

### 9.1 Render Processor Service

| Variable | Value / Location | Sensitive |
|----------|-----------------|-----------|
| `PORT` | 10000 | No |
| `PUPPETEER_EXECUTABLE_PATH` | /usr/bin/chromium | No |
| `HEADLESS` | true | No |
| `GOOGLE_CREDENTIALS_BASE64` | Render dashboard | **Yes** |
| `DRIVE_FOLDER_ID` | 19vqYbaZ9sljtROSlVIZFnp5IaTGroyHT | No |
| `MS_TENANT_ID` | Render dashboard | **Yes** |
| `MS_CLIENT_ID` | Render dashboard | **Yes** |
| `MS_CLIENT_SECRET` | Render dashboard | **Yes** |
| `MS_USER_EMAIL` | lnagesh@comprehensivenet.com | No |

### 9.2 N8n Instance

Credentials are managed through N8n's built-in credential manager (encrypted at rest).

| Credential Name | Type | Used By |
|----------------|------|---------|
| Lavanya Microsoft Outlook account | Microsoft Outlook OAuth2 API | New Trip Email trigger |
| Microsoft | OAuth2 API (generic) | Get Email Attachments node |
| Google Sheets account | Google Service Account API | Write to Google Sheets node |

---

## 10. Network & Connectivity

### 10.1 Outbound Connections from N8n

| Destination | Protocol | Port | Purpose |
|-------------|----------|------|---------|
| login.microsoftonline.com | HTTPS | 443 | OAuth2 token exchange |
| graph.microsoft.com | HTTPS | 443 | Email polling + attachment fetch |
| nursing-trips-processor.onrender.com | HTTPS | 443 | Processor API calls |
| sheets.googleapis.com | HTTPS | 443 | Google Sheets writes |

### 10.2 Outbound Connections from Processor

| Destination | Protocol | Port | Purpose |
|-------------|----------|------|---------|
| login.microsoftonline.com | HTTPS | 443 | OAuth2 token (client credentials) |
| graph.microsoft.com | HTTPS | 443 | Attachment binary download |
| res.cisco.com | HTTPS | 443 | Cisco Secure Email decryption |
| www.googleapis.com | HTTPS | 443 | Google Drive upload |

### 10.3 Inbound Connections

| Service | Source | Port | Auth |
|---------|--------|------|------|
| Render Processor | N8n (Render internal) | 10000 | None (same Render network) |
| N8n | Browser (users) | 443 | N8n login |

---

## 11. Security & HIPAA Compliance

### 11.1 Data Handling

| Principle | Implementation |
|-----------|---------------|
| **Data at rest** | No PHI stored on disk permanently. Temp files deleted after processing. Google Drive has org-level encryption. |
| **Data in transit** | All connections use TLS 1.2+ (HTTPS). No plaintext HTTP. |
| **PHI exposure** | Student initials only (not full names). Student IDs, DOBs handled. No SSNs. |
| **Processing locality** | All PDF extraction happens server-side (Render). No data sent to external AI/ML services. |
| **Access control** | Google Sheet shared with coordinators only. Drive folder restricted. |
| **Credential storage** | Secrets in Render environment variables (encrypted). N8n credentials encrypted at rest. |

### 11.2 Container Security

- Non-root user (`appuser`) inside Docker container
- Minimal base image (node:20-slim)
- No development dependencies in production (`npm install --omit=dev`)
- Chromium sandboxed (though `--no-sandbox` flag used due to container constraints)

### 11.3 Secret Rotation Schedule

| Secret | Location | Rotation |
|--------|----------|----------|
| Azure App Client Secrets | Azure Portal + Render | Before expiry (check Azure) |
| N8n Outlook OAuth2 token | N8n credential store | Auto-refreshes via refresh token |
| Google Service Account Key | Render env var | As needed (no expiry by default) |

---

## 12. Deployment Procedures

### 12.1 Code Deployment (Processor)

```bash
# 1. Make changes locally
cd C:\Users\lavanya\Projects\nursing-trips-processor

# 2. Test locally (optional)
npm run dev

# 3. Commit and push
git add <files>
git commit -m "Description of changes"
git push origin main

# 4. Render auto-deploys from main branch
# Monitor: https://dashboard.render.com
```

### 12.2 N8n Workflow Deployment

```
1. Edit n8n-workflow.json locally
2. Open N8n: https://n8n-lto2.onrender.com/workflow/MxEZiPG2HiOO6Vp3
3. Three-dot menu (top right) -> Import from file...
4. Select n8n-workflow.json
5. Verify all nodes render correctly
6. Re-configure credentials if needed (Import may reset them):
   - New Trip Email -> Lavanya Microsoft Outlook account
   - Get Email Attachments -> Microsoft (OAuth2)
   - Write to Google Sheets -> Google Sheets account
7. Ctrl+S to save
8. Click "Publish" to make active
```

### 12.3 Rollback

- **Processor:** Revert commit on GitHub, Render auto-deploys previous version
- **N8n Workflow:** Import the previous version of `n8n-workflow.json` from git history

---

## 13. Monitoring & Alerting

### 13.1 Health Checks

| Service | Endpoint | Expected | Frequency |
|---------|----------|----------|-----------|
| Processor | GET https://nursing-trips-processor.onrender.com/ | `{"status":"ok"}` | Render (automatic) |
| N8n | https://n8n-lto2.onrender.com | Login page loads | Render (automatic) |

### 13.2 Execution Monitoring

- **N8n Executions tab:** https://n8n-lto2.onrender.com/workflow/MxEZiPG2HiOO6Vp3/executions
- **Success indicator:** Executions completing in 1-180 seconds
- **Failure indicator:** Executions with red status or Processing Failed node
- **Empty poll indicator:** Executions completing in <10ms (no new emails)

### 13.3 Key Metrics

| Metric | Normal Range | Alert If |
|--------|-------------|----------|
| Execution time (full pipeline) | 30-120s | >180s |
| Execution time (cancellation) | 1-3s | >10s |
| Failed executions per day | 0-2 | >5 |
| Emails processed per day | 10-25 | 0 for >2 hours during business hours |
| Render cold start | 30-60s | >120s |

---

## 14. Troubleshooting Runbook

### Issue: "Client authentication failed"
**Cause:** Azure AD app client secret expired or wrong
**Fix:**
1. Azure Portal -> App registrations -> [app name] -> Certificates & secrets
2. Create new client secret (copy the **Value**, not the Secret ID)
3. Update in Render dashboard (for processor) or N8n credential (for trigger)

### Issue: "Sheet with name X not found"
**Cause:** Sheet tab name case sensitivity mismatch
**Fix:** In N8n, open Write to Google Sheets node, switch to "By URL" mode for both Document and Sheet

### Issue: "Problem importing workflow - Unauthorized"
**Cause:** N8n session expired
**Fix:** Refresh N8n page, re-login, then import again

### Issue: Render processor timeout (180s)
**Cause:** Cisco decryption site slow, Chromium crash, or Render cold start
**Fix:** Automatic retry (3 attempts). If persistent, check Render logs for Chromium errors.

### Issue: "No securedoc attachment found"
**Cause:** Email has no Cisco secure attachment (different email format)
**Fix:** Expected for non-trip emails that match subject filter. Pipeline skips gracefully.

### Issue: Duplicate rows in Google Sheet
**Cause:** Dedup state cleared (workflow reimport) or race condition during testing
**Fix:** Delete duplicate rows. The dedup list rebuilds automatically as emails are processed.

### Issue: Trigger not picking up emails
**Cause:** OAuth token expired, or trigger polling state stuck
**Fix:**
1. Open trigger node -> click "Reconnect" on credential
2. If still stuck: Deactivate workflow -> Reactivate (resets polling state)

### Issue: Forwarded emails filtered out
**Cause:** "FW:" prefix in subject breaks "starts with STR" filter
**Fix:** Update Filter on Subject node to use "contains" instead of "starts with"

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Feb 10, 2026 | Initial deployment to Google Cloud Run. N8n hourly schedule + HTTP Request for email fetch. |
| 2.0 | Feb 17, 2026 | Migrated from Cloud Run to Render. Switched from Document AI to pdf-parse for field extraction. Added Google Drive upload. |
| 3.0 | Feb 24, 2026 | Added email deduplication (workflow static data). Added Split Email List and Mark Processed nodes. |
| 4.0 | Feb 25, 2026 | Added modification/cancellation handling. Is Cancellation? branching. Format Cancelled Row node. Request type parsing. |
| 5.0 | Feb 26, 2026 | Replaced Schedule Trigger + HTTP Request with Microsoft Outlook Trigger (1-min polling). Removed 4 nodes (Hourly Schedule, Fetch Unread Trip Emails, Any New Emails?, No New Emails). Changed read status to "Both" for read+unread capture. |

---

## Appendix A: Google Sheet Column Index

| Col | Letter | Header | Max Width |
|-----|--------|--------|-----------|
| 1 | A | confirmId | 10 |
| 2 | B | tripCode | 10 |
| 3 | C | todaysDate | 12 |
| 4 | D | overnightTrip | 5 |
| 5 | E | startDate | 12 |
| 6 | F | endDate | 12 |
| 7 | G | startTime | 10 |
| 8 | H | endTime | 10 |
| 9 | I | destination | 40 |
| 10 | J | schoolName | 30 |
| 11 | K | address | 40 |
| 12 | L | atsDbn | 10 |
| 13 | M | district | 5 |
| 14 | N | region | 5 |
| 15 | O | requester | 30 |
| 16 | P | phone1 | 15 |
| 17 | Q | phone2 | 15 |
| 18 | R | studentInitials | 20 |
| 19 | S | studentId | 40 |
| 20 | T | dob | 30 |
| 21 | U | medicalNeeds | 60 |
| 22 | V | driveUrl | 80 |
| 23 | W | requestType | 12 |
| 24 | X | emailReceived | 25 |

---

## Appendix B: Credential Dependency Map

```
New Trip Email (trigger)
  └── Lavanya Microsoft Outlook account [microsoftOutlookOAuth2Api]
        └── Azure App: n8n Email Parser - Comprehensive (a66e0bc0...)

Get Email Attachments (HTTP Request)
  └── Microsoft [oAuth2Api - generic]
        └── Azure App: N8n Email Automation (c37e3adc...)

Send to Render Processor (HTTP Request)
  └── No auth (public endpoint, same Render network)

Render Processor (internal)
  └── MS Graph API: Client credentials flow
        └── Azure App: N8n Email Automation (c37e3adc...)
              └── Env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
  └── Google Drive API: Service account
        └── Env var: GOOGLE_CREDENTIALS_BASE64

Write to Google Sheets
  └── Google Sheets account [googleServiceAccountApi]
```

---

*End of document.*
