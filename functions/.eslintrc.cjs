// functions/.eslintrc.cjs
module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: false, // no necesitamos tsconfig para el parser
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "google",
  ],
  rules: {
    // Ajustes suaves / compatibles con tu estilo
    "quotes": ["error", "double", { "allowTemplateLiterals": true }],
    "require-jsdoc": "off",
    "max-len": "off",
    "object-curly-spacing": ["error", "always"],
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
  },
  ignorePatterns: [
    "node_modules/",
    "lib/",           // salida del build (tsc)
    ".eslintrc.cjs",
  ],
};
