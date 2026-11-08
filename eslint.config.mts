import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"main.js",
		"styles.css",
		"**/esbuild.config.mjs",
		"version-bump.mjs",
		"vitest.config.ts",
		"versions.json",
		"**/package.json",
		"package-lock.json",
		"**/tsconfig*.json",
		"packages/*/test",
		"notes",
		"eslint.config.mts",
		"test-vault",
	]),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mts", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// core is shared with the future Zotero plugin and standalone app, so it
		// uses standard DOM APIs rather than Obsidian's helpers.
		files: ["packages/core/**"],
		rules: {
			"obsidianmd/prefer-instanceof": "off",
			"obsidianmd/prefer-create-el": "off",
		},
	},
);
