import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import globals from "globals";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Guarda de regresión del BUG-23: una llamada a una función inexistente (ReferenceError)
// rompía el arranque completo de la app y ningún test unitario lo detectaba.
test("análisis estático: ningún identificador indefinido ni error de sintaxis en js/ y sw.js", async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.js"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.browser }
        },
        rules: {
          "no-undef": "error",
          "no-unreachable": "error",
          "no-dupe-keys": "error",
          "no-redeclare": "error",
          "no-const-assign": "error",
          "no-import-assign": "error",
          "no-func-assign": "error",
          "use-isnan": "error",
          "valid-typeof": "error",
          "no-unsafe-finally": "error",
          "no-dupe-else-if": "error",
          "no-self-assign": "error"
        }
      }
    ]
  });
  const results = await eslint.lintFiles(["js/**/*.js", "sw.js"]);
  const problems = results.flatMap((r) =>
    r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line}:${m.column} ${m.ruleId || "parse"} ${m.message}`)
  );
  assert.ok(results.length >= 14, `se esperaban ≥14 archivos analizados, hubo ${results.length}`);
  assert.deepEqual(problems, []);
});
