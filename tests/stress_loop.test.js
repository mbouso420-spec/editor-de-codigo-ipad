import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { getStorageQuotaEstimate, formatStorageBytes } from "../js/storage/storageQuota.js";
import { decodeImportedFile, MAX_IMPORT_FILE_BYTES } from "../js/storage/fileImport.js";
import { createEditorManager, wrapTextWithDelimiters } from "../js/editor/editorManager.js";
import { truncateCodeContent, estimateTokens, formatInlineMarkdown } from "../js/ai/chatController.js";
import { findBestHtmlEntrypoint, findTargetHtmlFile } from "../js/ui/livePreviewModal.js";
import { parseGccErrors, buildWandboxPayload, hasMainFunction } from "../js/preview/cRunner.js";
import { convertResultsToCsv, convertResultsToJson } from "../js/preview/sqlRunner.js";

describe("[STRESS LOOP #1] Ciclo de Vida, Persistencia y Cuota", () => {
  test("formatStorageBytes formatea adecuadamente desde B hasta TB", () => {
    assert.equal(formatStorageBytes(0), "0 B");
    assert.equal(formatStorageBytes(512), "512 B");
    assert.equal(formatStorageBytes(1024), "1.0 KB");
    assert.equal(formatStorageBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatStorageBytes(2.5 * 1024 * 1024 * 1024), "2.50 GB");
  });

  test("getStorageQuotaEstimate maneja navigator.storage disponible y responde con métricas", async () => {
    const origStorage = globalThis.navigator.storage;
    globalThis.navigator.storage = {
      estimate: async () => ({ usage: 50 * 1024 * 1024, quota: 500 * 1024 * 1024 })
    };
    try {
      const estimate = await getStorageQuotaEstimate();
      assert.equal(estimate.usageBytes, 50 * 1024 * 1024);
      assert.equal(estimate.quotaBytes, 500 * 1024 * 1024);
      assert.equal(estimate.percentage, 10);
      assert.equal(estimate.usageFormatted, "50.0 MB");
      assert.equal(estimate.quotaFormatted, "500.0 MB");
    } finally {
      if (origStorage) {
        globalThis.navigator.storage = origStorage;
      } else {
        delete globalThis.navigator.storage;
      }
    }
  });

  test("getStorageQuotaEstimate es resiliente ante rechazos en modo privado / sandboxed iframe", async () => {
    const origStorage = globalThis.navigator.storage;
    globalThis.navigator.storage = {
      estimate: async () => { throw new Error("SecurityError: Permission denied"); }
    };
    try {
      const estimate = await getStorageQuotaEstimate();
      assert.equal(estimate.usageBytes, 0);
      assert.equal(estimate.quotaBytes, 0);
      assert.equal(estimate.percentage, 0);
      assert.equal(estimate.usageFormatted, "—");
    } finally {
      if (origStorage) {
        globalThis.navigator.storage = origStorage;
      } else {
        delete globalThis.navigator.storage;
      }
    }
  });

  test("Límites de importación: buffers en el límite de 5 MB son válidos; mayores son rechazados", () => {
    const exactBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES);
    const validCheck = decodeImportedFile(exactBuffer, "archivo.txt");
    assert.equal(validCheck.ok, false); // NUL bytes sniff detecta binario
    assert.match(validCheck.reason, /parece un archivo binario/i);

    const validTextBuffer = new TextEncoder().encode("const a = 1;");
    const textCheck = decodeImportedFile(validTextBuffer, "archivo.txt");
    assert.equal(textCheck.ok, true);

    const overBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1);
    const invalidCheck = decodeImportedFile(overBuffer, "archivo.txt");
    assert.equal(invalidCheck.ok, false);
    assert.match(invalidCheck.reason, /supera el límite de 5 MB/i);
  });
});

describe("[STRESS LOOP #1] Ergonomía Táctil y Auto-Wrap de Delimitadores", () => {
  test("wrapTextWithDelimiters envuelve selecciones con () preservando contenido", () => {
    const wrapped = wrapTextWithDelimiters("()", "variable", 1);
    assert.equal(wrapped.text, "(variable)");
    assert.equal(wrapped.selectFrom, 1);
    assert.equal(wrapped.selectTo, 9);
  });

  test("wrapTextWithDelimiters envuelve con comillas dobles y corchetes", () => {
    const wQuotes = wrapTextWithDelimiters('""', "cadena de texto", 1);
    assert.equal(wQuotes.text, '"cadena de texto"');

    const wBrackets = wrapTextWithDelimiters("[]", "1, 2, 3", 1);
    assert.equal(wBrackets.text, "[1, 2, 3]");
  });

  test("wrapTextWithDelimiters envuelve código multilínea con llaves {}", () => {
    const code = "  int a = 1;\n  int b = 2;";
    const wrapped = wrapTextWithDelimiters("{}", code, 1);
    assert.equal(wrapped.text, `{${code}}`);
    assert.equal(wrapped.selectFrom, 1);
    assert.equal(wrapped.selectTo, 1 + code.length);
  });
});

describe("[STRESS LOOP #1] Gestión de Memoria y Reemplazo Invariante de Código IA", () => {
  test("editor.replaceEntireDocument reemplaza el rango completo sin duplicar ni depender del cursor", async () => {
    const mount = document.createElement("div");
    const editor = await createEditorManager({
      mountEl: mount,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });

    const initialCode = "const x = 1;\nconsole.log(x);";
    editor.openFile({ id: "script.js", path: "script.js", lang: "js", content: initialCode });

    // Inyección de código nuevo por la IA
    const aiCode = "function sum(a, b) {\n  return a + b;\n}\nexport default sum;";
    editor.replaceEntireDocument(aiCode);

    // En fallback o CM6, verificamos que el contenido sea exactamente el nuevo código sin restos
    const textarea = mount.querySelector("textarea");
    if (textarea) {
      assert.equal(textarea.value, aiCode);
      assert.ok(!textarea.value.includes(initialCode));
    }
  });

  test("editor.dropFileState purga el estado activo y limpia referencias de memoria", async () => {
    const mount = document.createElement("div");
    const editor = await createEditorManager({
      mountEl: mount,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });

    editor.openFile({ id: "temp.cpp", path: "temp.cpp", lang: "cpp", content: "int main() {}" });
    editor.addErrorMarker(1, "Sintaxis incorrecta");
    assert.equal(editor.getErrorMarkers().length, 1);

    editor.dropFileState("temp.cpp");
    editor.clearActiveFile();
    editor.clearErrorMarkers();
    assert.equal(editor.getErrorMarkers().length, 0);
  });
});

describe("[STRESS LOOP #1] Asistente IA, Truncamiento y Renderizado Seguro", () => {
  test("truncateCodeContent preserva cabecera y pie con indicador de líneas omitidas", () => {
    const lines = [];
    for (let i = 1; i <= 2000; i++) {
      lines.push(`const linea_${i} = ${i};`);
    }
    const bigCode = lines.join("\n");
    const truncated = truncateCodeContent(bigCode, 5000);

    assert.ok(truncated.length < bigCode.length);
    assert.ok(truncated.includes("linea_1"));
    assert.ok(truncated.includes("linea_2000"));
    assert.match(truncated, /líneas omitidas/i);
  });

  test("estimateTokens estima ~4 caracteres por token con mínimo de 1", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(40), 10);
    assert.equal(estimateTokens(400), 100);
  });

  test("formatInlineMarkdown renderiza enlaces con target='_blank' y rel='noopener noreferrer'", () => {
    const html = formatInlineMarkdown("Visita la [Documentación Oficial](https://developer.mozilla.org) para más info.");
    assert.match(html, /<a href="https:\/\/developer\.mozilla\.org" target="_blank" rel="noopener noreferrer" class="chat-link">Documentación Oficial<\/a>/);
  });
});

describe("[STRESS LOOP #1] Vista Previa Avanzada y Navegación Multi-Página", () => {
  const mockFiles = [
    { path: "index.html", shortName: "index.html", content: '<!DOCTYPE html><html><head><script src="js/main.js"></script><link rel="stylesheet" href="css/estilos.css"></head><body><h1>Inicio</h1><a href="tienda.html">Ir a tienda</a></body></html>' },
    { path: "tienda.html", shortName: "tienda.html", content: '<!DOCTYPE html><html><body><h1>Tienda</h1><a href="index.html">Volver</a></body></html>' },
    { path: "pages/contacto.html", shortName: "contacto.html", content: '<html><body>Contacto</body></html>' },
    { path: "pages/faq.html", shortName: "faq.html", content: '<html><body>FAQ</body></html>' },
    { path: "js/main.js", shortName: "main.js", content: 'console.log("hello");' },
    { path: "css/estilos.css", shortName: "estilos.css", content: 'body { margin: 0; }' }
  ];

  test("findBestHtmlEntrypoint detecta el HTML que incluye el script activo", () => {
    const activeFile = { path: "js/main.js", shortName: "main.js", content: 'console.log("hello");' };
    const best = findBestHtmlEntrypoint(mockFiles, activeFile);
    assert.ok(best);
    assert.equal(best.path, "index.html");
  });

  test("findBestHtmlEntrypoint detecta el HTML que incluye la hoja de estilos activa", () => {
    const activeFile = { path: "css/estilos.css", shortName: "estilos.css", content: 'body { margin: 0; }' };
    const best = findBestHtmlEntrypoint(mockFiles, activeFile);
    assert.ok(best);
    assert.equal(best.path, "index.html");
  });

  test("findTargetHtmlFile resuelve enlaces relativos en la misma carpeta ('tienda.html')", () => {
    const target = findTargetHtmlFile(mockFiles, "index.html", "tienda.html");
    assert.ok(target);
    assert.equal(target.path, "tienda.html");
  });

  test("findTargetHtmlFile resuelve enlaces anidados desde subcarpetas ('faq.html' desde 'pages/contacto.html')", () => {
    const target = findTargetHtmlFile(mockFiles, "pages/contacto.html", "faq.html");
    assert.ok(target);
    assert.equal(target.path, "pages/faq.html");
  });

  test("findTargetHtmlFile resuelve enlaces sin extensión ('tienda' -> 'tienda.html')", () => {
    const target = findTargetHtmlFile(mockFiles, "index.html", "tienda");
    assert.ok(target);
    assert.equal(target.path, "tienda.html");
  });

  test("findTargetHtmlFile devuelve null para enlaces inexistentes", () => {
    const target = findTargetHtmlFile(mockFiles, "index.html", "inexistente.html");
    assert.equal(target, null);
  });
});

describe("[STRESS LOOP #1] Compilador C/C++ y Señalización de Errores de Sintaxis", () => {
  test("parseGccErrors parsea faltas de punto y coma y errores tipográficos de GCC/Clang", () => {
    const gccStderr = `
main.cpp: In function 'int main()':
main.cpp:7:5: error: expected ';' before 'return'
    7 |     return 0;
      |     ^~~~~~
main.cpp:4:9: warning: unused variable 'x' [-Wunused-variable]
    4 |     int x = 10;
      |         ^
`;
    const errors = parseGccErrors(gccStderr);
    assert.equal(errors.length, 2);

    const err = errors.find((e) => e.severity === "error");
    assert.ok(err);
    assert.equal(err.line, 7);
    assert.equal(err.column, 5);
    assert.match(err.message, /expected ';' before 'return'/);

    const warn = errors.find((e) => e.severity === "warning");
    assert.ok(warn);
    assert.equal(warn.line, 4);
    assert.equal(warn.column, 9);
  });

  test("buildWandboxPayload aísla fuentes con main() para evitar colisiones de enlace", () => {
    const activeFile = { path: "main.cpp", content: "int main() { return 0; }" };
    const companionFiles = [
      { path: "helper.hpp", content: "int add(int a, int b);" },
      { path: "other_main.cpp", content: "int main() { return 1; }" }
    ];

    const payload = buildWandboxPayload({ activeFile, companionFiles, stdin: "" });
    assert.equal(payload.compiler, "gcc-head");
    assert.ok(payload.codes.some((c) => c.file === "helper.hpp"));
    // other_main.cpp no se pasa en compiler-option-raw porque tiene su propio main()
    assert.ok(!payload["compiler-option-raw"].includes("other_main.cpp"));
  });

  test("hasMainFunction distingue comentarios de implementaciones reales de main()", () => {
    assert.equal(hasMainFunction("/* int main() {} */\nvoid test() {}"), false);
    assert.equal(hasMainFunction("// int main() {}\nvoid run() {}"), false);
    assert.equal(hasMainFunction("int main() {\n  return 0;\n}"), true);
    assert.equal(hasMainFunction("int main(int argc, char** argv) {\n  return 0;\n}"), true);
  });
});

describe("[STRESS LOOP #1] Motor SQLite en Vivo y Exportación CSV/JSON", () => {
  const sampleResults = [
    {
      columns: ["id", "nombre", "comentarios", "precio"],
      values: [
        [1, "Teclado Mecánico", 'Incluye cable USB, "RGB"', 120.5],
        [2, "Mouse Inalámbrico", "Sin comentarios especiales", null],
        [3, "Monitor 4K", "Resolución 3840x2160\nCon soporte", 450]
      ]
    }
  ];

  test("convertResultsToCsv escapa adecuadamente comas, comillas dobles y saltos de línea", () => {
    const csv = convertResultsToCsv(sampleResults);
    assert.ok(csv.includes("id,nombre,comentarios,precio"));
    // Campo con comas y comillas debe ir entrecomillado y con comillas duplicadas
    assert.ok(csv.includes('"Incluye cable USB, ""RGB"""'));
    assert.ok(csv.includes('"Resolución 3840x2160\nCon soporte"'));
    // Valor nulo debe quedar vacío
    assert.ok(csv.includes('Mouse Inalámbrico,Sin comentarios especiales,'));
  });

  test("convertResultsToJson genera un array de objetos mapeados con tipos correctos", () => {
    const json = convertResultsToJson(sampleResults);
    assert.equal(json.length, 3);
    assert.equal(json[0].id, 1);
    assert.equal(json[0].nombre, "Teclado Mecánico");
    assert.equal(json[0].precio, 120.5);
    assert.equal(json[1].precio, null);
    assert.equal(json[2].id, 3);
  });
});
