/**
 * check-config, watched failing on each defect it exists to prevent.
 *
 * The gate's whole value is that two declarations of the deployment's identity cannot drift
 * apart, and that no piece of the reference deployment's identity survives a fork. Neither is
 * observable from a green run, so both are watched failing here rather than trusted.
 *
 * Every defect is planted into a FIXTURE tree (`test/tools/fixtures/config/`) and removed
 * again in a `finally`, the same shape check-playbooks.test.mjs already uses, so a failing
 * assertion cannot leave the real repository dirty.
 *
 * The retired literals are IMPORTED from the tool rather than written here. Repeating them
 * would make this file a file full of retired literals, which Rule B would then have to be
 * taught to ignore — the gate's own test becoming the second exemption is exactly the erosion
 * this arrangement avoids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { RETIRED_LITERALS, SHARED_VALUES } from '../../tools/check-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TREE = 'test/tools/fixtures/config';
const SRC = join(ROOT, TREE, 'src/app.mjs');
const NOTES = join(ROOT, TREE, 'NOTES.md');
const CONFIG_JS = join(ROOT, TREE, 'jamground.config.mjs');
const GROUP_VARS = join(ROOT, TREE, 'infra/ansible/group_vars/all.yml');

const check = () => {
  try {
    return { code: 0, json: JSON.parse(execFileSync('node', [join(ROOT, 'tools/check-config.mjs'), '--root', TREE, '--json'], { cwd: ROOT, encoding: 'utf8' })) };
  } catch (e) {
    return { code: e.status, json: e.stdout ? JSON.parse(e.stdout) : null };
  }
};

/** Rewrites `file` for the duration of `fn`, then restores it byte for byte. */
const planted = (file, rewrite, fn) => {
  const before = readFileSync(file, 'utf8');
  try { writeFileSync(file, rewrite(before)); fn(check()); }
  finally { writeFileSync(file, before); }
};

const rules = (json) => json.problems.map((p) => p.rule);

test('the fixture tree is clean to begin with', () => {
  // Without this the planted defects prove nothing: a checker that reports everything as
  // broken catches every defect and is useless.
  const { code, json } = check();
  assert.equal(code, 0, JSON.stringify(json?.problems, null, 2));
  assert.equal(json.problems.length, 0);
});

// ── Rule A ───────────────────────────────────────────────────────────────────────────────

test('Rule A: a value that drifts between the build and the converge is caught', () => {
  // The failure this rule exists for. Nothing else in the tree fails on it: the site would
  // build for one domain and the box would be converged for another, each half internally
  // consistent, and the first symptom would be a live site nobody can reach.
  planted(GROUP_VARS, (s) => s.replace('jamground_domain: example.com', 'jamground_domain: example.org'), ({ code, json }) => {
    assert.equal(code, 1);
    assert.deepEqual(rules(json), ['config-drift']);
    assert.equal(json.problems[0].key, 'domain');
    assert.equal(json.problems[0].build, 'example.com');
    assert.equal(json.problems[0].deploy, 'example.org');
  });
});

test('Rule A: drift is caught on every one of the six, not just the domain', () => {
  // A rule keyed on one well-known value would pass a fork that changed its org and forgot
  // the converge. Each pair is planted in turn.
  for (const { js, yaml } of SHARED_VALUES) {
    const before = readFileSync(GROUP_VARS, 'utf8');
    const line = before.split('\n').find((l) => l.startsWith(`${yaml}:`));
    assert.ok(line, `the fixture should declare ${yaml}`);
    planted(GROUP_VARS, (s) => s.replace(line, `${yaml}: drifted-value`), ({ code, json }) => {
      assert.equal(code, 1, `${yaml} drift should be caught`);
      assert.deepEqual(rules(json), ['config-drift']);
      assert.equal(json.problems[0].key, js);
      assert.equal(json.problems[0].deploy, 'drifted-value');
    });
  }
});

test('Rule A: a value declared on only one side is caught, not silently skipped', () => {
  // The quieter half of drift: a fork adds a value to the module and forgets group_vars, or
  // deletes one from group_vars. Comparing only the keys present on both sides would report
  // agreement about a value nobody declared.
  planted(GROUP_VARS, (s) => s.split('\n').filter((l) => !l.startsWith('jamground_github_org:')).join('\n'), ({ code, json }) => {
    assert.equal(code, 1);
    assert.deepEqual(rules(json), ['config-missing-deploy']);
    assert.equal(json.problems[0].key, 'jamground_github_org');
  });
});

test('Rule A: a build-time module that does not resolve is a "could not run", not a pass', () => {
  // Exit 3, never 0. A module that fails to import proves nothing about agreement, and
  // reporting that as clean is the shape of false green this whole gate is built against.
  const before = readFileSync(CONFIG_JS, 'utf8');
  try {
    writeFileSync(CONFIG_JS, 'export const domain = ;');
    const { code, json } = check();
    assert.equal(code, 3);
    assert.equal(json.ok, false);
    assert.match(json.fatal, /could not be imported/);
  } finally {
    writeFileSync(CONFIG_JS, before);
  }
});

test('Rule A: a missing deploy-time declaration file is a "could not run", not a pass', () => {
  const before = readFileSync(GROUP_VARS, 'utf8');
  try {
    unlinkSync(GROUP_VARS);
    const { code, json } = check();
    assert.equal(code, 3);
    assert.match(json.fatal, /group_vars\/all\.yml does not exist/);
  } finally {
    writeFileSync(GROUP_VARS, before);
  }
});

// ── Rule B ───────────────────────────────────────────────────────────────────────────────

test('Rule B: every retired literal is caught in a source file', () => {
  // One planting per literal. A gate that knew four of them would pass a tree still carrying
  // the other seven, and would look like it had checked.
  for (const literal of RETIRED_LITERALS) {
    planted(SRC, (s) => `${s}\nexport const planted = ${JSON.stringify(literal)};\n`, ({ code, json }) => {
      assert.equal(code, 1, `${literal} should be caught`);
      assert.ok(rules(json).includes('retired-literal'), `${literal} should be a retired-literal problem`);
      assert.ok(json.problems.some((p) => p.literal === literal), `${literal} should be named in the report`);
      assert.ok(json.problems.every((p) => p.file === 'src/app.mjs'), JSON.stringify(json.problems));
    });
  }
});

test('Rule B: the bare apex survives a naive rename of the long host, and is still caught', () => {
  // The specific trap: one retired literal is a proper SUFFIX of another, so a
  // search-and-replace of the longer one looks like a complete migration and leaves the
  // shorter one behind wherever it was referenced on its own. A gate holding only the longer
  // string would report that tree clean.
  //
  // The pair is found by that structural property rather than written out, because writing
  // it out would put two retired literals in this file and make the gate's own test the
  // second thing exempt from the gate.
  const apex = RETIRED_LITERALS.find((a) => RETIRED_LITERALS.some((b) => b !== a && b.endsWith(a)));
  assert.ok(apex, 'the tool should list a literal that is a suffix of another — that is the trap');
  const longHost = RETIRED_LITERALS.find((b) => b !== apex && b.endsWith(apex));
  assert.ok(longHost, 'and the longer literal it hides inside');

  planted(SRC, (s) => `${s}\n// the zone this used to live in: ${apex}\n`, ({ code, json }) => {
    assert.equal(code, 1);
    const caught = json.problems.map((p) => p.literal);
    assert.deepEqual(caught, [apex], 'the apex alone should be reported, and it should be reported');
  });
});

test('Rule B: the report names the file and the line, so a violation can be found', () => {
  planted(SRC, (s) => `${s}\nconst x = ${JSON.stringify(RETIRED_LITERALS[0])};\n`, ({ json }) => {
    const [problem] = json.problems;
    assert.equal(problem.file, 'src/app.mjs');
    assert.equal(typeof problem.line, 'number');
    const line = readFileSync(SRC, 'utf8').split('\n')[problem.line - 1];
    assert.ok(line.includes(RETIRED_LITERALS[0]), `line ${problem.line} should be the offending line, got: ${line}`);
  });
});

test('Rule B scans Markdown too — a literal planted there turns the gate red', () => {
  // Phase 6 rewrote infra/RUNBOOK.md, the last file carrying these literals in Markdown, and
  // removed MARKDOWN_EXCLUSION along with it. This test used to assert the opposite — that a
  // literal planted in Markdown was NOT a violation — which was the deliberately-asserted hole
  // that made the exclusion impossible to forget. Now that the exclusion is gone, Markdown is
  // just another source file: a retired literal in it is caught exactly like one in src/app.mjs.
  planted(NOTES, (s) => `${s}\nThe old host was ${RETIRED_LITERALS[1]}.\n`, ({ code, json }) => {
    assert.equal(code, 1, 'a retired literal in Markdown IS a violation now');
    assert.ok(rules(json).includes('retired-literal'));
    assert.ok(json.problems.some((p) => p.file === 'NOTES.md' && p.literal === RETIRED_LITERALS[1]));
  });
});

test('the gate never scans itself, and says so rather than hiding it', () => {
  // tools/check-config.mjs necessarily contains all eleven literals. If it were scanned the
  // gate could never be green, and the temptation would be to obfuscate the list instead —
  // which would make the rule unreadable. One named exemption, no others.
  const self = readFileSync(join(ROOT, 'tools/check-config.mjs'), 'utf8');
  for (const literal of RETIRED_LITERALS) {
    assert.ok(self.includes(literal), `the tool should name ${literal} plainly`);
  }
  const { code } = check();
  assert.equal(code, 0);
});
