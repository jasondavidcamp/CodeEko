import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('public extension identifiers consistently use EKOD', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(manifest.name, 'ekod');
  assert.equal(manifest.displayName, 'EKOD');
  assert.equal(manifest.publisher, 'jasondavidcamp');
  for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(key.startsWith('ekod.'), key);
  for (const command of manifest.contributes.commands) assert.ok(command.command.startsWith('ekod.'), command.command);
  for (const containers of Object.values(manifest.contributes.viewsContainers) as any[][]) {
    for (const container of containers) assert.equal(container.id, 'ekod');
  }
  assert.deepEqual(Object.keys(manifest.contributes.views), ['ekod']);
  for (const view of manifest.contributes.views.ekod) assert.ok(view.id.startsWith('ekod.'), view.id);
  for (const event of manifest.activationEvents) assert.ok(event === 'onStartupFinished' || /^on(?:Command|View):ekod\./.test(event), event);
});
