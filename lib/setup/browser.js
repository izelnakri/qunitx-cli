import Puppeteer from 'puppeteer';
import setupWebServer from './web-server.js';
import bindServerToPort from './bind-server-to-port.js';
import findChrome from '../utils/find-chrome.js';

/**
 * Launches a Puppeteer browser (or reuses an existing one), starts the web server, and returns the page/server/browser connection object.
 * @returns {Promise<{server: object, browser: object, page: object}>}
 */
export default async function setupBrowser(
  config = {
    port: 1234,
    debug: false,
    watch: false,
    timeout: 10000,
  },
  cachedContent,
  existingBrowser = null,
) {
  const [server, browser] = await Promise.all([
    setupWebServer(config, cachedContent),
    existingBrowser
      ? Promise.resolve(existingBrowser)
      : Puppeteer.launch({
          debugger: config.debug || false,
          args: [
            '--no-sandbox',
            '--disable-gpu',
            '--remote-debugging-port=0',
            '--window-size=1440,900',
          ],
          executablePath: await findChrome(),
          headless: true,
        }),
  ]);
  const [page] = await Promise.all([browser.newPage(), bindServerToPort(server, config)]);

  page.on('console', async (msg) => {
    if (config.debug) {
      const args = await Promise.all(msg.args().map((arg) => turnToObjects(arg)));

      console.log(...args);
    }
  });
  page.on('error', (msg) => {
    console.error(msg, msg.stack);
    console.log(msg, msg.stack);
  });
  page.on('pageerror', (error) => {
    console.log(error.toString());
    console.error(error.toString());
  });

  return { server, browser, page };
}

function turnToObjects(jsHandle) {
  return jsHandle.jsonValue();
}
