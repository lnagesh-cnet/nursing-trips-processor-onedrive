import express from 'express';
import { processSecureEmail, appendToSharePointExcel } from './processor.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Parse JSON bodies up to 50MB (HTML attachment can be large)
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nursing-trips-processor-onedrive' });
});

/**
 * Main endpoint called by N8N
 *
 * Accepts EITHER:
 *   { "htmlContent": "...", "filename": "...", "emailSubject": "..." }
 * OR:
 *   { "messageId": "...", "attachmentId": "...", "emailSubject": "..." }
 *   (processor fetches the attachment from Graph API using env vars)
 */
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  console.log('[SERVER] Received /process request');

  const { htmlContent, htmlBase64, messageId, attachmentId, filename, emailSubject } = req.body;

  if (!htmlContent && !htmlBase64 && !(messageId && attachmentId)) {
    return res.status(400).json({ success: false, error: 'Provide htmlContent OR messageId+attachmentId' });
  }

  try {
    const result = await processSecureEmail({ htmlContent, htmlBase64, messageId, attachmentId, filename, emailSubject });
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

/**
 * Append a row to the SharePoint Excel backup workbook.
 * Called by N8n after formatting the full row (same data as Google Sheets).
 *
 * Request body: the full row object with all 28 columns.
 */
app.post('/append-row', async (req, res) => {
  const startTime = Date.now();
  console.log('[SERVER] Received /append-row request');

  const rowData = req.body;
  if (!rowData || typeof rowData !== 'object') {
    return res.status(400).json({ success: false, error: 'Request body must be a JSON object with row data' });
  }

  try {
    await appendToSharePointExcel(rowData);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SERVER] Excel append done in ${elapsed}s`);
    res.json({ success: true, elapsed: `${elapsed}s` });
  } catch (error) {
    console.error('[SERVER] Excel append error:', error.message);
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
  console.log(`[SERVER] SharePoint: ${process.env.SP_DRIVE_ID ? 'configured' : 'NOT SET'}`);
});
