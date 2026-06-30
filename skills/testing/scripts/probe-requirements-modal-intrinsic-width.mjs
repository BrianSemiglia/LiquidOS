//
// probe-requirements-modal-intrinsic-width.mjs
//
// The fixture renders a 200px-wide div as the component's view. When
// the user opens the Requirements modal, the surface — and the front
// face that contains it — should shrink to that intrinsic width, not
// stretch to fill the modal's left column. Stretched surfaces make
// the component look misplaced (Rain Control card sitting alone in a
// 700px-wide grey box).
//
// Run it:  node run-probe.mjs probe-requirements-modal-intrinsic-width.mjs
//

export const fixture = './probe-requirements-modal-intrinsic-width.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log('[page error]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-narrow]', { timeout: 15000 });

  // Open the modal.
  await page.getByRole('button', { name: 'Edit Narrow requirements' }).dispatchEvent('click');
  await page.waitForFunction(
    () => !!document.querySelector('.requirements-overlay [data-narrow]'),
    { timeout: 5000 }
  );
  await sleep(300);

  const layout = await page.evaluate(() => {
    const overlay = document.querySelector('.requirements-overlay');
    const item    = overlay?.querySelector('.item');
    const front   = overlay?.querySelector('.component-content');
    const back    = overlay?.querySelector('.component-requirements');
    const widget  = overlay?.querySelector('[data-narrow]');
    return {
      widgetW:    widget ? widget.getBoundingClientRect().width  : -1,
      itemLeft:   item   ? item.getBoundingClientRect().left     : -1,
      itemRight:  item   ? item.getBoundingClientRect().right    : -1,
      frontLeft:  front  ? front.getBoundingClientRect().left    : -1,
      backRight:  back   ? back.getBoundingClientRect().right    : -1
    };
  });
  console.log('layout:', layout);

  if (layout.widgetW !== 200) {
    throw new Error('widget rendered at ' + layout.widgetW + 'px instead of its intrinsic 200px');
  }
  // Collectively centered: front + back as a pair sits centered in
  // the modal item. Slack on the left of the front and slack on the
  // right of the back must match.
  const leftSlack  = layout.frontLeft - layout.itemLeft;
  const rightSlack = layout.itemRight - layout.backRight;
  if (Math.abs(leftSlack - rightSlack) > 2) {
    throw new Error('front+back pair is not centered in the modal item — leftSlack=' + leftSlack + ', rightSlack=' + rightSlack);
  }
};
