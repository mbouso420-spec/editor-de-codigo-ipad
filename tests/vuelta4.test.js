import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as acorn from "acorn";

const { instrumentLoops, buildLoopGuardRuntime } = await import("../js/preview/loopGuard.js");
const { bundleHtmlWithFolderAssets, buildStandaloneJsPreview } = await import("../js/ui/livePreviewModal.js");

const guard = (code, module = false) => instrumentLoops(code, acorn, { module }).code;

/** Ejecuta código en un contexto aislado con un guardián cuyo reloj "libre" nunca avanza (simula bloqueo). */
function runGuarded(code, limitMs = 150) {
  const ctx = { setInterval: () => 0, Date, console: { log() {} }, result: undefined };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(buildLoopGuardRuntime(limitMs), ctx);
  vm.runInContext(code, ctx, { timeout: 10000 });
  return ctx;
}

describe("Protección de bucles: instrumentación", () => {
  test("instrumenta los 5 tipos de bucle, con y sin llaves", () => {
    const src = [
      "while (a) { x(); }",
      "do y(); while (b);",
      "for (let i = 0; i < 3; i++) z(i);",
      "for (const k in o) ;",
      "for (const v of arr) { w(v); }"
    ].join("\n");
    const r = instrumentLoops(src, acorn);
    assert.equal(r.instrumented, true);
    assert.equal((r.code.match(/__studioLoopGuard\(/g) || []).length, 5);
    assert.doesNotThrow(() => acorn.parse(r.code, { ecmaVersion: "latest" }));
    for (const line of [1, 2, 3, 4, 5]) assert.ok(r.code.includes(`__studioLoopGuard(${line})`), `línea ${line}`);
  });

  test("bucles anidados, etiquetas, break/continue y async/await siguen siendo válidos", () => {
    const src = `outer: for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (j) continue outer; }
async function f() { for await (const x of g()) { await x; } }
const fn = () => { while (true) break; };
class A { m() { do { return 1; } while (false); } }`;
    const out = guard(src);
    assert.equal((out.match(/__studioLoopGuard\(/g) || []).length, 5);
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: "latest" }));
  });

  test("módulos ES (import/export) se instrumentan como módulo", () => {
    const out = guard('import x from "./a.js";\nexport const y = () => { for (;;) { break; } };', true);
    assert.ok(out.includes("__studioLoopGuard(2)"));
  });

  test("texto 'for'/'while' dentro de cadenas, comentarios o regex no se toca", () => {
    const src = 'const s = "while (true) {}"; // for (;;)\nconst r = /do while/;';
    assert.equal(guard(src), src);
  });

  test("código con error de sintaxis o sin bucles se devuelve intacto", () => {
    assert.equal(guard("while ("), "while (");
    assert.equal(guard("console.log(1)"), "console.log(1)");
    assert.deepEqual(instrumentLoops("for(;;){}", null), { code: "for(;;){}", loops: 0, instrumented: false });
  });

  test("propiedad: el código protegido produce el mismo resultado que el original (programas que terminan)", () => {
    const programs = [
      "let s = 0; for (let i = 0; i < 1000; i++) s += i; result = s;",
      "let a = []; for (const k in {x:1, y:2}) a.push(k); for (const v of [3,4]) a.push(v); result = a.join(',');",
      "let n = 10, c = 0; while (n > 1) { n = n % 2 ? 3 * n + 1 : n / 2; c++; } result = c;",
      "let i = 0; do { i += 3; } while (i < 20); result = i;",
      "let out = ''; outer: for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) { if (j > i) continue outer; out += i + '' + j + ' '; } } result = out;"
    ];
    for (const p of programs) {
      const plain = runGuarded(p, 60000).result;
      const guarded = runGuarded(guard(p), 60000).result;
      assert.deepEqual(guarded, plain, p);
    }
  });
});

describe("Protección de bucles: ejecución", () => {
  test("un while(true) real se corta con mensaje en español y número de línea", () => {
    const t0 = Date.now();
    assert.throws(
      () => runGuarded(guard("let n = 0;\nwhile (true) {\n  n++;\n}")),
      (e) => /Bucle detenido en la línea 2/.test(e.message) && /posible bucle infinito/.test(e.message)
    );
    assert.ok(Date.now() - t0 < 5000);
  });
  test("for(;;); sin cuerpo y do-while infinito también se cortan", () => {
    assert.throws(() => runGuarded(guard("for (;;);")), /Bucle detenido en la línea 1/);
    assert.throws(() => runGuarded(guard("do {} while (1)")), /Bucle detenido/);
  });
  test("un try/catch del usuario dentro de un bucle externo no evita el corte (el guardián sigue disparando)", () => {
    const src = "while (true) {\n  try { while (true) {} } catch (e) {}\n}";
    assert.throws(() => runGuarded(guard(src)), /Bucle detenido en la línea 1/);
  });
});

describe("Protección de bucles: integración con la vista previa", () => {
  const mk = (path, content) => ({ path, content, shortName: path.split("/").pop() });

  test("HTML: protege scripts incrustados e inline; no toca JSON ni plantillas; el puente define el guardián", () => {
    const html = `<html><head></head><body>
<script src="app.js"></script>
<script>for (;;) { break; }</script>
<script type="application/json">{"while": true}</script>
<script type="text/template"><p>for (;;)</p></script>
</body></html>`;
    const out = bundleHtmlWithFolderAssets("i.html", html, new Map([["app.js", mk("app.js", "while (x) { y(); }")]]), null, (c, m) => guard(c, m));
    assert.ok(out.includes("window.__studioLoopGuard = function"), "falta el guardián en el puente");
    assert.ok(/while \(x\) \{__studioLoopGuard\(1\);/.test(out));
    assert.ok(/for \(;;\) \{__studioLoopGuard\(1\); break; \}/.test(out));
    assert.ok(out.includes('{"while": true}'));
    assert.ok(out.includes("<p>for (;;)</p>"));
    const scripts = [...out.matchAll(/<script(?![^>]*type="(?:application\/json|text\/template)")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  });

  test("JS suelto: se protege y la página generada compila", () => {
    const out = buildStandaloneJsPreview({ path: "a.js", content: "let i = 0;\nwhile (true) { i++; }" }, (c, m) => guard(c, m));
    assert.ok(out.includes("__studioLoopGuard(2)"));
    const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 2);
    for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  });

  test("sin analizador (sin red) la vista previa funciona igual que antes", () => {
    const out = buildStandaloneJsPreview({ path: "a.js", content: "while (true) {}" });
    assert.ok(out.includes("while (true) {}"));
    assert.ok(!out.includes("__studioLoopGuard(1)"));
  });
});
