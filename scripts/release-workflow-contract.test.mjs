import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('real bash version step writes the complete stable tag and fails closed on read/format errors', () => {
  const section = workflow.match(/name: Resolve artifact version[^\r\n]*\r?\n[\s\S]*?run: \|\r?\n((?: {10}[^\r\n]*\r?\n)+)/);
  assert.ok(section, 'version output must be a separate fail-closed shell block');
  const script = section[1].replace(/^ {10}/gm, '');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  assert.ok(process.platform !== 'win32' || existsSync(bash), 'Git Bash is required for the release shell regression');
  for (const [input, expectedStatus] of [['{"version":"1.8.0"}', 0], ['invalid JSON', 1], ['{"version":"1.8.0-test.1"}', 1]]) {
    const fixture = mkdtempSync(join(tmpdir(), 'salcara-release-version-test-'));
    try {
      writeFileSync(join(fixture, 'package.json'), input);
      const output = join(fixture, 'github-output');
      const result = spawnSync(bash, ['-c', script], {cwd:fixture,encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:output.replaceAll('\\','/')}});
      assert.equal(result.error, undefined);
      if (expectedStatus === 0) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), 'tag=v1.8.0\n');
      } else {
        assert.notEqual(result.status, 0, 'bad version/read must not publish tag=v');
        assert.equal(existsSync(output), false);
      }
    } finally {
      // Explicit newly created fixture, never a repository/user-data path.
      rmSync(fixture, {recursive:true,force:true});
    }
  }
});
