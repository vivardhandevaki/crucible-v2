import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Flat config. Formatting is owned by Prettier (eslint-config-prettier disables
// stylistic rules), so ESLint stays focused on correctness.
//
// The cross-layer import ban (architecture.md §1 dependency direction) is NOT
// enforced here yet — it is a documented placeholder implemented as a separate,
// runnable check in scripts/check-layering.mjs (`npm run lint:layering`) and
// hardened into the core `lint/` module during Phase 1. See LAYERING.md.
export default tseslint.config(
  {
    // fixtures/toy-repo is author-controlled data sealed by the approval hash;
    // linting/reformatting it would break hash-stability tests (see its README).
    ignores: [
      '**/dist/**',
      'adapters/*/package/**', // generated, conformance-certified bundle output
      '**/coverage/**',
      'node_modules/**',
      'site/**',
      '.old/**',
      'fixtures/toy-repo/**',
      // JVM build outputs (Maven `target/`, Gradle `build/`) — generated, and
      // Gradle's HTML test report bundles browser JS that trips no-undef.
      '**/target/**',
      'fixtures/conformance/*/build/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // Node scripts and config files run under Node's globals (process, URL, …).
    files: ['**/scripts/**/*.{js,mjs}', '*.{js,mjs}', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
