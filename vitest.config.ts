import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		environment: "happy-dom",
		// The tests stay local (see .gitignore), so a fresh clone has none.
		passWithNoTests: true,
	},
});
