/** Default qunitx config values: build output directory, test timeout (ms), fail-fast flag, HTTP server port, and tracked file extensions. */
export default {
  output: 'tmp',
  timeout: 20000,
  failFast: false,
  port: 1234,
  extensions: ['js', 'ts'],
  browser: 'chromium',
};
