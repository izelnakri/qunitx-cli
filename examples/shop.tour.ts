// A walkthrough of a shop, as `qunitx record shop.tour.ts -f shop.gif` records it: a cursor that
// types and clicks, a zoom onto the cart, captions, and checkout opening in a second tab.
//
// Start your app first; the tour drives it like a person would. Every step happens in the real
// browser and lasts as long as the tour says, so the GIF plays the same on any machine.
import { tour } from '../lib/api/index.ts'; // in your project: from 'qunitx-cli'

export default tour(async (t) => {
  await t.goto('http://localhost:4200/');

  await t.caption('Find what you want');
  await t.type('#search', 'tea');

  await t.caption('Hover a product, add it to the cart');
  await t.hover('.product:first-child');
  await t.click('.product:first-child button');

  await t.caption('The cart updates instantly');
  await t.zoom('#cart', { scale: 2 });
  await t.wait(1000);
  await t.zoomOut();

  await t.caption('Checkout opens in a new tab');
  await t.open('http://localhost:4200/checkout');
  await t.wait(1500);
});
