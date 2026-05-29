import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // Vendored third-party bundle (SheetJS) — not our source; do not lint.
    ignores: ['xlsx.full.min.js', 'dist/**']
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['node_modules/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off'
    }
  }
];
