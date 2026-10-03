const fs = require('fs');
const path = require('path');

/**
 * Firebase (push while the app is closed) is used only when its config file is
 * present: google-services.json for the normal app, google-services.remotetest.json
 * for the remote test build. Without it the build is unchanged and phones fall
 * back to 后台待命.
 */
function withFirebase(config, file) {
  if (!fs.existsSync(path.join(__dirname, file))) return config;
  return { ...config, android: { ...config.android, googleServicesFile: `./${file}` } };
}

/** The default build remains exactly the app.json configuration (plus Firebase when configured). */
module.exports = ({ config }) => {
  if (process.env.SALCARA_TEST_BUILD !== '1') return withFirebase(config, 'google-services.json');

  // The private workflow gets a monotonically increasing range of its own.
  const suppliedBuildNumber = process.env.SALCARA_TEST_BUILD_NUMBER
    ?? (process.env.GITHUB_RUN_NUMBER ? String(100_000 + Number(process.env.GITHUB_RUN_NUMBER)) : undefined);
  const buildNumber = suppliedBuildNumber === undefined
    ? config.android?.versionCode ?? 1
    : Number(suppliedBuildNumber);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1 || buildNumber > 2_100_000_000) {
    throw new Error('SALCARA_TEST_BUILD_NUMBER must be a positive Android versionCode.');
  }

  return withFirebase({
    ...config,
    name: 'Salcara 远程测试',
    slug: 'salcara-remote-test',
    android: {
      ...config.android,
      package: 'top.salcara.image.remotetest',
      versionCode: buildNumber,
    },
    ios: {
      ...config.ios,
      bundleIdentifier: 'top.salcara.image.remotetest',
      buildNumber: String(buildNumber),
    },
    updates: { ...config.updates, enabled: false },
    extra: {
      ...config.extra,
      salcaraBuildChannel: 'remote-test',
      salcaraTestCommit: process.env.GITHUB_SHA ?? 'local',
    },
  }, 'google-services.remotetest.json');
};
