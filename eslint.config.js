import globals from 'globals';

/**
 * 只保留高信号的规则：能抓到真 bug 的那种。
 * 风格交给 prettier，别在这里争「要不要分号」。
 */
const RULES = {
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      // 工具函数的第二个参数是宿主传的上下文，暂时用不上但要占位
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
      caughtErrors: 'none',
    },
  ],
  'no-undef': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-shadow': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-async-promise-executor': 'error',
  'no-useless-catch': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-promise-executor-return': 'error',
  'require-atomic-updates': 'off',
};

export default [
  {
    // vendor 是 src 的逐字节副本，另有门禁保证一致，重复检查没有意义
    ignores: [
      'node_modules/**',
      '.npm-cache/**',
      'packages/loom-dsh/vendor/**',
      'packages/loom-core/test/fixtures/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: RULES,
  },
  {
    // 面板跑在浏览器里：window / document / fetch 都是宿主给的
    files: ['packages/loom-dsh/client.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: RULES,
  },
];
