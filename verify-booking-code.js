#!/usr/bin/env node
/**
 * verify-booking-code.js
 * ------------------------------------------------------------
 * Verifică automat un cod promoțional Booking.com parcurgând
 * același flux pe care l-am făcut manual:
 *   1) Caută cazare în București (check-in peste ~14 zile)
 *   2) Alege prima proprietate, apasă "Voi rezerva"
 *   3) Completează minimal datele la pasul 2
 *   4) Pe pasul 3 "Detalii finale": citește prețul inițial,
 *      introduce codul, apasă Aplicați, re-citește prețul.
 *   5) Raportează JSON cu verdictul.
 *
 * OPRIREA se face înainte de orice input de card bancar.
 *
 * Cerințe:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Folosire:
 *   node verify-booking-code.js --code BOOK15OFF
 *   node verify-booking-code.js --code BOOK15OFF --headful
 *   node verify-booking-code.js --code BOOK15OFF --name "Test User" --email test@example.com
 *
 * Returnează pe stdout un JSON de forma:
 * {
 *   "code": "BOOK15OFF",
 *   "valid": false,
 *   "reason": "Booking: Acest cod nu este valid",
 *   "priceBefore": 852.61,
 *   "priceAfter": 852.61,
 *   "discount": 0,
 *   "discountPct": 0,
 *   "hotel": "...",
 *   "checkedAt": "2026-04-22T12:34:56.000Z"
 * }
 */
 
const { chromium } = require('playwright');
 
// ---------- CLI parsing ----------
function parseArgs(argv) {
  const args = {
    code: null,
    headful: false,
    name: 'Test Verifier',
    email: 'verifier@example.com',
    phone: '0700000000',
    timeoutMs: 60_000
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--code') args.code = argv[++i];
    else if (a === '--headful') args.headful = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--email') args.email = argv[++i];
    else if (a === '--phone') args.phone = argv[++i];
    else if (a === '--timeout') args.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node verify-booking-code.js --code CODE [--headful] [--name N] [--email E] [--phone P]`);
      process.exit(0);
    }
  }
  if (!args.code) {
    console.error('ERROR: missing --code. Example: node verify-booking-code.js --code BOOK15OFF');
    process.exit(2);
  }
  return args;
}
 
// ---------- Helpers ----------
function datePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
 
// Extrage un preț din text de tip "852,61 lei" sau "1.495,80 lei" → 852.61 / 1495.80
function parsePriceRo(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+(?:,\d+)?)\s*(?:lei|RON)/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}
 
async function getTotalPrice(page) {
  // The "Total" block shows current grand total on Booking's stage 3.
  // It's labeled "Total" followed by "XXX lei".
  const body = await page.evaluate(() => document.body.innerText || '');
  const m = body.match(/Total\s*\n?\s*([\d.,]+\s*lei)/i)
         || body.match(/([\d.,]+\s*lei)\s*(?:Include taxe|Total)/i);
  if (m) return parsePriceRo(m[1]);
  // Fallback: first "xxx lei" near the end of the page.
  const all = [...body.matchAll(/([\d.,]+\s*lei)/gi)].map(x => parsePriceRo(x[1])).filter(Boolean);
  return all.length ? Math.max(...all) : null;
}
 
// ---------- Main flow ----------
async function verify({ code, headful, name, email, phone, timeoutMs }) {
  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext({
    locale: 'ro-RO',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  // Apply timeout at context level so any new page (e.g. the hotel tab that
  // opens via target=_blank) inherits it. Otherwise the new page uses
  // Playwright's default 30s which is too short for Booking.
  context.setDefaultTimeout(timeoutMs);
  context.setDefaultNavigationTimeout(timeoutMs);
  const page = await context.newPage();
 
  const result = {
    code,
    valid: false,
    reason: null,
    priceBefore: null,
    priceAfter: null,
    discount: 0,
    discountPct: 0,
    hotel: null,
    checkedAt: new Date().toISOString()
  };
 
  try {
    const checkin = datePlus(14);
    const checkout = datePlus(16);
    const searchUrl = `https://www.booking.com/searchresults.ro.html?ss=Bucure%C8%99ti&checkin=${checkin}&checkout=${checkout}&group_adults=2&no_rooms=1`;
 
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
 
    // Dismiss cookie banner if present
    try {
      const refuse = page.getByRole('button', { name: /Refuz|Reject/i }).first();
      if (await refuse.isVisible({ timeout: 3000 })) await refuse.click();
    } catch (_) { /* ignore */ }
 
    // Click the first hotel result
    const firstCard = page.locator('[data-testid="property-card"]').first();
    await firstCard.waitFor({ state: 'visible' });
    result.hotel = (await firstCard.locator('[data-testid="title"]').innerText().catch(() => 'unknown')).trim();
 
    // Hotel detail page opens in a new tab
    const [hotelPage] = await Promise.all([
      context.waitForEvent('page'),
      firstCard.locator('[data-testid="title-link"], a').first().click()
    ]);
 
    // Wait for EITHER a reserve button OR a room-select to appear. Booking
    // often has the first room pre-selected, so the reserve button alone is
    // enough. This is more forgiving than waiting on the select specifically.
    await hotelPage.waitForSelector(
      'button:has-text("Voi rezerva"), button:has-text("I\'ll reserve"), button:has-text("Reserve"), select[name^="nr_rooms"]',
      { timeout: 60_000 }
    );
 
    // If there's a visible room-quantity select still at 0, bump it to 1.
    try {
      const hasSelect = await hotelPage.locator('select[name^="nr_rooms"]').first().isVisible({ timeout: 2000 });
      if (hasSelect) {
        await hotelPage.evaluate(() => {
          const sel = document.querySelector('select[name^="nr_rooms"]');
          if (sel && sel.value === '0') {
            sel.value = '1';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
    } catch (_) { /* no select → already-selected default */ }
 
    // Click the first visible "Voi rezerva" / "Reserve" button.
    const reserveBtn = hotelPage.getByRole('button', { name: /Voi rezerva|I'll reserve|Reserve/i }).first();
    await reserveBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await reserveBtn.click();
 
    // Stage 2: fill minimal personal details. Wait on the element we'll act on
    // rather than loadState, which is unreliable on Booking.
    await hotelPage.waitForSelector('input[name="firstname"], input[id*="firstname"]', { timeout: 45_000 });
 
    const [firstName, ...lastParts] = name.split(' ');
    const lastName = lastParts.join(' ') || 'User';
 
    await hotelPage.fill('input[name="firstname"]', firstName);
    await hotelPage.fill('input[name="lastname"]', lastName);
    await hotelPage.fill('input[name="email"]', email);
    try { await hotelPage.fill('input[name="email_confirm"]', email); } catch (_) {}
    try {
      const phoneInput = hotelPage.locator('input[type="tel"], input[name*="phone"]').first();
      if (await phoneInput.isVisible()) await phoneInput.fill(phone);
    } catch (_) {}
 
    // Proceed to stage 3. Again, skip waitForLoadState — wait on the element
    // that marks stage 3 instead.
    await hotelPage.getByRole('button', { name: /Urmează|Next|Ultimele detalii/i }).first().click();
    await hotelPage.waitForSelector('text=/cod promo|promotional|Detalii finale|Final details/i', { timeout: 45_000 });
 
    // Read price BEFORE
    await hotelPage.waitForTimeout(1500);
    result.priceBefore = await getTotalPrice(hotelPage);
 
    // Apply the promo code
    const codeInput = hotelPage.locator('input[placeholder*="promo" i], input[aria-label*="promo" i]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 15_000 });
    await codeInput.fill(code);
 
    const applyBtn = hotelPage.getByRole('button', { name: /Aplicați|Apply/i }).first();
    await applyBtn.click();
 
    // Wait for either an error message or a price update
    await hotelPage.waitForTimeout(3500);
    const bodyAfter = (await hotelPage.evaluate(() => document.body.innerText || '')).toLowerCase();
    result.priceAfter = await getTotalPrice(hotelPage);
 
    if (/nu este valid|invalid code|not valid|nu este valabil/.test(bodyAfter)) {
      result.valid = false;
      result.reason = 'Booking a răspuns: codul nu este valid.';
    } else if (result.priceBefore != null && result.priceAfter != null && result.priceAfter < result.priceBefore) {
      const d = result.priceBefore - result.priceAfter;
      result.valid = true;
      result.discount = +d.toFixed(2);
      result.discountPct = +((d / result.priceBefore) * 100).toFixed(2);
      result.reason = `Reducere aplicată: ${result.discount} lei (${result.discountPct}%).`;
    } else {
      result.valid = false;
      result.reason = 'Prețul nu a scăzut după aplicarea codului. Respins.';
    }
  } catch (err) {
    result.reason = 'Eroare în flux: ' + (err.message || String(err));
  } finally {
    await browser.close();
  }
 
  return result;
}
 
// ---------- Exports (for server.js) ----------
module.exports = { verify };
 
// ---------- CLI entry (only when run directly) ----------
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    const verdict = await verify(args);
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
    process.exit(verdict.valid ? 0 : 1);
  })();
}
