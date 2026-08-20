import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ["node_modules/**", "admin/words.js", "**/*.d.ts"],
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            indent: ["error", 4, { SwitchCase: 1 }],
            "no-console": "off",
            "no-var": "error",
            "no-trailing-spaces": "error",
            "prefer-const": "error",
            quotes: [
                "error",
                "double",
                { avoidEscape: true, allowTemplateLiterals: true },
            ],
            semi: ["error", "always"],
        },
    },
];
