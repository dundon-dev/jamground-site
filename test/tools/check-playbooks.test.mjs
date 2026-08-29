/**
 * check-playbooks, watched failing on the false green it exists to prevent.
 *
 * The choice of Ansible turns on exactly one advantage — a `--check` that cannot silently
 * disagree with the converge path — and that advantage is lost the moment a `command:` task goes
 * undeclared, because check mode skips it and reports converged. The rule is the whole value of
 * the decision, so it is watched failing rather than trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TREE = 'test/tools/fixtures/playbooks';
const TASKS = join(ROOT, TREE, 'infra/ansible/roles/demo/tasks/main.yml');

const check = () => {
  try {
    return { code: 0, json: JSON.parse(execFileSync('node', [join(ROOT, 'tools/check-playbooks.mjs'), '--root', TREE, '--json'], { cwd: ROOT, encoding: 'utf8' })) };
  } catch (e) {
    return { code: e.status, json: e.stdout ? JSON.parse(e.stdout) : null };
  }
};

const planted = (text, fn) => {
  const before = readFileSync(TASKS, 'utf8');
  try { writeFileSync(TASKS, before + text + '\n'); fn(check()); }
  finally { writeFileSync(TASKS, before); }
};

const rules = (json) => json.problems.map((p) => p.rule);

test('the fixture tree is clean to begin with', () => {
  // Without this the planted defects prove nothing: a checker that reports everything as broken
  // catches every defect and is useless.
  const { code, json } = check();
  assert.equal(code, 0, JSON.stringify(json?.problems, null, 2));
});

test('a bare command: is caught', () => {
  planted('- name: Reload nginx\n  ansible.builtin.command: nginx -s reload', ({ code, json }) => {
    assert.equal(code, 1);
    assert.deepEqual(rules(json), ['check-mode-unstated']);
  });
});

test('a shell: nested inside a block is caught', () => {
  // Nesting is where this hides. A rule that only reads the top level of a tasks file would pass
  // this, and `block:` is exactly how a multi-step certbot or nft sequence gets written.
  planted('- name: Issue\n  block:\n    - name: certbot\n      shell: certbot certonly', ({ code, json }) => {
    assert.equal(code, 1);
    assert.deepEqual(rules(json), ['check-mode-unstated']);
    assert.match(json.problems[0].path, /^shell in "certbot"$/);
  });
});

test('the fully-qualified module name does not slip past', () => {
  // `ansible.builtin.shell:` and `shell:` are the same module. A check keyed on the short name
  // alone would let the qualified spelling through, which is the quieter of the two.
  planted('- name: Q\n  ansible.builtin.raw: apt-get update', ({ code, json }) => {
    assert.equal(code, 1);
    assert.deepEqual(rules(json), ['check-mode-unstated']);
  });
});

test('changed_when alone satisfies the rule', () => {
  // Both declarations are honest answers and the gate must accept either, or it teaches people to
  // add the one it wants rather than the one that is true.
  planted('- name: Declared\n  ansible.builtin.command: /usr/bin/true\n  changed_when: false', ({ code }) => {
    assert.equal(code, 0);
  });
});
