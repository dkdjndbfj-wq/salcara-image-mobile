import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('all production update publications are serialized without cancelling a running release', () => {
  assert.match(workflow, /group: android-release-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('overwrite verification downloads and selects the exact previous production asset', () => {
  assert.match(workflow, /--pattern "salcara-image-android-\$\{previous_tag\}\.apk"/);
  assert.match(workflow, /previous_apk="previous-release\/salcara-image-android-\$\{SALCARA_PREVIOUS_TAG\}\.apk"/);
  assert.match(workflow, /if \[\[ ! -s "\$previous_apk" \]\]/);
  assert.doesNotMatch(workflow, /gh release download[^\n]*--pattern '\*\.apk'/);
  assert.doesNotMatch(workflow, /previous_apk="\$\(find/);
});
