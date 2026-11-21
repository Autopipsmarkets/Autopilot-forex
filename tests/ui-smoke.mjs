/* Headless UI smoke test with the system Chrome. */
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const email = `ui-${Date.now()}@test.local`;
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail}`}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle2' });

const badge = await page.$eval('#marketBadge', (el) => el.textContent.trim());
check('site loads and market status renders', ['not configured', 'live', 'cached', 'unavailable'].includes(badge), badge);

const plans = await page.$$eval('#planBox button[data-plan]', (els) => els.length);
check('plans render from API', plans >= 1, `buttons=${plans}`);
await page.screenshot({ path: '/tmp/shot-home.png', fullPage: false });

// Register through the UI
await page.click('#registerBtn');
await page.waitForSelector('#mName');
await page.type('#mName', 'UI Test Trader');
await page.type('#mEmail', email);
await page.type('#mPassword', 'GoldDesk#2026');
await page.click('#submitButton');
await page.waitForFunction(() => !document.getElementById('memberView').hidden, { timeout: 15000 });
const welcome = await page.$eval('#welcomeMessage', (el) => el.textContent);
check('registration signs the user in', welcome.includes('Welcome'), welcome);
const planLabel = await page.$eval('#userPlan', (el) => el.textContent.trim());
check('member panel shows free tier', planLabel === 'Free', planLabel);
await page.screenshot({ path: '/tmp/shot-member.png', fullPage: false });

// Logged-in signals view
await page.goto(BASE, { waitUntil: 'networkidle2' });
const rows = await page.$$eval('#signalsTable tbody tr', (els) => els.length);
check('signals table renders', rows >= 1, `rows=${rows}`);

// Admin panel
const admin = await browser.newPage();
await admin.setViewport({ width: 1400, height: 900 });
const adminErrors = [];
admin.on('pageerror', (e) => adminErrors.push(String(e)));
await admin.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
await admin.waitForSelector('#loginEmail', { visible: true, timeout: 10000 });
await admin.type('#loginEmail', 'owner@test.local');
await admin.type('#loginPassword', 'TestOwner#2026');
await admin.click('#loginBtn');
await admin.waitForSelector('.cards', { timeout: 15000 });
const statCount = await admin.$$eval('.cards .card', (els) => els.length);
check('admin overview renders', statCount >= 4, `cards=${statCount}`);
await admin.screenshot({ path: '/tmp/shot-admin.png', fullPage: false });

await admin.click('.nav-item[data-view="signals"]');
await admin.waitForSelector('.panel table', { timeout: 10000 });
const signalRows = await admin.$$eval('.panel table tbody tr', (els) => els.length);
check('admin signals table renders', signalRows >= 1, `rows=${signalRows}`);
await admin.screenshot({ path: '/tmp/shot-admin-signals.png', fullPage: false });

check('no site console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('no admin console errors', adminErrors.length === 0, adminErrors.slice(0, 3).join(' | '));

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nUI smoke test passed.');
