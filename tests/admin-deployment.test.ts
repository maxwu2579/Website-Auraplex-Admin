import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ADMIN_SIGNED_OUT_PATH } from '../lib/admin/admin-routes';

// Static checks on the deployment configuration: the values Friendy confirmed
// are wired in, no secret value is committed, and the items that are still
// open stay visibly open. Nothing here contacts a real service.

const ROOT = process.cwd();
// Line endings are normalised so the checks do not depend on the checkout.
const read = (...segments: string[]) =>
  readFileSync(join(ROOT, ...segments), 'utf8').replace(/\r\n/g, '\n');
const exists = (...segments: string[]) => existsSync(join(ROOT, ...segments));

const PRODUCTION_HOST = 'admin-auraplex.auraplex.info';
const STAGING_HOST = 'admin-auraplex-staging.auraplex.info';
const ISSUER = 'https://keycloak.auraplex.info/realms/auraplex';
const CLIENT_ID = 'auraplex-admin-upload';
const VAULT_PATH = 'kv/auraplex/admin-upload/keycloak_client_secret';

const job = read('deploy', 'admin.nomad.hcl');
/** The job file without its comments: only what Nomad would read. */
const jobConfig = job.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
const deploymentDoc = read('docs', 'deployment', 'AURAPLEX-ADMIN-deployment.md');
const envExample = read('.env.example');

/** The body of the first `name { ... }` block, matched by brace depth. */
function block(source: string, name: RegExp): string {
  const match = name.exec(source);
  assert.ok(match, `no block matching ${name}`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unterminated block ${name}`);
}

const INTERNAL_PORT = 3000;

/**
 * Problems with how a job serves the confirmed internal application port.
 * Only the internal port is confirmed, so the host port is not constrained:
 * it may be static with any number, or dynamic. What must be 3000 is the
 * port the application listens on (`PORT`) and the port the `http` label
 * delivers traffic to: its `to` target or, when there is no `to`, the static
 * port itself, which is then also the port inside the task. No network mode
 * is assumed.
 */
function internalPortProblems(config: string): string[] {
  const problems: string[] = [];
  const appPort = /\bPORT\s*=\s*"([^"]*)"/.exec(block(config, /\benv\s*\{/))?.[1];
  if (appPort !== String(INTERNAL_PORT)) problems.push(`PORT is ${appPort ?? 'not set'}`);

  const port = block(config, /\bport "http"\s*\{/);
  const number = (key: string) => {
    const value = new RegExp(`\\b${key}\\s*=\\s*(\\d+)`).exec(port)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const target = number('to') ?? number('static');
  if (target !== INTERNAL_PORT) problems.push(`the http port delivers to ${target ?? 'an unspecified port'}`);
  return problems;
}

/**
 * Problems with the single-instance policy, as far as a static read of the
 * job can tell. An `update` block is allowed, and so is `auto_promote`, which
 * has nothing to promote while `canary` is 0. These checks reject settings
 * that ask for more than one allocation; they do not prove that two
 * allocations can never overlap during an update or a reschedule.
 */
function singleInstanceProblems(config: string): string[] {
  const problems: string[] = [];
  const counts = [...config.matchAll(/\bcount\s*=\s*(\S+)/g)].map((match) => match[1]);
  if (counts.length !== 1 || counts[0] !== '1') problems.push(`count is ${counts.join(', ') || 'not set'}`);
  if (/\bscaling\b/.test(config)) problems.push('a scaling block is present');
  for (const canary of config.matchAll(/\bcanary\s*=\s*(\d+)/g)) {
    if (Number(canary[1]) > 0) problems.push(`canary = ${canary[1]}`);
  }
  for (const parallel of config.matchAll(/\bmax_parallel\s*=\s*(\d+)/g)) {
    if (Number(parallel[1]) > 1) problems.push(`max_parallel = ${parallel[1]}`);
  }
  return problems;
}

/** A minimal job for the regression cases below. It is never submitted anywhere. */
function sampleJob(options: { count?: number; network?: string; appPort?: string; group?: string } = {}): string {
  return [
    'job "sample" {',
    '  group "web" {',
    `    count = ${options.count ?? 1}`,
    options.group ?? '',
    '    network {',
    options.network ?? '      port "http" { static = 3000 }',
    '    }',
    '    task "next" {',
    '      env {',
    `        PORT = "${options.appPort ?? '3000'}"`,
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

test('the Nomad job carries the confirmed deployment identity', () => {
  assert.match(jobConfig, /^job "admin-upload" \{$/m);
  assert.match(jobConfig, /^\s*datacenters = \["acumen-local"\]$/m);
  assert.match(jobConfig, /^\s*group "web" \{$/m);
  assert.match(jobConfig, /^\s*count = 1$/m);

  const constraint = block(jobConfig, /\bconstraint\s*\{/);
  assert.match(constraint, /attribute\s*=\s*"\$\{node\.unique\.name\}"/);
  assert.match(constraint, /value\s*=\s*"auraplex01"/);

  assert.match(block(jobConfig, /\bconfig\s*\{/), /image\s*=\s*"auraplex\.local\/admin-upload:v1"/);

  const resources = block(jobConfig, /\bresources\s*\{/);
  assert.match(resources, /cpu\s*=\s*500\b/);
  assert.match(resources, /memory\s*=\s*512\b/);

  const service = block(jobConfig, /\bservice\s*\{/);
  assert.match(service, /name\s*=\s*"admin-upload"/);
  assert.match(service, /provider\s*=\s*"consul"/);
});

test('the Nomad job serves and health-checks the confirmed internal port', () => {
  assert.deepEqual(internalPortProblems(jobConfig), []);

  // The service and its check follow the port label, whatever it maps to.
  const service = block(jobConfig, /\bservice\s*\{/);
  const check = block(service, /\bcheck\s*\{/);
  assert.match(service, /^\s*port\s*=\s*"http"$/m);
  assert.match(check, /type\s*=\s*"http"/);
  assert.match(check, /path\s*=\s*"\/api\/health"/);
  assert.match(check, /port\s*=\s*"http"/);
});

test('the port check constrains the internal port, not the host port', () => {
  const valid: Record<string, string> = {
    'static host port equal to the internal port': '      port "http" { static = 3000 }',
    'a different static host port mapped to 3000': '      port "http" {\n        static = 3100\n        to     = 3000\n      }',
    'a dynamic host port mapped to 3000': '      port "http" {\n        to = 3000\n      }',
    'host networking stated explicitly': '      mode = "host"\n      port "http" { static = 3000 }',
    'bridge networking stated explicitly': '      mode = "bridge"\n      port "http" { to = 3000 }',
  };
  for (const [name, network] of Object.entries(valid)) {
    assert.deepEqual(internalPortProblems(sampleJob({ network })), [], name);
  }

  const invalid: Record<string, Parameters<typeof sampleJob>[0]> = {
    'a mapping whose target is not 3000': { network: '      port "http" {\n        static = 3000\n        to     = 8080\n      }' },
    'a dynamic host port whose target is not 3000': { network: '      port "http" { to = 3100 }' },
    'a static port other than 3000 with no target': { network: '      port "http" { static = 3100 }' },
    'a dynamic port with no target': { network: '      port "http" {}' },
    'an application port other than 3000': { appPort: '3100', network: '      port "http" { to = 3000 }' },
  };
  for (const [name, options] of Object.entries(invalid)) {
    assert.notDeepEqual(internalPortProblems(sampleJob(options)), [], name);
  }
});

test('the Nomad job sets the confirmed non-secret environment', () => {
  const env = block(jobConfig, /\benv\s*\{/);
  assert.match(env, new RegExp(`AUTH_URL\\s*=\\s*"https://${PRODUCTION_HOST.replaceAll('.', '\\.')}"`));
  assert.ok(env.includes(`"${ISSUER}"`));
  assert.match(env, new RegExp(`KEYCLOAK_CLIENT_ID\\s*=\\s*"${CLIENT_ID}"`));
});

test('no confirmed field is still a placeholder', () => {
  assert.doesNotMatch(job, /CHANGE_ME/);
  assert.equal(exists('deploy', 'admin.nomad.hcl.example'), false);
});

test('the Nomad job asks for one instance, with no scaling and no canaries', () => {
  assert.deepEqual(singleInstanceProblems(jobConfig), []);
});

test('the single-instance check allows a safe update block and rejects extra allocations', () => {
  const update = (...settings: string[]) => ['    update {', ...settings.map((line) => `      ${line}`), '    }'].join('\n');

  const valid: Record<string, Parameters<typeof sampleJob>[0]> = {
    'no update block': {},
    'canary = 0, max_parallel = 1, auto_promote = true': {
      group: update('canary       = 0', 'max_parallel = 1', 'auto_promote = true'),
    },
    'auto_promote = true on its own': { group: update('auto_promote = true') },
    'an update block with health timings only': { group: update('min_healthy_time = "10s"', 'healthy_deadline = "5m"') },
  };
  for (const [name, options] of Object.entries(valid)) {
    assert.deepEqual(singleInstanceProblems(sampleJob(options)), [], name);
  }

  const invalid: Record<string, Parameters<typeof sampleJob>[0]> = {
    'canary > 0': { group: update('canary = 1') },
    'canary > 0 with auto_promote': { group: update('canary = 1', 'auto_promote = true') },
    'count > 1': { count: 2 },
    'max_parallel > 1': { group: update('max_parallel = 2') },
    'a scaling block': { group: '    scaling {\n      min = 1\n      max = 3\n    }' },
  };
  for (const [name, options] of Object.entries(invalid)) {
    assert.notDeepEqual(singleInstanceProblems(sampleJob(options)), [], name);
  }
});

test('the single-instance and host-port limits are documented as open', () => {
  assert.match(deploymentDoc, /\| 8 \| Host port and network mapping \| Confirmed: the application listens on internal port 3000\. Not confirmed:/);
  assert.match(deploymentDoc, /\| 12 \| Overlap during job updates \| `count = 1` does not by itself rule out/);
  assert.match(job, /count = 1 limits the steady state only/);
  assert.match(job, /TODO\(unresolved\): host port \/ network mapping/);
});

test('the Nomad job holds no secret value and does not guess the Vault wiring', () => {
  for (const name of ['KEYCLOAK_CLIENT_SECRET', 'AUTH_SECRET', 'MINIO_SECRET_KEY', 'MINIO_ACCESS_KEY', 'QDRANT_API_KEY']) {
    assert.equal(jobConfig.includes(name), false, name);
  }
  assert.doesNotMatch(jobConfig, /\b(?:vault|template|nomadVar|secret)\b/i);
  // The secret is referenced by its Vault path, in a comment, as an open item.
  assert.ok(job.includes(VAULT_PATH));
  assert.match(job, /TODO\(unresolved\): runtime secret injection/);
});

test('the Nomad job is marked as a draft that must not be submitted', () => {
  assert.match(job, /NOT PRODUCTION-READY — DO NOT SUBMIT THIS FILE TO NOMAD/);
  // It says the prohibition is not a technical lock and that the health
  // check passes without secrets, and it does not claim to be disabled.
  assert.match(job, /This is a prohibition, not a technical lock/);
  assert.match(job, /Nomad may accept it and\n# schedule the job/);
  assert.match(job, /GET \/api\/health answers 200/);
  assert.match(job, /^# Deployment blockers/m);
  assert.match(deploymentDoc, /^### The Nomad job draft$/m);
});

test('the documentation does not describe anything as deployed', () => {
  assert.doesNotMatch(envExample, /\bDeployed\b/);
  assert.match(deploymentDoc, /no production deployment and no\nstaging deployment/);
  assert.match(deploymentDoc, /\| `AUTH_URL` \(staging\) \| `https:\/\/admin-auraplex-staging\.auraplex\.info` \| no; documented only, no staging job exists \|/);
  // The staging hostname is not wired into the production job.
  assert.equal(job.includes(STAGING_HOST), false);
});

test('the environment template commits no value for any variable', () => {
  const assignments = envExample.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
  assert.ok(assignments.length > 0);
  for (const line of assignments) assert.match(line, /^[A-Z][A-Z0-9_]*=$/, line);
});

test('the confirmed hostnames, issuer, client and secret path are documented', () => {
  for (const text of [deploymentDoc, envExample]) {
    assert.ok(text.includes(`https://${PRODUCTION_HOST}`));
    assert.ok(text.includes(`https://${STAGING_HOST}`));
    assert.ok(text.includes(ISSUER));
    assert.ok(text.includes(CLIENT_ID));
    assert.ok(text.includes(VAULT_PATH));
  }
  assert.match(deploymentDoc, /^## D\. Confirmed deployment values$/m);
  assert.match(deploymentDoc, /^## E\. Unresolved$/m);
  assert.match(deploymentDoc, /Node → APISIX → Cloudflare Tunnel/);
  assert.match(deploymentDoc, /\| Production \| `admin-auraplex\.auraplex\.info` \| Consul service `admin-upload`, internal port `3000` \|/);
});

test('the disputed callback and logout URIs are documented as blocked', () => {
  const start = deploymentDoc.indexOf('### Keycloak callback and logout URIs — BLOCKED');
  assert.notEqual(start, -1);
  const section = deploymentDoc.slice(start, deploymentDoc.indexOf('\n### ', start + 1));
  assert.match(section, /BLOCKED \/ awaiting Friendy confirmation/);
  for (const host of [PRODUCTION_HOST, STAGING_HOST]) {
    for (const path of ['/api/auth/callback', '/api/auth/logout', '/api/auth/callback/keycloak', '/signed-out']) {
      assert.ok(section.includes(`\`https://${host}${path}\``), `${host}${path}`);
    }
  }
});

test('the disputed callback and logout routes are unchanged in the application', () => {
  // Auth.js still owns /api/auth/*; no hand-written callback or logout route exists.
  assert.equal(exists('app', 'api', 'auth', '[...nextauth]', 'route.ts'), true);
  assert.equal(exists('app', 'api', 'auth', 'callback'), false);
  assert.equal(exists('app', 'api', 'auth', 'logout'), false);
  // Logout still returns to the signed-out page.
  assert.equal(ADMIN_SIGNED_OUT_PATH, '/signed-out');
  const logout = read('lib', 'admin', 'server', 'keycloak-logout.ts');
  assert.match(logout, /post_logout_redirect_uri/);
  assert.match(logout, /ADMIN_SIGNED_OUT_PATH/);
  assert.doesNotMatch(logout, /api\/auth\/logout/);
  // Neither disputed URI is configured anywhere a deployment would read it.
  for (const text of [jobConfig, envExample]) {
    assert.doesNotMatch(text, /\/api\/auth\/(?:callback|logout)/);
  }
});

test('the final upload cap is left open and not set by the job', () => {
  assert.equal(jobConfig.includes('ADMIN_UPLOAD_MAX_MB'), false);
  assert.match(deploymentDoc, /\| 1 \| Final production upload cap \| Not decided\./);
});

test('.dockerignore keeps local environment files out of the build context', () => {
  const lines = read('.dockerignore').split('\n').map((line) => line.trim());
  for (const pattern of ['.env', '.env.*', '!.env.example', 'node_modules', '.next', '.git']) {
    assert.ok(lines.includes(pattern), pattern);
  }
  // A later pattern wins, so the template exception must follow the exclusion.
  assert.ok(lines.indexOf('!.env.example') > lines.indexOf('.env.*'));
  // Nothing the install or the build needs is excluded.
  for (const needed of ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'app', 'lib', 'public']) {
    assert.equal(lines.includes(needed), false, needed);
  }
});

test('the image still runs as the unprivileged node user', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^USER node$/m);
  assert.equal([...dockerfile.matchAll(/^COPY --from=builder --chown=node:node /gm)].length, 3);
});
