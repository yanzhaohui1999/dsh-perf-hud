import { writeFileSync } from 'node:fs';
import { withPage } from './cdp.mjs';

const out = process.argv[2] ?? '/tmp/hud.png';
const view = process.argv[3] ?? 'main';
await withPage({}, async (page) => {
  await page.waitForHud();
  await page.evaluate(`(() => {
    localStorage.setItem('dsh-perf-hud:on', '1');
    localStorage.setItem('dsh-perf-hud:collapsed', '0');
    localStorage.setItem('dsh-perf-hud:view:v1', JSON.stringify({ v: 1, view: ${JSON.stringify(view)}, devTab: 'frames', trendMs: 3600000 }));
    // 别的浮层(待办面板)会盖在 HUD 上,拍图前藏掉
    for (const n of document.querySelectorAll('.dshtb-root')) n.style.display = 'none';
    return true;
  })()`);
  await page.reload();
  await page.waitForHud();
  await page.evaluate(`(() => {
    for (const n of document.querySelectorAll('.dshtb-root')) n.style.display = 'none';
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const rect = await page.evaluate(`(() => { const n = document.getElementById('dsh-perf-hud-root'); const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const clip = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 2 };
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, clip);
});
