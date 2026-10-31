// Smoke test: upload a video, wait for tracking, export CSV and MP4.
// Usage: BASE_URL=http://localhost:3000/ node scripts/e2e-smoke.cjs rally.mp4
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page.on('console', m => console.log('console:', m.type(), m.text()));
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto('process.env.BASE_URL || 'http://localhost:3000/'');
  await page.setInputFiles('input[type=file]', process.argv[2] || 'rally.mp4');
  await page.getByText('Rally', { exact: true }).waitFor({ timeout: 30000 });
  const stats = await page.locator('aside .grid').innerText();
  console.log('STATS', stats.replace(/\n/g, ' | '));
  const v = page.locator('video');
  await v.evaluate(el => { el.currentTime = 2.2; });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'preview.png' });
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByText('ข้อมูล CSV').click()]);
  await csv.saveAs('out.csv');
  const [mp4] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.getByText('วิดีโอ MP4 พร้อมเส้น').click()]);
  await mp4.saveAs('out.mp4');
  const err = await page.locator('text=เกิดข้อผิดพลาด').count();
  console.log('ERR', err);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
