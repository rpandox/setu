// ESLint flat config. Documentation rules are load-bearing here: this project
// is open source and undocumented exports fail CI (PLAN.md §6.3).
import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src-tauri/target/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsdoc.configs["flat/recommended-typescript-error"],
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { tsdoc },
    rules: {
      // TSDoc syntax must parse — malformed doc comments are errors.
      "tsdoc/syntax": "error",
      // Every exported function, component, and store gets a doc comment.
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            ClassExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
          },
          contexts: [
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
          ],
        },
      ],
      "jsdoc/require-description": "error",
      // TypeScript already carries the types; prose is what we require.
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-returns": "off",
      // TSDoc style: a blank line between description and tags is fine.
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }],
      // React props are documented on their Props interface, not re-listed
      // per destructured key.
      "jsdoc/require-param": ["error", { checkDestructured: false }],
      "jsdoc/check-param-names": ["error", { checkDestructured: false }],
    },
  },
  {
    // Config and test files document themselves; only TSDoc syntax applies.
    files: ["*.config.{js,ts}", "src/**/*.test.{ts,tsx}"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-description": "off",
    },
  },
);
