import * as cheerio from 'cheerio';
import fs from 'fs-extra';

/**
 * Parse HTML file to extract form data and metadata
 * @param {string} htmlFilePath - Path to the HTML file
 * @returns {Object} Parsed data including form action, form data, button selectors, and metadata
 */
export async function parseHtmlFile(htmlFilePath) {
  const htmlContent = await fs.readFile(htmlFilePath, 'utf-8');
  const $ = cheerio.load(htmlContent);

  // Extract form action URL
  const formAction = $('form').attr('action') || 
    'https://res.cisco.com:443/envelopeopener/decrypt_envelope.jsp';
  const formMethod = $('form').attr('method') || 'GET';

  // Extract all form inputs
  const formData = {};
  $('form input').each((_, element) => {
    const name = $(element).attr('name');
    const value = $(element).attr('value') || '';
    const type = $(element).attr('type');
    
    if (name && type !== 'submit' && type !== 'button') {
      formData[name] = value;
    }
  });

  // Identify button selectors - prioritize the "Open Online" button
  const buttonSelectors = [];
  
  // First, look for the specific "Open Online" button (highest priority)
  // The ID contains dots, so we need to escape them in CSS selector
  const openOnlineButton = $('input[id*="openonline"], input[id="text_i18n.authframe.safr.button.openonline"]');
  if (openOnlineButton.length > 0) {
    const buttonId = openOnlineButton.attr('id');
    const onclick = openOnlineButton.attr('onclick');
    // For IDs with special characters, use attribute selector
    const selector = buttonId ? `input[id="${buttonId}"]` : 'input[id*="openonline"]';
    buttonSelectors.push({
      selector: selector,
      onclick: onclick,
      priority: 1
    });
  }
  
  // Then look for other buttons
  $('form input[type="submit"], form input[type="button"], form button').each((_, element) => {
    const id = $(element).attr('id');
    const name = $(element).attr('name');
    const className = $(element).attr('class');
    const onclick = $(element).attr('onclick');
    
    if (id && !id.includes('openonline')) {
      buttonSelectors.push({
        selector: `#${id}`,
        onclick: onclick,
        priority: 2
      });
    }
    if (name && name !== 'cresLoginButton') {
      buttonSelectors.push({
        selector: `input[name="${name}"]`,
        onclick: onclick,
        priority: 3
      });
    }
  });

  // Common button IDs to look for
  const commonButtons = ['cresLoginButton', 'submitButton', 'continueButton', 'buttonSubmit'];
  commonButtons.forEach(btnId => {
    if ($(`#${btnId}`).length > 0) {
      buttonSelectors.push({
        selector: `#${btnId}`,
        onclick: null,
        priority: 4
      });
    }
  });
  
  // Sort by priority
  buttonSelectors.sort((a, b) => a.priority - b.priority);

  // Extract metadata from title
  const title = $('title').text();
  const metadata = parseTitleMetadata(title);

  // Convert button selectors to a consistent format
  const normalizedButtonSelectors = buttonSelectors.map(btn => {
    if (typeof btn === 'string') {
      return { selector: btn, onclick: null, priority: 5 };
    }
    return btn;
  });

  return {
    formAction,
    formMethod,
    formData,
    buttonSelectors: normalizedButtonSelectors,
    metadata,
    title
  };
}

/**
 * Parse metadata from title string
 * Format: "Secure Registered Envelope:STR | Confirm ID: 000000 | X000@00X000 | TripDate: 01/15/2025 | To: Example Vendor, Inc. | Overnight=No"
 */
function parseTitleMetadata(title) {
  const metadata = {};
  
  if (!title) return metadata;

  // Extract Confirm ID
  const confirmIdMatch = title.match(/Confirm ID:\s*(\d+)/i);
  if (confirmIdMatch) {
    metadata.confirmId = confirmIdMatch[1];
  }

  // Extract Trip Date
  const tripDateMatch = title.match(/TripDate:\s*([^|]+)/i);
  if (tripDateMatch) {
    metadata.tripDate = tripDateMatch[1].trim();
  }

  // Extract other identifiers
  const identifierMatch = title.match(/([A-Z]\d+@\d+[A-Z]\d+)/);
  if (identifierMatch) {
    metadata.identifier = identifierMatch[1];
  }

  // Extract "To" field
  const toMatch = title.match(/To:\s*([^|]+)/i);
  if (toMatch) {
    metadata.to = toMatch[1].trim();
  }

  // Extract Overnight
  const overnightMatch = title.match(/Overnight=(\w+)/i);
  if (overnightMatch) {
    metadata.overnight = overnightMatch[1];
  }

  return metadata;
}
