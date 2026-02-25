import puppeteer from 'puppeteer-core';
import fs from 'fs-extra';
import path from 'path';
import http from 'http';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Create a simple HTTP server to serve a directory
 * This is needed because file:// URLs block external scripts due to CORS
 * @param {string} directory - Directory to serve
 * @returns {Promise<{server: http.Server, port: number}>}
 */
async function createLocalServer(directory) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Parse the URL and get the file path
      const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(directory, urlPath);
      
      // Check if file exists
      fs.pathExists(filePath).then(exists => {
        if (!exists) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        
        // Determine content type
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
          '.html': 'text/html; charset=utf-8',
          '.htm': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        
        // Read and serve the file
        fs.readFile(filePath).then(content => {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        });
      });
    });
    
    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log('Local server started');
      resolve({ server, port });
    });
    
    server.on('error', reject);
  });
}

/**
 * Automate browser to download PDF from Cisco secure platform
 * @param {Object} formInfo - Form information from HTML parser
 * @param {string} formInfo.formAction - Form action URL
 * @param {string} formInfo.formMethod - Form method (GET or POST)
 * @param {Object} formInfo.formData - Form data object
 * @param {string[]} formInfo.buttonSelectors - Array of button selectors to try
 * @param {string} htmlFilePath - Optional path to HTML file to load directly
 * @returns {Promise<string>} Path to downloaded PDF file
 */
export async function downloadPdfFromForm(formInfo, htmlFilePath = null, downloadDir = null) {
  // Allow headless to be disabled for debugging
  const headless = process.env.HEADLESS !== 'false';
  
  // Find Chrome/Chromium executable
  // Cloud Run: /usr/bin/chromium (set via PUPPETEER_EXECUTABLE_PATH)
  // Mac: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=Crashpad',
      '--disable-breakpad',
      '--crash-dumps-dir=/tmp/crashes',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  
  console.log('Browser launched');

  // Track local server for cleanup
  let localServer = null;

  try {
    const page = await browser.newPage();
    
    // Use provided downloadDir (tmpDir from processor.js) or fall back to os.tmpdir()
    // IMPORTANT: Cloud Run filesystem is read-only except /tmp
    // Never use __dirname here — it points to the read-only app directory
    if (!downloadDir) {
      downloadDir = path.join(os.tmpdir(), `pdf-download-${Date.now()}`);
    }
    await fs.ensureDir(downloadDir);
    
    // Set up download behavior
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir
    });

    // If HTML file path is provided, serve it via local HTTP server
    // This is necessary because file:// URLs block external scripts (jQuery, etc.)
    if (htmlFilePath) {
      const htmlDir = path.dirname(path.resolve(htmlFilePath));
      const htmlFileName = path.basename(htmlFilePath);
      
      // Start a local server to serve the HTML file
      const serverInfo = await createLocalServer(htmlDir);
      localServer = serverInfo.server;
      
      const localUrl = `http://127.0.0.1:${serverInfo.port}/${encodeURIComponent(htmlFileName)}`;
      await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('HTML file loaded via HTTP');
    } else {
      // Build URL with form data for GET request
      let url = formInfo.formAction;
      if (formInfo.formMethod === 'GET' && Object.keys(formInfo.formData).length > 0) {
        const params = new URLSearchParams();
        Object.entries(formInfo.formData).forEach(([key, value]) => {
          if (value) params.append(key, value);
        });
        url = `${formInfo.formAction}?${params.toString()}`;
      }

      console.log('Navigating to form URL');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    // Wait for page to fully load and JavaScript to execute
    await page.waitForSelector('form', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    try {
      await page.waitForSelector('input[id*="openonline"], input[name="cresLoginButton"], input[type="submit"]', { 
        timeout: 10000 
      });
    } catch (error) {
      // Continue
    }

    // Try to find and click the button
    let buttonClicked = false;
    const buttonSelectors = Array.isArray(formInfo.buttonSelectors) && formInfo.buttonSelectors.length > 0
      ? formInfo.buttonSelectors
      : [{ selector: 'input[id*="openonline"]', onclick: null, priority: 1 }];
    
    for (const buttonInfo of buttonSelectors) {
      const selector = typeof buttonInfo === 'string' ? buttonInfo : buttonInfo.selector;
      const onclick = typeof buttonInfo === 'object' ? buttonInfo.onclick : null;
      
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isIntersectingViewport();
          if (isVisible) {
            console.log('Clicking form button');
            
            // If button has onclick handler, try to execute it directly
            if (onclick && onclick.includes('openOnline')) {
              try {
                // Execute the openOnline function with payload
                await page.evaluate((sel) => {
                  const btn = document.querySelector(sel);
                  if (btn) {
                    // Try to get payload from window if available
                    if (typeof window.openOnline === 'function') {
                      const payload = window.payload || {};
                      return window.openOnline(payload);
                    } else if (btn.onclick) {
                      // Execute the onclick handler directly
                      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
                      btn.dispatchEvent(event);
                      // Also try calling onclick directly
                      if (typeof btn.onclick === 'function') {
                        btn.onclick(event);
                      }
                    } else {
                      btn.click();
                    }
                  }
                }, selector);
                buttonClicked = true;
                break;
              } catch (jsError) {
                // Try regular click
              }
            }
            
            // Try regular click
            try {
              await button.click();
              buttonClicked = true;
              break;
            } catch (clickError) {
              // Try JavaScript click as fallback
              await page.evaluate((sel) => {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
              }, selector);
              buttonClicked = true;
              break;
            }
          }
        }
      } catch (error) {
        // Try next selector
      }
    }

    if (!buttonClicked) {
      // Try to find the "Open Online" button specifically by ID attribute value
      try {
        const openOnlineBtn = await page.evaluateHandle(() => {
          // Find button by ID value (handles dots in ID)
          const allInputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
          return allInputs.find(input => {
            const id = input.getAttribute('id');
            return id && (id.includes('openonline') || id === 'text_i18n.authframe.safr.button.openonline');
          }) || null;
        });
        
        if (openOnlineBtn && openOnlineBtn.asElement()) {
          await page.evaluate((btn) => {
            if (btn) {
              // Try to execute openOnline function
              if (typeof window.openOnline === 'function') {
                window.openOnline(window.payload || {});
              } else if (btn.onclick) {
                // Execute onclick handler
                const event = new MouseEvent('click', { bubbles: true, cancelable: true });
                btn.dispatchEvent(event);
                if (typeof btn.onclick === 'function') {
                  btn.onclick(event);
                }
              } else {
                btn.click();
              }
            }
          }, openOnlineBtn);
          buttonClicked = true;
          // Button clicked
        }
      } catch (error) {
        // Could not find Open Online button
      }
      
      // Fallback: try any submit button
      if (!buttonClicked) {
        try {
          await page.click('input[type="submit"], button[type="submit"], .btn, .oobtn');
          buttonClicked = true;
          // Clicked generic submit
        } catch (error) {
          throw new Error('Could not find or click any button on the form');
        }
      }
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    try {
      await page.waitForSelector('body', { timeout: 5000 });
    } catch (error) {
      // Continue
    }

    const pdfLink = await findPdfLink(page);
    if (!pdfLink) {
      throw new Error('PDF link not found on the page');
    }
    console.log('PDF link found');

    // Download the PDF
    const pdfPath = await downloadPdf(page, pdfLink, downloadDir);
    
    return pdfPath;
  } finally {
    await browser.close();
    // Clean up local server if it was started
    if (localServer) {
      localServer.close();
      console.log('Local server stopped');
    }
  }
}

/**
 * Find PDF link on the page
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<string|null>} PDF URL or null
 */
async function findPdfLink(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const pdfUrl = await frame.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, [href]'));
        for (const link of links) {
          const href = link.href || link.getAttribute('href');
          if (href && href.includes('.pdf')) {
            return href;
          }
        }
        return null;
      });
      if (pdfUrl) return pdfUrl;
    } catch (error) {
      // Continue
    }
  }
  
  // Try various selectors for PDF links in main page
  const selectors = [
    'a[href*=".pdf"]',
    'a[href$=".pdf"]',
    'a[download*=".pdf"]',
    '[href*=".pdf"]',
    'a[href*="pdf"]',
    '[data-href*=".pdf"]'
  ];

  for (const selector of selectors) {
    try {
      const link = await page.$(selector);
      if (link) {
        const href = await page.evaluate(el => {
          return el.href || el.getAttribute('href') || el.getAttribute('data-href');
        }, link);
        if (href && href.includes('.pdf')) return href;
      }
    } catch (error) {
      // Continue to next selector
    }
  }

  // Try to find PDF in all page content (including dynamically loaded)
  try {
    const pdfUrl = await page.evaluate(() => {
      // Search all links
      const links = Array.from(document.querySelectorAll('a, [href], [data-href]'));
      for (const link of links) {
        const href = link.href || link.getAttribute('href') || link.getAttribute('data-href');
        if (href && (href.includes('.pdf') || href.toLowerCase().includes('pdf'))) {
          return href;
        }
      }
      
      // Search in text content for PDF references
      const bodyText = document.body.innerText || document.body.textContent || '';
      const pdfMatches = bodyText.match(/https?:\/\/[^\s]+\.pdf/gi);
      if (pdfMatches && pdfMatches.length > 0) {
        return pdfMatches[0];
      }
      
      return null;
    });
    
    if (pdfUrl) return pdfUrl;
  } catch (error) {
    // Continue
  }

  // Check network requests for PDF files
  try {
    const pdfUrl = await new Promise((resolve) => {
      page.on('response', (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'];
        if (url.includes('.pdf') || contentType === 'application/pdf') {
          resolve(url);
        }
      });
      
      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);
    });
    
    if (pdfUrl) return pdfUrl;
  } catch (error) {
    // Continue
  }
  return null;
}

/**
 * Download PDF from URL
 * @param {Page} page - Puppeteer page object
 * @param {string} pdfUrl - PDF URL
 * @param {string} downloadDir - Directory to save PDF
 * @returns {Promise<string>} Path to downloaded PDF
 */
async function downloadPdf(page, pdfUrl, downloadDir) {
  console.log('Downloading PDF...');
  let filename = 'document.pdf';
  try {
    const urlParts = pdfUrl.split('/');
    const urlFilename = urlParts[urlParts.length - 1].split('?')[0];
    if (urlFilename.includes('.pdf')) {
      filename = decodeURIComponent(urlFilename);
    }
  } catch (error) {
    // Use default filename
  }

  // Try to fetch the PDF using page.evaluate to maintain session context
  try {
    const pdfBuffer = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Array.from(new Uint8Array(arrayBuffer));
    }, pdfUrl);

    // Convert to Buffer
    const buffer = Buffer.from(pdfBuffer);
    
    // Validate it's actually a PDF (check magic bytes)
    const pdfMagic = buffer.slice(0, 5).toString('ascii');
    if (!pdfMagic.startsWith('%PDF-')) {
      console.error('Downloaded file is not a valid PDF');
      throw new Error('Downloaded file is not a valid PDF - received HTML or error page instead');
    }
    const pdfPath = path.join(downloadDir, filename);
    await fs.writeFile(pdfPath, buffer);
    console.log(`PDF downloaded, size: ${(buffer.length / 1024).toFixed(2)} KB`);
    return pdfPath;
  } catch (error) {
    // Try navigation method
    
    // Fallback: Try navigating to the URL (may fail if session required)
    try {
      const response = await page.goto(pdfUrl, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      if (!response || !response.ok()) {
        throw new Error(`Failed to load PDF: ${response?.status() || 'unknown error'}`);
      }

      // Get filename from response headers
      try {
        const contentDisposition = response.headers()['content-disposition'];
        if (contentDisposition) {
          const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (match) {
            filename = match[1].replace(/['"]/g, '');
          }
        }
      } catch (error) {
        // Use filename from URL
      }

      // Save PDF content
      const pdfPath = path.join(downloadDir, filename);
      const buffer = await response.buffer();
      
      // Validate it's actually a PDF (check magic bytes)
      const pdfMagic = buffer.slice(0, 5).toString('ascii');
      if (!pdfMagic.startsWith('%PDF-')) {
        console.error('Downloaded file is not a valid PDF');
        throw new Error('Downloaded file is not a valid PDF - received HTML or error page instead');
      }
      await fs.writeFile(pdfPath, buffer);
      console.log(`PDF downloaded, size: ${(buffer.length / 1024).toFixed(2)} KB`);
      return pdfPath;
    } catch (navError) {
      throw new Error(`Failed to download PDF: ${error.message}. Navigation error: ${navError.message}`);
    }
  }
}
