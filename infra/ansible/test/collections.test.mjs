import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

test('ansible-core version is exactly 2.20.1', () => {
  const output = execSync('ansible --version', { encoding: 'utf-8' });
  const match = output.match(/ansible\s+\[core\s+([\d.]+)\]/);
  assert(match, 'Could not parse ansible --version output');
  const version = match[1];
  assert.equal(version, '2.20.1', `ansible-core version is ${version}, expected 2.20.1`);
});

test('all required collections are installed at pinned versions', () => {
  // Parse requirements.yml
  const requirementsPath = resolve(__dirname, '../../ansible/requirements.yml');
  const requirementsContent = readFileSync(requirementsPath, 'utf-8');
  const requirements = parse(requirementsContent);

  const requiredCollections = {};
  for (const collection of requirements.collections) {
    requiredCollections[collection.name] = collection.version;
  }

  // Get installed collections
  const output = execSync('ansible-galaxy collection list --format json', {
    encoding: 'utf-8'
  });
  const pathsData = JSON.parse(output);

  // Flatten the nested structure from ansible-galaxy collection list
  const installedCollections = {};
  for (const pathData of Object.values(pathsData)) {
    Object.assign(installedCollections, pathData);
  }

  // Check each required collection
  for (const [name, wantedVersion] of Object.entries(requiredCollections)) {
    assert(installedCollections[name], `Collection ${name} not installed`);
    const foundVersion = installedCollections[name].version;
    assert.equal(
      foundVersion,
      wantedVersion,
      `Collection ${name}: wanted ${wantedVersion}, found ${foundVersion}`
    );
  }
});
