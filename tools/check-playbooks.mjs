#!/usr/bin/env node
/**
 * check-playbooks — keep `--check` honest, which is the entire reason Ansible was adopted.
 *
 * The choice of Ansible turns on one advantage: a `--check` derived from the same task
 * definitions as the converge path, so the two cannot silently disagree. That advantage is
 * NOT free, and the way it is lost is specific and quiet.
 *
 * In check mode Ansible **skips** `command`, `shell`, `raw` and `script` tasks. It does not run
 * them, does not evaluate them, and reports them as skipped. A playbook that reaches for
 * `command:` to call certbot, nft or systemctl therefore produces a `--check` that passes while
 * the converge path would still change the box — and it passes while *looking* unified, which is
 * worse than `apply.sh`'s honestly-separate check. This project calls a false green the worst
 * failure available to it; this is the shape that failure takes under the new tool.
 *
 * The rule: any task using one of those four modules must say what it does in check mode, by
 * carrying an explicit `check_mode:` or a `changed_when:`. Both are honest answers —
 * `check_mode: false` runs a read-only command during --check so its result is real, and
 * `changed_when:` declares the change semantics the module cannot infer. Silence is not.
 *
 * It also runs `ansible-playbook --syntax-check`, which is offline: the gate never touches the
 * VPS, and a gate that needs production to be up is not a gate.
 *
 * Usage: node tools/check-playbooks.mjs [--json] [--root DIR]
 * Exit codes: 0 clean · 1 violations found · 3 could not run.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const JSON_MODE = argv.includes('--json');
const rIdx = argv.indexOf('--root');
const ROOT = rIdx >= 0 ? argv[rIdx + 1] : new URL('..', import.meta.url).pathname;

const problems = [];
const bad = (file, message, extra = {}) => problems.push({ file, message, ...extra });
const die = (msg, hint) => {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, fatal: msg, problems: [] }, null, 2));
  else { console.error(msg); if (hint) console.error(`  ${hint}`); }
  process.exit(3);
};

let YAML;
try { YAML = require('yaml'); }
catch (e) { die(`could not load a YAML parser: ${e.message}`, 'run `npm ci` first'); }

const DIR = join(ROOT, 'infra/ansible');
// No playbooks yet is not a violation — a fork's tree might not carry infra/ansible/ at all,
// and until it does there is nothing to gate. It IS reported, so "0 problems" never silently
// means "0 files".
if (!existsSync(DIR)) {
  if (JSON_MODE) console.log(JSON.stringify({ ok: true, playbooks: 0, problems: [] }, null, 2));
  else console.log('ansible — no infra/ansible/ yet, nothing to gate');
  process.exit(0);
}

// Every .yml under infra/ansible/ except the three that are not task files. Roles' tasks/*.yml
// are included deliberately: that is where a `command:` is most likely to hide.
const NOT_TASKS = new Set(['requirements.yml', 'inventory.yml', 'ansible.cfg']);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name);
  if (e.isDirectory()) return walk(p);
  if (!/\.ya?ml$/.test(e.name) || NOT_TASKS.has(e.name)) return [];
  return [p];
});
const files = walk(DIR);

// The four modules check mode skips. Both the short name and the fully-qualified one, because a
// playbook written `ansible.builtin.command:` must not slip past a check keyed on `command:`.
const SKIPPED = ['command', 'shell', 'raw', 'script'];
const isSkipped = (k) => SKIPPED.includes(k) || SKIPPED.includes(k.replace(/^ansible\.builtin\./, ''));

/** Tasks nest: block/rescue/always hold more tasks, and each is checked the same way. */
const walkTasks = (node, file, path = 'tasks') => {
  if (Array.isArray(node)) return node.forEach((t, i) => walkTasks(t, file, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return;

  for (const key of ['block', 'rescue', 'always', 'tasks', 'pre_tasks', 'post_tasks', 'handlers']) {
    if (node[key]) walkTasks(node[key], file, `${path}.${key}`);
  }

  const mod = Object.keys(node).find(isSkipped);
  if (!mod) return;
  if ('check_mode' in node || 'changed_when' in node) return;

  const name = node.name ? `"${node.name}"` : path;
  bad(relative(ROOT, file), `${name} uses \`${mod}:\` with neither \`check_mode:\` nor `
    + `\`changed_when:\`. Check mode SKIPS this module, so \`--check\` would report converged while `
    + `the converge path would still change the box — a false green, and one that looks unified. `
    + `Say what it does in check mode: \`check_mode: false\` if it is read-only and safe to run `
    + `during a check, or \`changed_when:\` to declare the change semantics the module cannot infer.`,
    { rule: 'check-mode-unstated', path: `${mod} in ${name}` });
};

for (const f of files) {
  let doc;
  try { doc = YAML.parse(readFileSync(f, 'utf8')); }
  catch (e) { bad(relative(ROOT, f), `is not parseable YAML: ${e.message}`, { rule: 'playbook-unparseable' }); continue; }
  if (doc) walkTasks(doc, f);
}

// ---------------------------------------------------------------------------------------------
// Syntax. Offline — `--syntax-check` parses and resolves; it opens no connection to the box.
// ---------------------------------------------------------------------------------------------
const which = spawnSync('ansible-playbook', ['--version'], { encoding: 'utf8' });
if (which.error) {
  die('ansible-playbook is not on PATH, so the syntax half of this gate could not run.',
    'ansible-core is a prerequisite of `npm run test:infra`, not of `npm test`. `brew install ansible`.');
}
const core = (which.stdout.match(/ansible-playbook \[core ([\d.]+)\]/) ?? [])[1] ?? 'unknown';

const plays = files.filter((f) => {
  try { const d = YAML.parse(readFileSync(f, 'utf8')); return Array.isArray(d) && d.some((p) => p && (p.hosts || p.import_playbook)); }
  catch { return false; }
});
for (const f of plays) {
  const r = spawnSync('ansible-playbook', ['--syntax-check', relative(ROOT, f)], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    bad(relative(ROOT, f), `fails \`ansible-playbook --syntax-check\`: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`,
      { rule: 'playbook-syntax' });
  }
}

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: problems.length === 0, core, playbooks: files.length, plays: plays.length, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}
if (!problems.length) {
  console.log(`ansible — ${files.length} task file${files.length === 1 ? '' : 's'}, ${plays.length} playbook${plays.length === 1 ? '' : 's'} syntax-checked, core ${core}`);
  process.exit(0);
}
console.error(`${problems.length} playbook problem${problems.length === 1 ? '' : 's'}:`);
for (const p of problems) console.error(`  ${p.file}: ${p.message}`);
process.exit(1);
