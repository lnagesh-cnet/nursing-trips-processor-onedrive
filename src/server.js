import express from 'express';
import { processSecureEmail } from './processor.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Parse JSON bodies up to 50MB (HTML attachment can be large)
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nursing-trips-processor' });
});

/**
 * Main endpoint called by N8N
 * 
 * N8N sends:
 * {
 *   "htmlContent": "<full securedoc HTML string>",
 *   "filename": "securedoc_20260209T103019.html",
 *   "emailSubject": "STR | Confirm ID: 316126 | 20K104A | TripDate: 2/23/2026 | ..."
 * }
 * 
 * Returns:
 * {
 *   "success": true,
 *   "driveUrl": "https://drive.google.com/file/d/.../view",
 *   "pdfFilename": "20K748_314033.pdf",
 *   "tripFields": { confirmId, startDate, endDate, ... },
 *   "students": [{ initials, studentId, dob, medicalNeeds }]
 * }
 */
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  console.log('[SERVER] Received /process request');

  const { htmlContent, filename, emailSubject } = req.body;

  if (!htmlContent) {
    return res.status(400).json({ success: false, error: 'Missing htmlContent in request body' });
  }

  try {
    const result = await processSecureEmail({ htmlContent, filename, emailSubject });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SERVER] Done in ${elapsed}s`);
    res.json({ success: true, elapsed: `${elapsed}s`, ...result });
  } catch (error) {
    console.error('[SERVER] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    });
  }
});

app.listen(PORT, () => {
  console.log(`[SERVER] Nursing Trips Processor running on port ${PORT}`);
  console.log(`[SERVER] PDF extraction: pdf-parse + regex (on-server, no cloud AI)`);
  console.log(`[SERVER] Google Drive: ${process.env.DRIVE_FOLDER_ID || process.env.GOOGLE_CREDENTIALS_BASE64 ? 'configured' : 'NOT SET'}`);
});
