import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('public extension identifiers consistently use CodeEko', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(manifest.name, 'codeeko');
  assert.equal(manifest.displayName, 'CodeEko');
  assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]*$/i);
  for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(key.startsWith('codeeko.'), key);
  for (const command of manifest.contributes.commands) assert.ok(command.command.startsWith('codeeko.'), command.command);
  for (const containers of Object.values(manifest.contributes.viewsContainers) as any[][]) {
    for (const container of containers) assert.equal(container.id, 'codeeko');
  }
  assert.deepEqual(Object.keys(manifest.contributes.views), ['codeeko']);
  for (const view of manifest.contributes.views.codeeko) assert.ok(view.id.startsWith('codeeko.'), view.id);
  for (const event of manifest.activationEvents) assert.ok(event === 'onStartupFinished' || /^on(?:Command|View):codeeko\./.test(event), event);
});
