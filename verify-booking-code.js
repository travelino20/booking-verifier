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
  // Low-memory Chromium flags for constrained hosts (e.g. Render Free 512MB).
  // `--single-process` is the big one — forces Chromium to run everything in
  // one process instead of spawning a child per tab, cutting RAM usage roughly
  // in half. `--disable-dev-shm-usage` is critical in containers where /dev/shm
  // is tiny (64MB), otherwise Chromium crashes on any non-trivial page.
  const browser = await chromium.launch({
    headless: !headful,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--single-process',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
      '--disable-ipc-flooding-protection',
      '--no-first-run',
      '--no-default-browser-check',
      '--metrics-recording-only',
      '--mute-audio'
    ]
  });
  const context = await browser.newContext({
    locale: 'en-GB',
    // Booking geo-detects language by IP (Render = Frankfurt → German). Force
    // English via Accept-Language header + locale. We also set a language
    // cookie below after creation.
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9'
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }, // smaller viewport = less rendering memory
    javaScriptEnabled: true
  });
  // Language cookie — Booking respects this for the UI.
  await context.addCookies([
    { name: 'lang', value: 'en-gb', domain: '.booking.com', path: '/' },
    { name: 'selected_currency', value: 'RON', domain: '.booking.com', path: '/' }
  ]);
  // Block heavy resources (images, videos, fonts, stylesheets) — we only need
  // DOM + JS execution to read text. This alone can halve peak RAM on Booking.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    return route.continue();
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

    // Skip the search step entirely. Go directly to a fixed hotel page (much
    // faster on low-memory hosts). Hotel chosen for stable single-room layout.
    // Use the .en-gb.html variant explicitly to force the English UI. Combined
    // with the lang=en-gb cookie, this reliably avoids Booking's geo-redirect
    // to German/Dutch/etc on cloud IPs.
    const hotelUrl = `https://www.booking.com/hotel/ro/tomis-garden-bucuresti.en-gb.html?checkin=${checkin}&checkout=${checkout}&group_adults=2&no_rooms=1&selected_currency=RON&lang=en-gb`;
    result.hotel = 'Tomis Garden București';
    const hotelPage = page;

    await hotelPage.goto(hotelUrl, { waitUntil: 'domcontentloaded' });

    // Dismiss cookie banner (RO/EN/DE).
    try {
      const refuse = hotelPage.getByRole('button', { name: /Refuz|Reject|Ablehnen|Decline/i }).first();
      if (await refuse.isVisible({ timeout: 3000 })) await refuse.click();
    } catch (_) { /* ignore */ }

    // Wait for EITHER a reserve button OR a room-select to appear. Booking
    // often has the first room pre-selected, so the reserve button alone is
    // enough. This is more forgiving than waiting on the select specifically.
    await hotelPage.waitForSelector(
      'button:has-text("Voi rezerva"), button:has-text("I\'ll reserve"), button:has-text("Reserve"), select[name^="nr_rooms"]',
      { timeout: 30_000 }
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

    // Click the reserve action. Booking varies wording by locale and layout:
    // RO: "Voi rezerva", "Rezervă"; EN: "Reserve", "Book now", "I'll reserve";
    // DE: "Reservieren", "Jetzt buchen".
    const reserveBtn = hotelPage.locator([
      'button:has-text("Voi rezerva")',
      'button:has-text("Voi face o rezervare")',
      'button:has-text("Rezervă")',
      'button:has-text("Rezervați")',
      'button:has-text("I\'ll reserve")',
      'button:has-text("I will reserve")',
      'button:has-text("I\'ll book")',
      'button:has-text("Book now")',
      'button:has-text("Reserve")',
      'button:has-text("Reservieren")',
      'button:has-text("Jetzt buchen")',
      'a:has-text("Voi rezerva")',
      'a:has-text("Rezervă")',
      'a:has-text("Reserve")',
      'a:has-text("Book now")',
      'a:has-text("Reservieren")',
      'input[type="submit"][value*="rezerv" i]',
      'input[type="submit"][value*="book" i]',
      'input[type="submit"][value*="reserve" i]',
      'input[type="submit"][value*="reservieren" i]',
      'button[data-testid*="reserve" i]',
      'button[data-testid*="book" i]'
    ].join(', ')).first();
    await reserveBtn.waitFor({ state: 'visible', timeout: 25_000 });
    await reserveBtn.scrollIntoViewIfNeeded().catch(() => {});
    await reserveBtn.click();

    // First click is often a "soft" CTA that just scrolls to the rooms table
    // (URL gets `#tab-main` suffix). The real reserve button lives inside the
    // rooms form, next to each room row, after a quantity is picked. Give the
    // page a beat to settle, then explicitly work the rooms table.
    await hotelPage.waitForTimeout(1500);

    // Are we already on stage 2 (firstname visible)? If yes, great — skip ahead.
    const alreadyStage2 = await hotelPage
      .locator('input[name="firstname"], input[id*="firstname"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (!alreadyStage2) {
      // Step into the rooms form: pick 1 in the first nr_rooms select, then
      // click the real "Reserve" / "I'll reserve" submit button.
      await hotelPage.waitForSelector(
        'select[name^="nr_rooms"], form#hotelroomform, #hprt-table, table.hprt-table',
        { timeout: 20_000 }
      );

      // Choose quantity 1 on the first visible room selector.
      await hotelPage.evaluate(() => {
        const sel = document.querySelector('select[name^="nr_rooms"]');
        if (sel) {
          sel.value = '1';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await hotelPage.waitForTimeout(600);

      // Find the actual submit button in the rooms form.
      const realReserve = hotelPage.locator([
        'form#hotelroomform button[type="submit"]',
        'form#hotelroomform input[type="submit"]',
        '#hp_book_now_button',
        'button[data-bui-ref="book-now"]',
        'button[type="submit"]:has-text("I\'ll reserve")',
        'button[type="submit"]:has-text("Reserve")',
        'button[type="submit"]:has-text("Reservieren")',
        'button[type="submit"]:has-text("Rezervă")',
        'input[type="submit"][value*="Reserve" i]',
        'input[type="submit"][value*="Reservieren" i]'
      ].join(', ')).first();
      await realReserve.waitFor({ state: 'visible', timeout: 15_000 });
      await realReserve.scrollIntoViewIfNeeded().catch(() => {});
      // Click and wait for navigation in parallel so we don't miss fast redirects.
      await Promise.all([
        hotelPage.waitForURL(/book|basket|checkout|Booking/i, { timeout: 30_000 }).catch(() => {}),
        realReserve.click()
      ]);
    }

    // Stage 2: fill minimal personal details. Wait on the element we'll act on
    // rather than loadState, which is unreliable on Booking.
    await hotelPage.waitForSelector('input[name="firstname"], input[id*="firstname"]', { timeout: 30_000 });

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

    // Proceed to stage 3. RO: "Urmează"; EN: "Next" / "Final details"; DE: "Weiter".
    await hotelPage.getByRole('button', { name: /Urmează|Next|Ultimele detalii|Weiter|Nächster|Continue/i }).first().click();
    await hotelPage.waitForSelector(
      'text=/cod promo|promotional|Detalii finale|Final details|Gutscheincode|Promo-Code|Letzte Angaben|Abschließende/i',
      { timeout: 30_000 }
    );

    // Read price BEFORE
    await hotelPage.waitForTimeout(1500);
    result.priceBefore = await getTotalPrice(hotelPage);

    // Expand the promo-code section if it's collapsed behind a toggle.
    // RO: "cod promoțional"; EN: "promo code" / "promotional code"; DE: "Gutscheincode".
    try {
      const expand = hotelPage.locator([
        'button:has-text("cod promoțional")',
        'button:has-text("cod promo")',
        'button:has-text("promotional code")',
        'button:has-text("promo code")',
        'button:has-text("Gutscheincode")',
        'button:has-text("Promo-Code")',
        'a:has-text("cod promoțional")',
        'a:has-text("promo code")',
        'a:has-text("Gutscheincode")',
        'summary:has-text("cod promo")',
        'summary:has-text("promotional")',
        'summary:has-text("Gutscheincode")'
      ].join(', ')).first();
      if (await expand.isVisible({ timeout: 3000 })) {
        await expand.click();
        await hotelPage.waitForTimeout(500);
      }
    } catch (_) { /* already open or different layout */ }

    // Apply the promo code — broader selector covering name/id in addition to
    // placeholder and aria-label.
    const codeInput = hotelPage.locator(
      'input[placeholder*="promo" i], input[aria-label*="promo" i], input[name*="promo" i], input[id*="promo" i]'
    ).first();
    await codeInput.waitFor({ state: 'visible', timeout: 20_000 });
    await codeInput.fill(code);

    const applyBtn = hotelPage.getByRole('button', { name: /Aplicați|Apply|Anwenden|Übernehmen/i }).first();
    await applyBtn.click();

    // Fast adaptive polling: ONE evaluate() per iteration that returns both
    // the body text (for error detection) AND a best-effort price extraction,
    // instead of calling document.body.innerText twice (once here, once inside
    // getTotalPrice). That halves the per-iteration cost on Booking's heavy DOM.
    // Exits as soon as we see a rejection message OR a price change.
    const deadline = Date.now() + 3000;
    const errorRe = /nu este valid|invalid code|not valid|nu este valabil|nicht gültig|ungültig|ungueltig|doesn't apply|does not apply|cannot be applied/i;
    let bodyAfter = '';
    let priceNow = result.priceBefore;
    let resolved = false;
    while (Date.now() < deadline) {
      await hotelPage.waitForTimeout(200);
      const snap = await hotelPage.evaluate(() => {
        const txt = document.body.innerText || '';
        // Try a couple of specific total-price shapes inline.
        const m = txt.match(/Total\s*\n?\s*([\d.,]+\s*lei)/i)
               || txt.match(/([\d.,]+\s*lei)\s*(?:Include taxe|Total)/i);
        return { txt, totalRaw: m ? m[1] : null };
      }).catch(() => ({ txt: '', totalRaw: null }));
      bodyAfter = snap.txt.toLowerCase();
      if (errorRe.test(snap.txt)) { resolved = true; break; }
      if (snap.totalRaw) {
        const parsed = parsePriceRo(snap.totalRaw);
        if (parsed != null) priceNow = parsed;
      }
      if (priceNow != null && result.priceBefore != null && priceNow !== result.priceBefore) {
        resolved = true;
        break;
      }
    }
    result.priceAfter = priceNow;

    if (/nu este valid|invalid code|not valid|nu este valabil|nicht gültig|ungültig|ungueltig/.test(bodyAfter)) {
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
    // On failure, try to snapshot the page so we can see why locator missed.
    // We grab the URL + the first 10 button texts. Cheap and hugely useful.
    try {
      const pages = context.pages();
      const p = pages[pages.length - 1];
      if (p) {
        const url = p.url();
        const btnTexts = await p.evaluate(() => {
          const items = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'));
          return items.slice(0, 15).map(el => {
            const t = (el.innerText || el.value || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            return t || '(no text)';
          });
        }).catch(() => []);
        result.reason += ` | URL: ${url} | Butoane găsite: ${JSON.stringify(btnTexts)}`;
      }
    } catch (_) { /* best-effort debug info */ }
  } finally {
    // Close the browser asynchronously — we have the verdict already, the user
    // shouldn't wait for Chromium to tear down (can be 1-3s with --single-process).
    // Fire-and-forget; if close fails we don't care, the process exits anyway.
    browser.close().catch(() => {});
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
