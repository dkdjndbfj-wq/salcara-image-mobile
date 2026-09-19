import { readFileSync } from 'node:fs';

const app = JSON.parse(readFileSync('app.json', 'utf8')).expo;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

if (app.version !== pkg.version) {
  throw new Error(`app.json version ${app.version} does not match package.json version ${pkg.version}`);
}
if (!Number.isInteger(app.android?.versionCode) || app.android.versionCode <= 0) {
  throw new Error('android.versionCode must be a positive integer');
}
if (app.android?.package !== 'top.salcara.image') {
  throw new Error(`Unexpected Android package: ${app.android?.package}`);
}

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${app.version}`) {
  throw new Error(`Release tag ${tag} must match app version v${app.version}`);
}

console.log(`Release metadata OK: top.salcara.image ${app.version} (${app.android.versionCode})`);
