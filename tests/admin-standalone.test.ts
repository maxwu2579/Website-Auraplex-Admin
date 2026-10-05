import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

// Structural checks that this repository is the standalone Admin application:
// no copied public-website routes, build steps or dependencies remain.

const ROOT = process.cwd();
// Line endings are normalised so the checks do not depend on the checkout.
const read = (...segments: string[]) =>
  readFileSync(join(ROOT, ...segments), 'utf8').replace(/\r\n/g, '\n');
const exists = (...segments: string[]) => existsSync(join(ROOT, ...segments));

function filesUnder(...segments: string[]): string[] {
  const directory = join(ROOT, ...segments);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const declared = new Set([
  ...Object.keys(packageJson.dependencies),
  ...Object.keys(packageJson.devDependencies),
]);

const SOURCE_ROOTS = ['app', 'components', 'lib'];
const sourceFiles = [
  ...SOURCE_ROOTS.flatMap((root) => filesUnder(root)),
  'auth.ts',
  'proxy.ts',
  'next.config.ts',
].filter((file) => /\.(ts|tsx|mjs|css)$/.test(file));

/** Bare package names imported by a source file (`@scope/name` or `name`). */
function importedPackages(file: string): string[] {
  const packages: string[] = [];
  const pattern = /(?:from\s*|import\s*\(?\s*|require\(\s*|@import\s+)['"]([^'"]+)['"]/g;
  for (const match of read(...file.split('/')).matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('node:')) continue;
    packages.push(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
  }
  return packages;
}

test('the app contains only the standalone Admin routes', () => {
  assert.deepEqual(filesUnder('app'), [
    'app/admin/layout.tsx',
    'app/admin/page.tsx',
    'app/admin/upload/actions.ts',
    'app/admin/upload/page.tsx',
    'app/api/admin/csrf/route.ts',
    'app/api/admin/uploads/route.ts',
    'app/api/auth/[...nextauth]/route.ts',
    'app/apple-icon.png',
    'app/icon.png',
    'app/layout.tsx',
    'app/page.tsx',
    'app/robots.ts',
    'app/signed-out/layout.tsx',
    'app/signed-out/page.tsx',
  ]);
});

test('no public locale routes, messages or locale helpers remain', () => {
  for (const path of [
    ['app', '[locale]'],
    ['app', 'studio'],
    ['app', 'api', 'og'],
    ['app', 'api', 'revalidate'],
    ['app', 'sitemap.ts'],
    ['app', 'manifest.ts'],
    ['messages'],
    ['lib', 'i18n.ts'],
    ['lib', 'navigation.ts'],
  ]) {
    assert.equal(exists(...path), false, path.join('/'));
  }
});

test('the Admin application is not indexable', () => {
  const robots = read('app', 'robots.ts');
  assert.match(robots, /disallow: '\/'/);
  assert.doesNotMatch(robots, /allow: '\/'(?!.)|sitemap/);
});

test('the build does not require next-intl', () => {
  assert.equal(declared.has('next-intl'), false);
  for (const file of ['next.config.ts', 'proxy.ts']) {
    assert.doesNotMatch(read(file), /next-intl|createMiddleware|lib\/navigation|lib\/i18n/, file);
  }
  for (const file of sourceFiles) {
    assert.equal(importedPackages(file).includes('next-intl'), false, file);
  }
});

test('the build does not require catalogue generation', () => {
  for (const path of [['lib', 'catalog.ts'], ['lib', 'catalog.generated.ts'], ['lib', 'catalog-i18n.ts'], ['scripts']]) {
    assert.equal(exists(...path), false, path.join('/'));
  }
  for (const script of ['prebuild', 'catalog']) assert.equal(script in packageJson.scripts, false, script);
  assert.equal(packageJson.scripts.build, 'next build');
  for (const file of sourceFiles) {
    assert.doesNotMatch(read(...file.split('/')), /lib\/catalog|catalog\.generated|\bMACHINES\b/, file);
  }
});

test('the build does not require Pagefind', () => {
  assert.equal(declared.has('pagefind'), false);
  for (const script of ['postbuild', 'pagefind']) assert.equal(script in packageJson.scripts, false, script);
  assert.doesNotMatch(Object.values(packageJson.scripts).join('\n'), /pagefind/);
  assert.equal(exists('public', 'pagefind'), false);
});

test('website-only packages are gone and every imported package is declared', () => {
  for (const name of [
    'sanity', 'next-sanity', '@sanity/client', '@sanity/image-url', '@sanity/vision',
    'three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', '@types/three',
    '@theatre/core', '@theatre/studio',
    'ai', '@ai-sdk/anthropic',
    'resend', 'react-email', '@react-email/components',
    'react-hook-form', '@hookform/resolvers', 'zod',
    'styled-components',
    '@radix-ui/react-accordion', '@radix-ui/react-dialog', '@radix-ui/react-tabs',
  ]) {
    assert.equal(declared.has(name), false, name);
  }
  for (const file of sourceFiles) {
    for (const name of importedPackages(file)) {
      assert.ok(declared.has(name), `${file} imports ${name}, which package.json does not declare`);
    }
  }
});

test('the scripts are the ones the Admin application needs', () => {
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['build', 'dev', 'lint', 'start', 'test', 'typecheck']);
});

test('next.config keeps standalone output and the security headers', () => {
  const config = read('next.config.ts');
  assert.match(config, /output: 'standalone'/);
  assert.match(config, /source: '\/\(\.\*\)'/);
  for (const header of [
    "{ key: 'X-Content-Type-Options', value: 'nosniff' }",
    "{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }",
    "{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }",
  ]) {
    assert.ok(config.includes(header), header);
  }
  assert.doesNotMatch(config, /sanity|remotePatterns|withNextIntl/);
});

test('only Admin sources remain outside the Admin folders', () => {
  assert.deepEqual(filesUnder('components').filter((file) => !file.startsWith('components/admin/')), [
    'components/primitives/button.tsx',
  ]);
  assert.deepEqual(filesUnder('lib').filter((file) => !file.startsWith('lib/admin/')), ['lib/utils.ts']);
  assert.deepEqual(filesUnder('styles'), ['styles/admin.css']);
  for (const directory of ['actions', 'emails', 'sanity', 'messages', 'scripts']) {
    assert.equal(exists(directory), false, directory);
  }
});

test('no source file refers to the removed public website', () => {
  const website = /next-intl|next-sanity|@sanity\/|pagefind|globals\.css|styles\/motion|['"`]\/en['"`/]|useLocale|NextIntlClientProvider/;
  for (const file of sourceFiles) {
    assert.doesNotMatch(read(...file.split('/')), website, file);
  }
});

test('secret scanning runs on pushes to the default branch with the pinned gitleaks binary', () => {
  const workflow = read('.github', 'workflows', 'secrets-scan.yml');
  const branches = /push:\s*\n\s*branches:\s*\n((?:\s*- .*\n)+)/.exec(workflow)?.[1] ?? '';
  assert.match(branches, /^\s*- admin-upload\s*$/m);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /GITLEAKS_VERSION: 8\.30\.1/);
  assert.match(workflow, /GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow, /gitleaks git --redact --verbose --exit-code 1 \./);
});

test('the deployment example cannot be mistaken for, or overwrite, the public website job', () => {
  assert.equal(exists('deploy', 'website.nomad.hcl'), false);
  const example = read('deploy', 'admin.nomad.hcl.example');
  assert.doesNotMatch(example, /job\s+"website"|auraplex-website|auraplex\.local\/website|path\s*=\s*"\/en"/);
  assert.match(example, /NOT PRODUCTION-READY/);
  assert.match(example, /path\s*=\s*"\/signed-out"/);
});
