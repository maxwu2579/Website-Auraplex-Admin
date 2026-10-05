// Next 16 removed `next lint`; we use the ESLint CLI with a flat config.
// https://nextjs.org/docs/app/api-reference/config/eslint
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Matches the website's lint rules.
      '@typescript-eslint/no-explicit-any': 'off',
      // Modern JSX renders apostrophes/quotes correctly; the rule is noise.
      'react/no-unescaped-entities': 'off',
      // Allow unused imports prefixed with _ ; warn otherwise.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'node_modules/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
