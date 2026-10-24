import { writeFileSync } from 'node:fs';
import { withPage } from './cdp.mjs';
await withPage({}, async (page) => {
  await page.waitForHud();
  await page.evaluate(`(() => {
    localStorage.setItem('dsh-perf-hud:on', '1');
    localStorage.setItem('dsh-perf-hud:collapsed', '0');
    localStorage.setItem('dsh-perf-hud:view:v1', JSON.stringify({ v: 1, view: 'main', devTab: 'frames', trendMs: 3600000 }));
    localStorage.removeItem('dsh-perf-hud:groups');
    window.__perfHud.clearIncidents();
    return true;
  })()`);
  await page.reload();
  await page.waitForHud();
  await page.evaluate(`(() => { const until = performance.now() + 400; while (performance.now() < until) { /* burn */ } return true; })()`);
  await page.sleep(4500);
  const n = await page.evaluate(`window.__perfHud.incidents().length`);
  const clicked = await page.evaluate(`(() => { const n = document.querySelector('#dsh-perf-hud-root [data-incident-open]'); if (!n) return false; n.click(); return true; })()`);
  await page.sleep(700);
  await page.evaluate(`(() => { for (const n of document.querySelectorAll('.dshtb-root')) n.style.display = 'none'; return true; })()`);
  const rect = await page.evaluate(`(() => { const b = document.querySelector('#dsh-perf-hud-root').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 2 }, captureBeyondViewport: false });
  writeFileSync('/tmp/hud-incident.png', Buffer.from(shot.data, 'base64'));
  console.log('incidents', n, 'clicked', clicked, rect);
});
