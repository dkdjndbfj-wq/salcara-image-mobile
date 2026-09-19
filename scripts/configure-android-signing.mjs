import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const buildFile = resolve('android/app/build.gradle');
let source = readFileSync(buildFile, 'utf8');
const debugBlock = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;

if (!source.includes(debugBlock)) throw new Error('Unable to locate the generated debug signing block.');
source = source.replace(debugBlock, `${debugBlock}
        release {
            storeFile file(System.getenv('SALCARA_KEYSTORE_FILE'))
            storePassword System.getenv('SALCARA_KEYSTORE_PASSWORD')
            keyAlias System.getenv('SALCARA_KEY_ALIAS')
            keyPassword System.getenv('SALCARA_KEY_PASSWORD')
        }`);

const releaseMarker = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
if (!source.includes(releaseMarker)) throw new Error('Unable to locate the generated release signing configuration.');
source = source.replace(releaseMarker, `        release {
            signingConfig signingConfigs.release`);
writeFileSync(buildFile, source);
