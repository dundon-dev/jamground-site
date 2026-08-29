/* Invariant: the name and port roles/nginx routes webhook deliveries to are the name and port
 * roles/webhook actually listens on.
 *
 * WHY THIS EXISTS RATHER THAN A SHARED VARIABLE. The two roles cannot share one. roles/nginx
 * converges BEFORE roles/webhook (infra/ansible/site.yml), and a role's defaults are not loaded
 * until that role runs — so `webhook_port` is not merely fragile inside nginx's template, it is
 * undefined, and Jinja would render the proxy_pass line with an empty port. The tree's answer to
 * a value two roles both need is to repeat it as a literal in each (nginx_previews_root and
 * isolation_previews_root are the standing example), and its answer to a repeated literal is to
 * GATE it rather than to promise it — which is exactly what group_vars/all.yml says about
 * tools/check-config.mjs holding its six against jamground.config.mjs's six.
 *
 * WHY IT IS WORTH GATING AT ALL. This is a first hop with no failure signal on the box. If the
 * port drifts, nginx still starts, `nginx -t` still passes, the receiver still runs, the webhook
 * is still registered, and every delivery gets a 502 that only GitHub's delivery log records —
 * which is a shape this pipeline has already been in once, with a 405 instead of a 502, for the
 * whole of its existence up to the commit that added the vhost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NGINX_DEFAULTS = join(ROOT, 'infra/ansible/roles/nginx/defaults/main.yml');
const WEBHOOK_DEFAULTS = join(ROOT, 'infra/ansible/roles/webhook/defaults/main.yml');
const NGINX_TEMPLATE = join(ROOT, 'infra/ansible/roles/nginx/templates/nginx.conf.j2');

const read = (path) => YAML.parse(readFileSync(path, 'utf8'));

/** Expands `{{ name }}` against a role's OWN defaults only, repeatedly. Anything left over — a
 *  group_vars name such as `jamground_domain` — is deliberately left as the literal `{{ … }}`
 *  text, because both roles reach it through group_vars and comparing the unexpanded reference is
 *  what proves they reach the same one. */
function expand(raw, vars) {
  let out = String(raw);
  for (let i = 0; i < 10 && out.includes('{{'); i += 1) {
    const next = out.replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
      (whole, name) => (name in vars ? String(vars[name]) : whole),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

test('nginx proxies webhook deliveries to the port the receiver listens on', () => {
  const nginx = read(NGINX_DEFAULTS);
  const webhook = read(WEBHOOK_DEFAULTS);

  assert.equal(nginx.nginx_hooks_port, webhook.webhook_port,
    `${relative(ROOT, NGINX_DEFAULTS)} proxies to port ${nginx.nginx_hooks_port} and `
    + `${relative(ROOT, WEBHOOK_DEFAULTS)} listens on ${webhook.webhook_port}. Nothing on the box `
    + 'reports that mismatch: nginx starts, `nginx -t` passes, the receiver runs, and every real '
    + 'delivery gets a 502 that only GitHub\'s delivery log ever sees.');
});

test('nginx serves the same name the webhook is registered against', () => {
  const nginx = read(NGINX_DEFAULTS);
  const webhook = read(WEBHOOK_DEFAULTS);

  assert.equal(expand(nginx.nginx_hooks_domain, nginx), expand(webhook.webhook_domain, webhook),
    `${relative(ROOT, NGINX_DEFAULTS)} serves ${JSON.stringify(nginx.nginx_hooks_domain)} and `
    + `${relative(ROOT, WEBHOOK_DEFAULTS)} registers GitHub's webhook against `
    + `${JSON.stringify(webhook.webhook_domain)}. A delivery to a name no server block matches `
    + 'falls through to the default server, which answers 405 to a POST — the receiver never '
    + 'sees it, and the queue it writes stays empty and looks healthy.');
});

test('the nginx template actually uses those two values', () => {
  const template = readFileSync(NGINX_TEMPLATE, 'utf8');

  assert.match(template, /server_name \{\{ nginx_hooks_domain \}\};/,
    `${relative(ROOT, NGINX_TEMPLATE)} declares no server block for nginx_hooks_domain, so the `
    + 'two tests above are comparing values nothing renders.');
  assert.match(template, /proxy_pass http:\/\/127\.0\.0\.1:\{\{ nginx_hooks_port \}\};/,
    `${relative(ROOT, NGINX_TEMPLATE)} does not proxy to nginx_hooks_port.`);
  // Both halves: port 80 for the ACME/HTTP path and 443 under the certificate guard, the same
  // pairing every other vhost in this file ships.
  assert.equal((template.match(/server_name \{\{ nginx_hooks_domain \}\};/g) ?? []).length, 2,
    `${relative(ROOT, NGINX_TEMPLATE)} must serve the hooks name on both 80 and 443 — GitHub is `
    + 'configured with an https:// URL, and the plain-80 block is what the other vhosts here all '
    + 'carry alongside it.');
});
