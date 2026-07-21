import { module, test } from 'qunitx';
import * as TestFilePaths from '../../lib/setup/test-file-paths.ts';

module('Setup | TestFilePaths.setup', { concurrency: true }, () => {
  // Every dropped entry below is dropped because a broader sibling already covers it:
  // tmp/vendor by tmp, vendor-*/files by vendor-*, tests/**/something/*-test.ts by
  // tests/**/*.ts. The survivors are the widest inputs that between them cover the rest.
  test('drops any input already covered by a broader sibling path or glob', (assert) => {
    const projectRoot = '/home/izelnakri/Github/qunitx';

    assert.deepEqual(
      TestFilePaths.setup([
        `${projectRoot}/tmp`,
        `${projectRoot}/tmp/vendor`,
        `${projectRoot}/another/first/*`,
        `${projectRoot}/another/first/something/helpers`,
        `${projectRoot}/tmp/build-*`,
        `${projectRoot}/vendor`,
        `${projectRoot}/vendor-*`,
        `${projectRoot}/vendor-*/files`,
        `${projectRoot}/tests/**/something/*-test.ts`,
        `${projectRoot}/tests/**/*.ts`,
        `${projectRoot}/assets/something-test.ts`,
        `${projectRoot}/assets/*-test.js`,
        `${projectRoot}/tmp/build-*/*-test.ts`,
        `${projectRoot}/vendor/*-test.js`,
      ]),
      [
        `${projectRoot}/tmp`,
        `${projectRoot}/another/first/*`,
        `${projectRoot}/vendor`,
        `${projectRoot}/vendor-*`,
        `${projectRoot}/tests/**/*.ts`,
        `${projectRoot}/assets/*-test.js`,
        `${projectRoot}/assets/something-test.ts`,
      ],
    );
  });
});
