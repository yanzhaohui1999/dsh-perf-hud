import { withPage } from './cdp.mjs';
await withPage({}, async (page) => {
  await page.waitForHud();
  const info = await page.evaluate(`(() => {
    const hud = document.getElementById('dsh-perf-hud-root');
    const b = hud.getBoundingClientRect();
    const cx = Math.round(b.x + b.width / 2), cy = Math.round(b.y + 40);
    const top = document.elementFromPoint(cx, cy);
    const chain = [];
    let n = top;
    while (n && chain.length < 6) { chain.push({ tag: n.tagName, id: n.id, cls: String(n.className).slice(0, 40), z: getComputedStyle(n).zIndex, pos: getComputedStyle(n).position }); n = n.parentElement; }
    const hs = getComputedStyle(hud);
    return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, hudZ: hs.zIndex, hudOpacity: hs.opacity, hudDisplay: hs.display, hudVisibility: hs.visibility, topChain: chain };
  })()`);
  console.log(JSON.stringify(info, null, 2));
});
