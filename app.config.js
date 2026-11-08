const fs = require('fs');
const path = require('path');

/**
 * FCM is optional. Android uses google-services.json; iOS uses
 * GoogleService-Info.plist and APNs via Firebase Messaging. Keep credentials
 * outside the repository and omit push configuration from builds that lack it.
 */
function withFirebase(config, androidFile, iosFile) {
  const next = { ...config };
  if (fs.existsSync(path.join(__dirname, androidFile))) {
    next.android = { ...config.android, googleServicesFile: `./${androidFile}` };
  }
  if (fs.existsSync(path.join(__dirname, iosFile))) {
    const profile = process.env.EAS_BUILD_PROFILE;
    const apsEnvironment = process.env.SALCARA_APS_ENVIRONMENT
      ?? (profile ? (profile === 'development' ? 'development' : 'production') : 'development');
    if (apsEnvironment !== 'development' && apsEnvironment !== 'production') {
      throw new Error('SALCARA_APS_ENVIRONMENT must be development or production.');
    }
    next.ios = {
      ...config.ios,
      googleServicesFile: `./${iosFile}`,
      entitlements: { ...config.ios?.entitlements, 'aps-environment': apsEnvironment },
    };
  }
  return next;
}

/** The default build remains exactly the app.json configuration plus configured Firebase. */
module.exports = ({ config }) => {
  if (process.env.SALCARA_TEST_BUILD !== '1') {
    return withFirebase(config, 'google-services.json', 'GoogleService-Info.plist');
  }

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
  }, 'google-services.remotetest.json', 'GoogleService-Info.remotetest.plist');
};
