import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	{
		ignores: [".vscode-test/**", "coverage/**", "media/**", "node_modules/**", "out/**", "src/util/vs/**"]
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		linterOptions: {
			reportUnusedDisableDirectives: "error"
		}
	},
	{
		files: ["src/webview/**/*.{ts,tsx}"],
		plugins: {
			"react-hooks": reactHooks
		},
		rules: reactHooks.configs.flat.recommended.rules
	},
	{
		files: ["**/*.cjs", "esbuild.js"],
		rules: {
			"@typescript-eslint/no-require-imports": "off"
		}
	}
);
