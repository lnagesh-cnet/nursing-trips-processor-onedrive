/**
 * pdf-extractor.js
 *
 * Shared field extraction utilities for the NYC DOH
 * "Appendix F - Request for Trip Coverage" PDF.
 *
 * Primary extraction is done by Azure Document Intelligence (processor.js).
 * This module provides regex-based text parsing as a shared utility and fallback.
 *
 * BUSINESS CONTEXT:
 * NYC DOH sends nursing trip requests to compres@comprehensivenet.com
 * Each email has a Cisco-encrypted HTML attachment. After Puppeteer
 * decrypts it, we get the "Appendix F" PDF with trip and student data.
 * That data goes into the Trip Requests Google Sheet for coordinators.
 *
 * 8 PRIMARY FIELDS (from business requirements doc):
 *   1. Confirm ID         ← email subject
 *   2. Trip Code (AtsDbn) ← PDF
 *   3. Student info       ← PDF student table
 *   4. Trip Date Range    ← PDF Start Date / End Date
 *   5. Start Time         ← PDF
 *   6. End Time           ← PDF
 *   7. Destination        ← PDF
 *   8. School + Address   ← PDF
 */

/**
 * Build the final fields object from extracted text + entity map
 */
export function buildFieldsObject(text, kvMap, titleMetadata, emailSubject, method) {
  const fields = {};

  // ── From email subject (ground truth for these fields) ─────────────────
  fields.confirmId      = titleMetadata.confirmId  
                        || pick(emailSubject, /Confirm\s*ID[:\s]+(\d+)/i);
  fields.caseIdentifier = titleMetadata.identifier 
                        || pick(emailSubject, /\|\s*([A-Z0-9]+(?:@[A-Z0-9]+)?)\s*\|/i);
  fields.vendorName     = titleMetadata.to         
                        || pick(emailSubject, /To:\s*([^|]+)/i);
  fields.overnight      = titleMetadata.overnight  
                        || pick(emailSubject, /Overnight=(\w+)/i)
                        || kvMap['overnight_trip'] 
                        || pick(text, /Overnight\s*Trip[:\s]+(\w+)/i);

  // ── Dates & Times ────────────────────────────────────────────────────────
  fields.todaysDate = kv(kvMap, ['today_s_date','todays_date','today']) 
                    || pick(text, /Today[''']?s\s*Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);

  fields.startDate  = kv(kvMap, ['start_date'])
                    || pick(text, /Start\s*Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);

  fields.endDate    = kv(kvMap, ['end_date'])
                    || pick(text, /End\s*Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);

  fields.startTime  = kv(kvMap, ['start_time'])
                    || pick(text, /Start\s*Time[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);

  fields.endTime    = kv(kvMap, ['end_time'])
                    || pick(text, /End\s*Time[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);

  // ── Location ─────────────────────────────────────────────────────────────
  fields.destination = kv(kvMap, ['destination_of_trip','destination'])
                     || pick(text, /Destination\s*of\s*Trip[:\s]+(.+)/i);

  fields.schoolName  = kv(kvMap, ['school_name'])
                     || pick(text, /School\s*Name[:\s]+(.+)/i);

  fields.address     = kv(kvMap, ['address'])
                     || pick(text, /Address[:\s]+(.+)/i);

  // AtsDbn = the trip code, used by coordinators to identify the assignment
  fields.atsDbn      = kv(kvMap, ['atsdbn','ats_dbn'])
                     || pick(text, /AtsDbn[:\s]+(\S+)/i);

  fields.district    = kv(kvMap, ['district'])
                     || pick(text, /District[:\s]+(\d+)/i);

  fields.region      = kv(kvMap, ['region'])
                     || pick(text, /Region[:\s]+(\d+)/i);

  // ── Contact ───────────────────────────────────────────────────────────────
  fields.personRequesting = kv(kvMap, ['person_requesting_trip','person_requesting'])
                          || pick(text, /Person\s*Requesting\s*(?:Trip)?[:\s]+(.+)/i);

  fields.phone1    = kv(kvMap, ['phone_1','phone1'])
                   || pick(text, /Phone\s*1[:\s]+([\d\-\(\)\s]+)/i);

  fields.phone2    = kv(kvMap, ['phone_2','phone2'])
                   || pick(text, /Phone\s*2[:\s]+([\d\-\(\)\s]*)/i);

  fields.comments  = kv(kvMap, ['comments'])
                   || pick(text, /Comments[:\s]*\n(.+)/i) || '';

  // ── Students ──────────────────────────────────────────────────────────────
  // HIPAA: student IDs/initials used internally only; medical needs NEVER logged
  fields.students = parseStudentTable(text);
  fields.studentCount = fields.students.length;

  // Flatten for Google Sheet direct column mapping
  for (let i = 0; i < 3; i++) {
    const n = i + 1;
    const s = fields.students[i] || {};
    fields[`student${n}Initials`]  = s.initials     || '';
    fields[`student${n}Id`]        = s.studentId    || '';
    fields[`student${n}Dob`]       = s.dob          || '';
    fields[`student${n}MedNeeds`]  = s.medicalNeeds || '';
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const key of Object.keys(fields)) {
    if (typeof fields[key] === 'string') {
      fields[key] = fields[key].trim().replace(/\s+/g, ' ');
    }
    if (fields[key] == null) fields[key] = '';
  }

  // Metadata — safe to log, no PHI
  fields._processedAt      = new Date().toISOString();
  fields._rawTextLength    = text.length;
  fields._extractionMethod = method;

  // Log field completion summary (no values, just presence)
  const coreFields = ['confirmId','atsDbn','startDate','endDate','startTime',
                      'endTime','destination','schoolName','address','studentCount'];
  const filled = coreFields.filter(f => fields[f]).length;
  console.log(`[DOCAI] Core fields filled: ${filled}/${coreFields.length} (method: ${method})`);

  return fields;
}

/**
 * Parse student table rows from raw text
 * 
 * CONFIRMED FORMAT (real PDF, Feb 10 2026):
 * Header: Initials | Student-Id | Date of Birth | Medical Needs
 * Row:    SD         256382854    01/12/2018       ASTHMA
 */
export function parseStudentTable(text) {
  const students = [];
  if (!text) return students;

  const tableStart = text.search(/Initials\s+Student[\-\s]?Id\s+Date\s+of\s+Birth/i);
  if (tableStart === -1) {
    console.log('[DOCAI] Student table header not found in text');
    return students;
  }

  const lines = text.slice(tableStart).split('\n').map(l => l.trim()).filter(Boolean);

  // Find where data rows start (after header)
  let dataStart = 1;
  for (let i = 0; i < lines.length; i++) {
    if (/Initials/i.test(lines[i])) { dataStart = i + 1; break; }
  }

  // Pattern: 2 caps, 6-12 digit ID, MM/DD/YYYY, remaining text = medical needs
  const ROW = /^([A-Z]{2})\s+(\d{6,12})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)/;

  for (let i = dataStart; i < Math.min(dataStart + 15, lines.length); i++) {
    const m = lines[i].match(ROW);
    if (m) {
      students.push({
        initials:     m[1].trim(),
        studentId:    m[2].trim(),
        dob:          m[3].trim(),
        medicalNeeds: m[4].trim()
      });
    }
    if (/^(Certification|Signature|©|Page \d)/i.test(lines[i])) break;
  }

  console.log(`[DOCAI] Parsed ${students.length} student row(s)`);
  return students;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Try multiple keys on a Document AI entity map */
function kv(map, keys) {
  for (const k of keys) { if (map[k]) return map[k]; }
  return '';
}

/** Single regex extract from text */
function pick(text, pattern) {
  if (!text) return '';
  const m = text.match(pattern);
  if (!m || !m[1]) return '';
  return m[1].split('\n')[0].trim();
}
