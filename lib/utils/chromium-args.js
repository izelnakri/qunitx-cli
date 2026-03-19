/** Launch args passed to Chromium for both the CDP pre-launch spawn and the playwright fallback launch. */
export default [
  '--no-sandbox',
  '--disable-gpu',
  '--window-size=1440,900',
  '--disable-extensions',
  '--disable-sync',
  '--no-first-run',
  '--disable-default-apps',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',
  '--disable-translate',
  '--metrics-recording-only',
  '--disable-hang-monitor',
];
