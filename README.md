# Nursing Trips Processor

Dockerized Node.js service that processes NYC DOH nursing trip requests from Cisco Secure Email. Deployed on **Render**.

## What It Does

1. Receives an email message ID from N8n (workflow orchestrator)
2. Fetches the Cisco-encrypted HTML attachment via Microsoft Graph API
3. Decrypts the HTML envelope using Puppeteer + Chromium to extract the PDF
4. Parses the "Appendix F — Request for Trip Coverage" PDF using `pdf-parse` + regex
5. Uploads the PDF to Google Drive
6. Returns structured trip and student data to N8n for Google Sheets

## Architecture

```
N8n (orchestrator, hourly 9AM-5PM Mon-Fri)
  → Render (this service)
      ├── Microsoft Graph API → fetch encrypted email attachment
      ├── Puppeteer/Chromium → decrypt Cisco Secure Email → PDF
      ├── pdf-parse + regex → extract trip fields + student table
      └── Google Drive API → upload PDF
  → Google Sheets (N8n writes extracted data)
```

## Data Flow

```
Email (lnagesh@comprehensivenet.com)
  → Graph API fetch attachment
  → Cisco HTML decryption (Puppeteer)
  → PDF download
  → Field extraction (pdf-parse + regex)
  → Drive upload + return data to N8n
  → N8n writes to Google Sheets
```

## Extracted Fields

| Field | Source |
|---|---|
| Confirm ID, Trip Code | Email subject |
| Start/End Date, Start/End Time | PDF |
| Destination, School Name, Address | PDF |
| AtsDbn, District, Region | PDF |
| Person Requesting, Phone 1/2 | PDF |
| Student Initials, ID, DOB, Medical Needs | PDF student table |

## Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_CREDENTIALS_BASE64` | Base64-encoded Google service account JSON |
| `DRIVE_FOLDER_ID` | Google Drive folder ID for PDF uploads |
| `MS_TENANT_ID` | Azure AD tenant ID |
| `MS_CLIENT_ID` | Azure app registration client ID |
| `MS_CLIENT_SECRET` | Azure app client secret |
| `MS_USER_EMAIL` | Mailbox to read (`lnagesh@comprehensivenet.com`) |
| `PORT` | Server port (default: 10000) |

## Local Development

```bash
npm install
node src/server.js
```

Note: Puppeteer requires Chromium. Locally it looks for the system Chrome; in Docker it uses `/usr/bin/chromium`.

## Deploy to Render

This repo includes a `render.yaml` blueprint and `Dockerfile`. Connect the repo to Render as a Docker web service and set the env vars above in the Render dashboard.

## API

### `GET /`
Health check. Returns `{"status": "ok", "service": "nursing-trips-processor"}`.

### `POST /process`
Process a nursing trip email.

**Request body:**
```json
{
  "messageId": "AAMk...",
  "attachmentId": "AAMk...",
  "emailSubject": "STR | Confirm ID: 316126 | 20K104A | ..."
}
```

**Response:**
```json
{
  "success": true,
  "driveUrl": "https://drive.google.com/file/d/.../view",
  "pdfFilename": "20K104A_316126.pdf",
  "tripFields": { "confirmId": "316126", "startDate": "02/23/2026", ... },
  "students": [{ "initials": "SD", "studentId": "256382854", "dob": "01/12/2018", "medicalNeeds": "ASTHMA" }]
}
```
