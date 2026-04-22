#!/usr/bin/env node
/**
 * verify-booking-code.js
 *
 * Verifică automat un cod promoțional Booking.com parcurgând fluxul până
 * înainte de orice input de card bancar.
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
 *   "checkedAt": "2026-04-22T12:34:56.000Z",
 *   "artifacts": {
 *     "errorScreenshot": "booking-error-....png"
 *   }
 * }
 */

const { chromium } = require('playwright');

function parseArgs(argv) {
  const args = {
    code: null,
    headful: false,
    name: 'Test Verifier',
    email: 'verifier@example.com',
    phone: '0700000000',
    timeoutMs: 90000
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
      console.log('Usage: node verify-booking-code.js --code CODE [--headful] [--name N] [--email E] [--phone P] [--timeout MS]');
      process.exit(0);
    }
  }

  if (!args.code) {
    console.error('ERROR: missing --code. Example: node verify-booking-code.js --code BOOK15OFF');
    process.exit(2);
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 5000) {
    console.error('ERROR: --timeout must be a number >= 5000');
    process.exit(2);
  }

  return args;
}

function datePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Test', lastName: 'User' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'User' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

function parsePriceRo(text) {
  if (!text) return null;

  const normalized = String(text).replace(/\s+/g, ' ');
  const m =
    normalized.match(/([\d.]+(?:,\d{2})?)\s*(?:lei|RON)\b/i) ||
    normalized.match(/\b(?:RON)\s*([\d.]+(?:,\d{2})?)\b/i);

  if (!m) return null;

  const raw = m[1].replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

async function safeText(locator) {
  try {
    const txt = await locator.first().innerText({ timeout: 5000 });
    return String(txt || '').trim();
  } catch {
    return null;
  }
}

async function dismissCookieBanner(page) {
  const candidates = [
    page.getByRole('button', { name: /Refuz|Respinge|Reject|Decline|Doar necesare|Only necessary/i }).first(),
    page.getByRole('button', { name: /Accept|Sunt de acord|I agree/i }).first()
  ];

  for (const btn of candidates) {
    try {
      if (await btn.isVisible({ timeout: 2500 })) {
        await btn.click({ timeout: 5000 });
        return true;
      }
    } catch {
    }
  }

  return false;
}

async function getBodyText(page) {
  return await page.evaluate(() => document.body?.innerText || '');
}

async function getTotalPrice(page) {
  const body = await getBodyText(page);

  const directPatterns = [
    /Total\s*\n?\s*([\d.,]+\s*(?:lei|RON))/i,
    /Total de plat[ăa]\s*\n?\s*([\d.,]+\s*(?:lei|RON))/i,
    /Preț final\s*\n?\s*([\d.,]+\s*(?:lei|RON))/i,
    /([\d.,]+\s*(?:lei|RON))\s*(?:Include taxe|Total|Preț final|Taxe și comisioane)/i
  ];

  for (const re of directPatterns) {
    const m = body.match(re);
    if (m) {
      const n = parsePriceRo(m[1]);
      if (n != null) return n;
    }
  }

  const all = [...body.matchAll(/([\d.,]+\s*(?:lei|RON))/gi)]
    .map(x => parsePriceRo(x[1]))
    .filter(v => v != null);

  if (!all.length) return null;
  return Math.max(...all);
}

async function waitForAnyVisible(pageOrFrame, selectors, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const selector of selectors) {
      try {
        const loc = pageOrFrame.locator(selector).first();
        if (await loc.isVisible({ timeout: 1000 })) {
          return selector;
        }
      } catch {
      }
    }
    await pageOrFrame.waitForTimeout(400);
  }

  throw new Error(`Niciun selector nu a devenit vizibil în ${timeoutMs}ms`);
}

async function openHotelDetailsFromCard(searchPage, firstCard, timeoutMs) {
  const preferredLink = firstCard.locator('[data-testid="title-link"]').first();
  const fallbackLink = firstCard.locator('a').first();

  let hotelLink = preferredLink;
  try {
    await preferredLink.waitFor({ state: 'attached', timeout: 5000 });
  } catch {
    hotelLink = fallbackLink;
  }

  const popupPromise = searchPage.waitForEvent('popup', { timeout: 15000 }).catch(() => null);

  try {
    await hotelLink.click({ timeout: 15000 });
  } catch {
    await hotelLink.scrollIntoViewIfNeeded().catch(() => null);
    await hotelLink.click({ force: true, timeout: 15000 });
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => null);
    return popup;
  }

  await searchPage.waitForURL(
    url => !String(url).includes('/searchresults'),
    { timeout: timeoutMs }
  ).catch(() => null);

  return searchPage;
}

async function maybeSelectOneRoom(hotelPage) {
  const roomSelect = hotelPage.locator('select[name^="nr_rooms"]').first();

  try {
    if (await roomSelect.isVisible({ timeout: 2500 })) {
      const current = await roomSelect.inputValue().catch(() => null);
      if (current === '0') {
        await roomSelect.selectOption('1').catch(async () => {
          await hotelPage.evaluate(() => {
            const sel = document.querySelector('select[name^="nr_rooms"]');
            if (sel) {
              sel.value = '1';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
        });
      }
      return true;
    }
  } catch {
  }

  return false;
}

async function clickReserve(hotelPage, timeoutMs) {
  const reserveBtn = hotelPage.getByRole('button', {
    name: /Voi rezerva|I'll reserve|Reserve|Rezervă|Selectați|Select/i
  }).first();

  try {
    await reserveBtn.waitFor({ state: 'visible', timeout: 20000 });
    await reserveBtn.click({ timeout: 10000 });
    return true;
  } catch {
  }

  const fallbackSelectors = [
    'button:has-text("Voi rezerva")',
    'button:has-text("I\\'ll reserve")',
    'button:has-text("Reserve")',
    'button:has-text("Rezervă")',
    'button:has-text("Select")',
    '[data-testid*="select-room"] button'
  ];

  for (const selector of fallbackSelectors) {
    try {
      const btn = hotelPage.locator(selector).first();
      if (await btn.isVisible({ timeout: 2500 })) {
        await btn.scrollIntoViewIfNeeded().catch(() => null);
        await btn.click({ timeout: 10000 });
        return true;
      }
    } catch {
    }
  }

  throw new Error(`Nu am găsit un buton de rezervare acționabil în ${timeoutMs}ms`);
}

async function fillGuestDetails(page, name, email, phone) {
  const { firstName, lastName } = splitName(name);

  await waitForAnyVisible(
    page,
    [
      'input[name="firstname"]',
      'input[id*="firstname"]',
      'input[name*="first"]'
    ],
    45000
  );

  await page.locator('input[name="firstname"], input[id*="firstname"], input[name*="first"]').first().fill(firstName);
  await page.locator('input[name="lastname"], input[id*="lastname"], input[name*="last"]').first().fill(lastName);
  await page.locator('input[name="email"], input[type="email"]').first().fill(email);

  try {
    const confirm = page.locator('input[name="email_confirm"], input[id*="email_confirm"]').first();
    if (await confirm.isVisible({ timeout: 2000 })) {
      await confirm.fill(email);
    }
  } catch {
  }

  try {
    const phoneInput = page.locator('input[type="tel"], input[name*="phone"], input[id*="phone"]').first();
    if (await phoneInput.isVisible({ timeout: 2000 })) {
      await phoneInput.fill(phone);
    }
  } catch {
  }
}

async function goToFinalDetails(page) {
  const nextButton = page.getByRole('button', {
    name: /Urmează|Next|Ultimele detalii|Final details|Continuați|Continue/i
  }).first();

  try {
    await nextButton.waitFor({ state: 'visible', timeout: 20000 });
    await nextButton.click({ timeout: 10000 });
  } catch {
    const fallbackSelectors = [
      'button:has-text("Urmează")',
      'button:has-text("Next")',
      'button:has-text("Ultimele detalii")',
      'button:has-text("Continue")',
      'button[type="submit"]'
    ];

    let clicked = false;

    for (const selector of fallbackSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click({ timeout: 10000 });
          clicked = true;
          break;
        }
      } catch {
      }
    }

    if (!clicked) {
      throw new Error('Nu am putut continua către pasul de detalii finale');
    }
  }

  await waitForAnyVisible(
    page,
    [
      'input[placeholder*="promo" i]',
      'input[aria-label*="promo" i]',
      'input[name*="promo" i]',
      'input[id*="promo" i]'
    ],
    45000
  );
}

async function applyPromoCode(page, code) {
  const inputSelectors = [
    'input[placeholder*="promo" i]',
    'input[aria-label*="promo" i]',
    'input[name*="promo" i]',
    'input[id*="promo" i]'
  ];

  let codeInput = null;

  for (const selector of inputSelectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.isVisible({ timeout: 2500 })) {
        codeInput = loc;
        break;
      }
    } catch {
    }
  }

  if (!codeInput) {
    throw new Error('Nu am găsit câmpul pentru cod promoțional');
  }

  await codeInput.fill(code);

  const applyBtn = page.getByRole('button', { name: /Aplicați|Apply|Aplică/i }).first();

  try {
    await applyBtn.waitFor({ state: 'visible', timeout: 5000 });
    await applyBtn.click({ timeout: 10000 });
    return;
  } catch {
  }

  const fallbackApply = page.locator('button:has-text("Aplicați"), button:has-text("Apply"), button:has-text("Aplică")').first();
  await fallbackApply.click({ timeout: 10000 });
}

function detectPromoOutcome(bodyTextLower) {
  if (/nu este valid|invalid code|not valid|nu este valabil|cod invalid|codul este invalid/.test(bodyTextLower)) {
    return {
      valid: false,
      reason: 'Booking a răspuns: codul nu este valid.'
    };
  }

  if (/a fost aplicat|applied|reducere aplicată|discount applied|cod aplicat/.test(bodyTextLower)) {
    return {
      valid: null,
      reason: null
    };
  }

  return {
    valid: null,
    reason: null
  };
}

async function verify(input = {}) {
  const {
    code,
    headful = false,
    name = 'Test Verifier',
    email = 'verifier@example.com',
    phone = '0700000000',
    timeoutMs = 90000
  } = input;

  const browser = await chromium.launch({
    headless: !headful,
    slowMo: headful ? 120 : 0
  });

  const context = await browser.newContext({
    locale: 'ro-RO',
    timezoneId: 'Europe/Bucharest',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  context.setDefaultTimeout(timeoutMs);
  context.setDefaultNavigationTimeout(timeoutMs);

  const page = await context.newPage();

  const result = {
    code: code || null,
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
    if (!code) {
      throw new Error('Lipsește codul promoțional');
    }

    const checkin = datePlus(14);
    const checkout = datePlus(16);

    const searchUrl =
      `https://www.booking.com/searchresults.ro.html` +
      `?ss=${encodeURIComponent('București')}` +
      `&checkin=${checkin}` +
      `&checkout=${checkout}` +
      `&group_adults=2` +
      `&no_rooms=1`;

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    await dismissCookieBanner(page);

    const firstCard = page.locator('[data-testid="property-card"]').first();
    await firstCard.waitFor({ state: 'visible', timeout: timeoutMs });

    result.hotel = (
      (await safeText(firstCard.locator('[data-testid="title"]'))) ||
      (await safeText(firstCard.locator('a'))) ||
      'unknown'
    ).trim();

    const hotelPage = await openHotelDetailsFromCard(page, firstCard, timeoutMs);

    await hotelPage.waitForLoadState('domcontentloaded').catch(() => null);

    await waitForAnyVisible(
      hotelPage,
      [
        'button:has-text("Voi rezerva")',
        'button:has-text("I\\'ll reserve")',
        'button:has-text("Reserve")',
        'button:has-text("Rezervă")',
        'select[name^="nr_rooms"]',
        '[data-testid="title"]'
      ],
      timeoutMs
    );

    await maybeSelectOneRoom(hotelPage);
    await clickReserve(hotelPage, timeoutMs);
    await fillGuestDetails(hotelPage, name, email, phone);
    await goToFinalDetails(hotelPage);

    await hotelPage.waitForTimeout(1800);
    result.priceBefore = await getTotalPrice(hotelPage);

    await applyPromoCode(hotelPage, code);

    await hotelPage.waitForTimeout(4000);

    const bodyAfter = (await getBodyText(hotelPage)).toLowerCase();
    result.priceAfter = await getTotalPrice(hotelPage);

    const outcome = detectPromoOutcome(bodyAfter);

    if (outcome.valid === false) {
      result.valid = false;
      result.reason = outcome.reason;
    } else if (
      result.priceBefore != null &&
      result.priceAfter != null &&
      result.priceAfter < result.priceBefore
    ) {
      const d = result.priceBefore - result.priceAfter;
      result.valid = true;
      result.discount = +d.toFixed(2);
      result.discountPct = +((d / result.priceBefore) * 100).toFixed(2);
      result.reason = `Reducere aplicată: ${result.discount} lei (${result.discountPct}%).`;
    } else if (
      result.priceBefore != null &&
      result.priceAfter != null &&
      result.priceAfter >= result.priceBefore
    ) {
      result.valid = false;
      result.reason = 'Prețul nu a scăzut după aplicarea codului. Respins.';
    } else {
      result.valid = false;
      result.reason = 'Nu am putut determina sigur prețul înainte și după aplicarea codului.';
    }
  } catch (err) {
    result.reason = 'Eroare în flux: ' + (err && err.message ? err.message : String(err));
  } finally {
    await browser.close();
  }

  return result;
}

module.exports = { verify };

if (require.main === module) {
  (async () => {
    try {
      const args = parseArgs(process.argv);
      const verdict = await verify(args);
      process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
      process.exit(verdict.valid ? 0 : 1);
    } catch (err) {
      const fallback = {
        code: null,
        valid: false,
        reason: 'Eroare fatală: ' + (err && err.message ? err.message : String(err)),
        priceBefore: null,
        priceAfter: null,
        discount: 0,
        discountPct: 0,
        hotel: null,
        checkedAt: new Date().toISOString()
      };

      process.stdout.write(JSON.stringify(fallback, null, 2) + '\n');
      process.exit(1);
    }
  })();
}
