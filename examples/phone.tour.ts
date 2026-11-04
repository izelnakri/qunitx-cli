// A mobile walkthrough, as `qunitx record phone.tour.ts -w 390 -h 844 -f phone.gif` records it:
// real taps and swipes, a fingertip instead of a cursor, drawn inside a phone.
//
// `touch: true` gives the page touch input (and makes it a mobile page, outside Firefox). The
// finger shows only while it touches, `scroll` shows a thumb pushing the page, and `hover` is
// refused, because a touch screen has none.
import { tour } from '../lib/api/index.ts'; // in your project: from 'qunitx-cli'

export default tour({ touch: true }, async (t) => {
  await t.goto('http://localhost:4200/');

  await t.caption('Swipe through what is new');
  await t.swipe('.carousel', 'left');
  await t.swipe('.carousel', 'left');

  await t.caption('Tap to add it to your bag');
  await t.tap('.carousel .active button');

  await t.caption('Everything else is a scroll away');
  await t.scroll({ y: 900 });
  await t.wait(600);
  await t.scroll({ y: -900 });
});
