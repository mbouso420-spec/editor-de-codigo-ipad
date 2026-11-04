import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { truncateCodeContent, cleanHistoryForAi, estimateTokens, formatInlineMarkdown } = await import("../js/ai/chatController.js");
const { decodeImportedFile, MAX_IMPORT_FILE_BYTES } = await import("../js/storage/fileImport.js");
const { wrapTextWithDelimiters } = await import("../js/editor/editorManager.js");
const { parseQuickOpenQuery } = await import("../js/ui/quickOpenModal.js");
const { generateDuplicatePath } = await import("../js/ui/explorerController.js");
const { buildZipArchive, computeCrc32, getDosDateTime } = await import("../js/storage/zipExporter.js");
const { formatStorageBytes, getStorageQuotaEstimate } = await import("../js/storage/storageQuota.js");
const { resolveRelativePath, findBestHtmlEntrypoint, findTargetHtmlFile } = await import("../js/ui/livePreviewModal.js");
const { convertResultsToCsv, convertResultsToJson } = await import("../js/preview/sqlRunner.js");
const { buildWandboxPayload, compileAndRunWandbox } = await import("../js/preview/cRunner.js");
const { fetchRepoBranches, createRepoBranch } = await import("../js/github/githubService.js");

describe("Verificación de Arreglos de Auditoría (Fases 1, 2, 3 y 4)", () => {
  describe("FALLA-02: Presupuesto y truncamiento de contexto en el Asistente IA", () => {
    test("contenido menor al límite no se trunca", () => {
      const code = "console.log('hola mundo');\n".repeat(10);
      assert.equal(truncateCodeContent(code, 1000), code);
    });

    test("contenido mayor al límite conserva cabecera y pie con aviso de líneas omitidas", () => {
      const lines = [];
      for (let i = 1; i <= 2000; i += 1) {
        lines.push(`const linea_${i} = ${i};`);
      }
      const raw = lines.join("\n");
      const truncated = truncateCodeContent(raw, 2000);

      assert.ok(truncated.length < raw.length);
      assert.ok(truncated.includes("const linea_1 = 1;"), "debe conservar la cabecera");
      assert.ok(truncated.includes("const linea_2000 = 2000;"), "debe conservar el pie");
      assert.ok(truncated.includes("líneas omitidas por límite de contexto de la API gratuita"));
    });
  });

  describe("FALLA-06: Saneamiento del historial de chat al abortar", () => {
    test("elimina anotaciones de interrupción y no envía mensajes vacíos", () => {
      const convo = [
        { role: "user", content: "¿Cómo hago un bucle en JS?" },
        { role: "assistant", content: "Podés usar for...\n\n*(Generación detenida)*" },
        { role: "user", content: "Explicame mejor" },
        { role: "assistant", content: "\n\n*(Respuesta interrumpida: Error de red al conectar)*" }
      ];

      const cleaned = cleanHistoryForAi(convo);
      assert.equal(cleaned.length, 3, "debe omitir el último turno que quedó completamente vacío");
      assert.equal(cleaned[0].content, "¿Cómo hago un bucle en JS?");
      assert.equal(cleaned[1].content, "Podés usar for...");
      assert.equal(cleaned[2].content, "Explicame mejor");
      assert.ok(!cleaned.some((m) => m.content.includes("Generación detenida")));
      assert.ok(!cleaned.some((m) => m.content.includes("Respuesta interrumpida")));
    });
  });

  describe("FALLA-04: Límite de tamaño en importación de archivos", () => {
    test("MAX_IMPORT_FILE_BYTES es 5 MB", () => {
      assert.equal(MAX_IMPORT_FILE_BYTES, 5 * 1024 * 1024);
    });

    test("rechaza buffers que superan el límite con motivo descriptivo", () => {
      const hugeBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES + 10);
      const res = decodeImportedFile(hugeBuffer, "datos.txt");
      assert.equal(res.ok, false);
      assert.match(res.reason, /supera el límite de 5 MB/);
    });

    test("acepta archivos UTF-8 válidos dentro del límite", () => {
      const valid = new TextEncoder().encode("let a = 123;");
      const res = decodeImportedFile(valid, "codigo.js");
      assert.equal(res.ok, true);
      assert.equal(res.text, "let a = 123;");
    });
  });

  describe("FALLA-03 y FALLA-12: Seguridad y Pre-cacheo Offline", () => {
    test("index.html declara Content-Security-Policy estricta", () => {
      const htmlPath = path.resolve(__dirname, "../index.html");
      const html = fs.readFileSync(htmlPath, "utf-8");
      assert.ok(html.includes('http-equiv="Content-Security-Policy"'), "falta meta CSP en index.html");
      assert.ok(html.includes("default-src 'self'"), "CSP debe restringir default-src a 'self'");
      assert.ok(html.includes("api.github.com"), "CSP debe autorizar GitHub API");
      assert.ok(html.includes("generativelanguage.googleapis.com"), "CSP debe autorizar Gemini API");
    });

    test("sw.js pre-cachea Acorn en RUNTIME_CACHE durante el evento install", () => {
      const swPath = path.resolve(__dirname, "../sw.js");
      const sw = fs.readFileSync(swPath, "utf-8");
      assert.ok(sw.includes("ACORN_CDN_URL"), "falta constante ACORN_CDN_URL en sw.js");
      assert.ok(sw.includes("https://esm.sh/acorn@8.14.0"), "debe apuntar a la versión exacta de Acorn");
      assert.ok(sw.includes("RUNTIME_CACHE"), "debe almacenar en RUNTIME_CACHE");
    });
  });

  describe("Fase 3: Auto-Wrap de selecciones con símbolos táctiles", () => {
    test("envuelve texto con paréntesis conservando la selección interna", () => {
      const wrapped = wrapTextWithDelimiters("()", "variable", 1);
      assert.equal(wrapped.text, "(variable)");
      assert.equal(wrapped.selectFrom, 1);
      assert.equal(wrapped.selectTo, 9);
    });

    test("envuelve texto con llaves, corchetes y comillas", () => {
      assert.equal(wrapTextWithDelimiters("{}", "items", 1).text, "{items}");
      assert.equal(wrapTextWithDelimiters("[]", "1, 2, 3", 1).text, "[1, 2, 3]");
      assert.equal(wrapTextWithDelimiters('""', "cadena", 1).text, '"cadena"');
      assert.equal(wrapTextWithDelimiters("''", "caracter", 1).text, "'caracter'");
      assert.equal(wrapTextWithDelimiters("``", "template", 1).text, "`template`");
    });

    test("envuelve texto con bloques multilínea de triple backtick", () => {
      const wrapped = wrapTextWithDelimiters("``````", "const x = 10;", 3);
      assert.equal(wrapped.text, "```const x = 10;```");
      assert.equal(wrapped.selectFrom, 3);
      assert.equal(wrapped.selectTo, 16);
    });
  });

  describe("Fase 3: Salto directo a línea desde la Paleta Rápida (Cmd+P)", () => {
    test("detecta archivo y número de línea", () => {
      const res = parseQuickOpenQuery("app.js:140");
      assert.equal(res.fileQuery, "app.js");
      assert.equal(res.targetLine, 140);
    });

    test("admite salto directo sin archivo para el archivo activo (:45)", () => {
      const res = parseQuickOpenQuery(":45");
      assert.equal(res.fileQuery, "");
      assert.equal(res.targetLine, 45);
    });

    test("no altera consultas normales de archivos sin número de línea", () => {
      const res1 = parseQuickOpenQuery("src/main.py");
      assert.equal(res1.fileQuery, "src/main.py");
      assert.equal(res1.targetLine, null);

      const res2 = parseQuickOpenQuery("app.js:");
      assert.equal(res2.fileQuery, "app.js:");
      assert.equal(res2.targetLine, null);

      const res3 = parseQuickOpenQuery("archivo:no_numero");
      assert.equal(res3.fileQuery, "archivo:no_numero");
      assert.equal(res3.targetLine, null);
    });

    test("ignora espacios superfluos alrededor", () => {
      const res = parseQuickOpenQuery("  styles.css:25   ");
      assert.equal(res.fileQuery, "styles.css");
      assert.equal(res.targetLine, 25);
    });
  });

  describe("Fase 3: Duplicación inteligente en el Explorador", () => {
    test("inserta .copia antes de la extensión estándar", () => {
      const dup = generateDuplicatePath("utils.js", ["utils.js"]);
      assert.equal(dup, "utils.copia.js");
    });

    test("añade sufijo numérico secuencial si el duplicado ya existe", () => {
      const existing = ["utils.js", "utils.copia.js"];
      const dup2 = generateDuplicatePath("utils.js", existing);
      assert.equal(dup2, "utils.copia 2.js");

      existing.push("utils.copia 2.js");
      const dup3 = generateDuplicatePath("utils.js", existing);
      assert.equal(dup3, "utils.copia 3.js");
    });

    test("soporta dotfiles (.gitignore) y archivos sin extensión (Makefile)", () => {
      assert.equal(generateDuplicatePath(".gitignore", [".gitignore"]), ".gitignore.copia");
      assert.equal(generateDuplicatePath("Makefile", ["Makefile"]), "Makefile.copia");
    });

    test("conserva la estructura de carpetas anidadas", () => {
      const dup = generateDuplicatePath("src/components/Header.vue", ["src/components/Header.vue"]);
      assert.equal(dup, "src/components/Header.copia.vue");
    });
  });

  describe("Fase 4: Exportador ZIP offline (PKZIP 2.0)", () => {
    test("computeCrc32 calcula correctamente el checksum estándar", () => {
      assert.equal(computeCrc32(new Uint8Array(0)), 0);
      const testBytes = new TextEncoder().encode("123456789");
      assert.equal(computeCrc32(testBytes), 0xcbf43926);
    });

    test("getDosDateTime genera campos de fecha y hora válidos para MS-DOS", () => {
      const date = new Date(2026, 10, 4, 15, 30, 20);
      const { dosDate, dosTime } = getDosDateTime(date);
      assert.ok(dosDate > 0);
      assert.ok(dosTime > 0);
    });

    test("buildZipArchive genera un archivo PKZIP 2.0 válido con firmas oficiales", () => {
      const files = [
        { path: "index.html", content: "<!DOCTYPE html><html><body>Hola</body></html>" },
        { path: "src/app.js", content: "console.log('Studio IDE');" },
        { path: "assets/empty.txt", content: "" }
      ];

      const zipBytes = buildZipArchive(files);
      assert.ok(zipBytes instanceof Uint8Array);
      assert.ok(zipBytes.byteLength > 100);

      const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

      // Firma 1: Local File Header signature (0x04034b50 -> "PK\x03\x04")
      assert.equal(view.getUint32(0, true), 0x04034b50, "Firma de cabecera local PK 3 4 esperada");

      // Buscar Central Directory Header signature (0x02014b50 -> "PK\x01\x02")
      let hasCentralDir = false;
      for (let i = 0; i < zipBytes.byteLength - 4; i += 1) {
        if (view.getUint32(i, true) === 0x02014b50) {
          hasCentralDir = true;
          break;
        }
      }
      assert.ok(hasCentralDir, "Debe contener firma de directorio central (PK 1 2)");

      // Buscar End of Central Directory signature (0x06054b50 -> "PK\x05\x06")
      let hasEocd = false;
      for (let i = 0; i < zipBytes.byteLength - 4; i += 1) {
        if (view.getUint32(i, true) === 0x06054b50) {
          hasEocd = true;
          const totalEntries = view.getUint16(i + 10, true);
          assert.equal(totalEntries, 3, "El EOCD debe reflejar 3 archivos empaquetados");
          break;
        }
      }
      assert.ok(hasEocd, "Debe contener firma de fin de directorio central (PK 5 6)");
    });

    test("buildZipArchive soporta proyecto vacío sin lanzar excepciones", () => {
      const zipBytes = buildZipArchive([]);
      assert.ok(zipBytes.byteLength >= 22);
      const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
      assert.equal(view.getUint32(0, true), 0x06054b50, "Zip vacío contiene directamente el EOCD");
    });
  });

  describe("Fase 4: Previsualización Multi-Página (Resolución de rutas relativas)", () => {
    test("resuelve enlaces en el mismo directorio", () => {
      assert.equal(resolveRelativePath("", "contacto.html"), "contacto.html");
      assert.equal(resolveRelativePath("pages", "contacto.html"), "pages/contacto.html");
      assert.equal(resolveRelativePath("pages", "./contacto.html"), "pages/contacto.html");
    });

    test("resuelve navegación hacia directorios padre (../)", () => {
      assert.equal(resolveRelativePath("pages/blog", "../index.html"), "pages/index.html");
      assert.equal(resolveRelativePath("pages/blog/sub", "../../index.html"), "pages/index.html");
      assert.equal(resolveRelativePath("pages", "../index.html"), "index.html");
    });

    test("respeta rutas absolutas del workspace", () => {
      assert.equal(resolveRelativePath("pages/blog", "/index.html"), "index.html");
      assert.equal(resolveRelativePath("pages/blog", "/src/app.js"), "src/app.js");
    });
  });

  describe("Fase 4: Asistente IA (Estimador de Tokens y Enlaces Markdown)", () => {
    test("estimateTokens calcula ~4 caracteres por token con redondeo hacia arriba", () => {
      assert.equal(estimateTokens(0), 0);
      assert.equal(estimateTokens(4), 1);
      assert.equal(estimateTokens(5), 2);
      assert.equal(estimateTokens(40), 10);
      assert.equal(estimateTokens(1000), 250);
      assert.equal(estimateTokens(null), 0);
      assert.equal(estimateTokens(-10), 0);
    });

    test("formatInlineMarkdown renderiza enlaces https:// y http:// seguros", () => {
      const html = formatInlineMarkdown("Revisá la [documentación oficial](https://example.com/docs).");
      assert.equal(
        html,
        'Revisá la <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="chat-link">documentación oficial</a>.'
      );
    });

    test("formatInlineMarkdown bloquea protocolos peligrosos (javascript:, data:)", () => {
      const htmlXss = formatInlineMarkdown("[Ataque XSS](javascript:alert(1))");
      assert.ok(!htmlXss.includes("<a "), "No debe crear elemento <a> para javascript:");
      assert.ok(!htmlXss.includes("<script"), "No debe contener scripts crudos");

      const htmlData = formatInlineMarkdown("[Data URI](data:text/html,<script>alert(1)</script>)");
      assert.ok(!htmlData.includes("<a "), "No debe crear elemento <a> para data:");
      assert.ok(!htmlData.includes("<script>"), "No debe inyectar script de data URI");
    });

    test("formatInlineMarkdown neutraliza inyecciones de atributos en URLs", () => {
      const malicious = '[payload](https://example.com/"onmouseover="alert(1))';
      const rendered = formatInlineMarkdown(malicious);
      assert.ok(!rendered.includes('"onmouseover='), "No debe permitir inyección de atributos con comillas crudas");
      assert.ok(rendered.includes('&quot;onmouseover='), "Las comillas dentro de la URL deben estar escapadas");
    });
  });

  describe("Fase 4: Gestión de Cuota de Almacenamiento", () => {
    test("formatStorageBytes formatea adecuadamente distintos órdenes de magnitud", () => {
      assert.equal(formatStorageBytes(0), "0 B");
      assert.equal(formatStorageBytes(512), "512 B");
      assert.equal(formatStorageBytes(1024), "1.0 KB");
      assert.equal(formatStorageBytes(1536), "1.5 KB");
      assert.equal(formatStorageBytes(1024 * 1024), "1.0 MB");
      assert.equal(formatStorageBytes(5.5 * 1024 * 1024), "5.5 MB");
      assert.equal(formatStorageBytes(1024 * 1024 * 1024), "1.00 GB");
      assert.equal(formatStorageBytes(2.5 * 1024 * 1024 * 1024), "2.50 GB");
    });

    test("formatStorageBytes es resiliente ante valores inválidos o negativos", () => {
      assert.equal(formatStorageBytes(-100), "0 B");
      assert.equal(formatStorageBytes(null), "0 B");
      assert.equal(formatStorageBytes(undefined), "0 B");
      assert.equal(formatStorageBytes(NaN), "0 B");
      assert.equal(formatStorageBytes("invalido"), "0 B");
    });

    test("getStorageQuotaEstimate devuelve soporte seguro en cualquier entorno", async () => {
      const estimate = await getStorageQuotaEstimate();
      assert.equal(typeof estimate.supported, "boolean");
      assert.equal(typeof estimate.usageBytes, "number");
      assert.equal(typeof estimate.quotaBytes, "number");
      assert.equal(typeof estimate.usageFormatted, "string");
      assert.equal(typeof estimate.quotaFormatted, "string");
      assert.equal(typeof estimate.percentage, "number");
    });
  });

  describe("Fase 4: Ramas de GitHub (fetchRepoBranches y createRepoBranch)", () => {
    test("createRepoBranch rechaza nombres de rama vacíos", async () => {
      await assert.rejects(
        () => createRepoBranch({ token: "t", owner: "o", repo: "r", branchName: "" }),
        /El nombre de la rama no puede estar vacío/
      );
      await assert.rejects(
        () => createRepoBranch({ token: "t", owner: "o", repo: "r", branchName: "   " }),
        /El nombre de la rama no puede estar vacío/
      );
    });

    test("fetchRepoBranches y createRepoBranch realizan peticiones REST válidas", async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const key = `${init.method || "GET"} ${u.pathname}`;
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ key, url: String(url), body });
        if (key === "GET /repos/o/r/branches") {
          return new Response(JSON.stringify([{ name: "main" }, { name: "develop" }]), { status: 200 });
        }
        if (key === "POST /repos/o/r/git/refs") {
          return new Response(JSON.stringify({ ref: body.ref, object: { sha: body.sha } }), { status: 201 });
        }
        return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
      };

      try {
        const branches = await fetchRepoBranches({ token: "t", owner: "o", repo: "r" });
        assert.deepEqual(branches.map((b) => b.name), ["main", "develop"]);

        const created = await createRepoBranch({
          token: "t",
          owner: "o",
          repo: "r",
          branchName: "feature/nueva",
          fromSha: "SHA123"
        });
        assert.equal(created.ref, "refs/heads/feature/nueva");
        assert.equal(created.commitSha, "SHA123");

        const postCall = calls.find((c) => c.key === "POST /repos/o/r/git/refs");
        assert.ok(postCall);
        assert.equal(postCall.body.ref, "refs/heads/feature/nueva");
        assert.equal(postCall.body.sha, "SHA123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Fase 5: Motor de Vista Previa Evolucionado (Entrypoints, Multi-Página, C/C++ y SQL)", () => {
    describe("Resolución Inteligente de Entrypoints (findBestHtmlEntrypoint)", () => {
      const allFiles = [
        { path: "index.html", shortName: "index.html", content: '<!DOCTYPE html><html><head><script src="app.js"></script></head><body>Raíz</body></html>' },
        { path: "app.js", shortName: "app.js", content: "console.log('root app');" },
        { path: "admin/index.html", shortName: "index.html", content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="admin.css"></head><body>Admin</body></html>' },
        { path: "admin/admin.css", shortName: "admin.css", content: "body { background: black; }" },
        { path: "admin/custom.js", shortName: "custom.js", content: "console.log('admin custom');" },
        { path: "landing/promo.html", shortName: "promo.html", content: '<!DOCTYPE html><html><head><script src="../shared/util.js"></script></head><body>Promo</body></html>' },
        { path: "shared/util.js", shortName: "util.js", content: "export const pi = 3.14;" }
      ];

      test("prioriza HTML que enlaza explícitamente el script JS mediante <script src=...>", () => {
        const bestForUtil = findBestHtmlEntrypoint(allFiles, { path: "shared/util.js", shortName: "util.js" });
        assert.ok(bestForUtil);
        assert.equal(bestForUtil.path, "landing/promo.html");
      });

      test("prioriza HTML que enlaza explícitamente el stylesheet CSS mediante <link href=...>", () => {
        const bestForCss = findBestHtmlEntrypoint(allFiles, { path: "admin/admin.css", shortName: "admin.css" });
        assert.ok(bestForCss);
        assert.equal(bestForCss.path, "admin/index.html");
      });

      test("si no hay referencia directa, toma index.html en la misma carpeta", () => {
        const bestForCustom = findBestHtmlEntrypoint(allFiles, { path: "admin/custom.js", shortName: "custom.js" });
        assert.ok(bestForCustom);
        assert.equal(bestForCustom.path, "admin/index.html");
      });

      test("si no hay index.html en la misma carpeta, toma index.html en la raíz del proyecto", () => {
        const otherFiles = [
          { path: "index.html", shortName: "index.html", content: "<html><body>Raíz</body></html>" },
          { path: "sub/modulo.js", shortName: "modulo.js", content: "console.log(1);" }
        ];
        const best = findBestHtmlEntrypoint(otherFiles, { path: "sub/modulo.js", shortName: "modulo.js" });
        assert.ok(best);
        assert.equal(best.path, "index.html");
      });

      test("si no hay index.html, toma el primer HTML disponible en el workspace", () => {
        const otherFiles = [
          { path: "vistas/home.html", shortName: "home.html", content: "<html><body>Home</body></html>" },
          { path: "scripts/main.js", shortName: "main.js", content: "console.log(1);" }
        ];
        const best = findBestHtmlEntrypoint(otherFiles, { path: "scripts/main.js", shortName: "main.js" });
        assert.ok(best);
        assert.equal(best.path, "vistas/home.html");
      });

      test("devuelve null si no existe ningún archivo HTML en todo el workspace", () => {
        const jsOnlyFiles = [
          { path: "scripts/main.js", shortName: "main.js", content: "console.log(1);" },
          { path: "scripts/util.js", shortName: "util.js", content: "console.log(2);" }
        ];
        const best = findBestHtmlEntrypoint(jsOnlyFiles, { path: "scripts/main.js", shortName: "main.js" });
        assert.equal(best, null);
      });
    });

    describe("Navegación Multi-Página Tolerante (findTargetHtmlFile)", () => {
      const workspaceFiles = [
        { path: "index.html", shortName: "index.html", content: "<html><body>Home</body></html>" },
        { path: "catalogo.html", shortName: "catalogo.html", content: "<html><body>Catálogo</body></html>" },
        { path: "vistas/contacto.html", shortName: "contacto.html", content: "<html><body>Contacto</body></html>" },
        { path: "vistas/sub/detalle.html", shortName: "detalle.html", content: "<html><body>Detalle</body></html>" }
      ];

      test("resuelve enlaces relativos simples (catalogo.html)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo.html");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("resuelve enlaces con ./ y ../ respetando la carpeta del HTML activo", () => {
        const fromSub = findTargetHtmlFile(workspaceFiles, "vistas/sub/detalle.html", "../contacto.html");
        assert.ok(fromSub);
        assert.equal(fromSub.path, "vistas/contacto.html");

        const fromVistas = findTargetHtmlFile(workspaceFiles, "vistas/contacto.html", "../index.html");
        assert.ok(fromVistas);
        assert.equal(fromVistas.path, "index.html");
      });

      test("resuelve enlaces absolutos (/vistas/contacto.html)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "/vistas/contacto.html");
        assert.ok(target);
        assert.equal(target.path, "vistas/contacto.html");
      });

      test("resuelve enlaces sin extensión (.html implícito)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("resuelve archivos HTML por coincidencia de nombre base si se movieron de carpeta", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "contacto.html");
        assert.ok(target);
        assert.equal(target.path, "vistas/contacto.html");
      });

      test("limpia querystrings (?id=1) y fragmentos (#seccion)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo.html?categoria=libros#top");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("devuelve null si el HTML solicitado no existe en el workspace", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "inexistente.html");
        assert.equal(target, null);
      });
    });

    describe("Exportadores de Resultados SQL (convertResultsToCsv / convertResultsToJson)", () => {
      const sampleResults = [
        {
          columns: ["id", "nombre", "descripcion", "precio"],
          values: [
            [1, "Notebook Pro", "Con pantalla de 16\", alta gama", 1499.99],
            [2, "Mouse USB", "Cable reforzado, 1.8m", 25.50]
          ]
        }
      ];

      test("convertResultsToCsv genera cabeceras y filas con escape de comillas y comas", () => {
        const csv = convertResultsToCsv(sampleResults);
        assert.ok(csv.includes("id,nombre,descripcion,precio"));
        assert.ok(csv.includes('1,Notebook Pro,"Con pantalla de 16"", alta gama",1499.99'));
        assert.ok(csv.includes('2,Mouse USB,"Cable reforzado, 1.8m",25.5'));
      });

      test("convertResultsToCsv devuelve cadena vacía para resultados vacíos", () => {
        assert.equal(convertResultsToCsv([]), "");
        assert.equal(convertResultsToCsv(null), "");
      });

      test("convertResultsToJson transforma resultados tabulares en array de objetos clave-valor", () => {
        const json = convertResultsToJson(sampleResults);
        assert.equal(json.length, 2);
        assert.equal(json[0].id, 1);
        assert.equal(json[0].nombre, "Notebook Pro");
        assert.equal(json[0].precio, 1499.99);
        assert.equal(json[1].id, 2);
        assert.equal(json[1].nombre, "Mouse USB");
      });
    });

    describe("Compilador y Ejecutor C/C++ (buildWandboxPayload / compileAndRunWandbox)", () => {
      test("buildWandboxPayload selecciona gcc-head-c y c17 para archivos .c", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "main.c", content: '#include <stdio.h>\nint main(){ printf("hola"); return 0; }' }
        });
        assert.equal(payload.compiler, "gcc-head-c");
        assert.ok(payload.options.includes("c17"));
        assert.equal(payload.codes.length, 0);
      });

      test("buildWandboxPayload selecciona gcc-head y c++20 para archivos .cpp/.hpp", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "main.cpp", content: '#include <iostream>\nint main(){ std::cout << "hola"; }' }
        });
        assert.equal(payload.compiler, "gcc-head");
        assert.ok(payload.options.includes("c++20"));
      });

      test("buildWandboxPayload empaqueta headers compañeros en codes y fuentes .c/.cpp en compiler-option-raw", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "src/main.cpp", content: '#include "math.hpp"\nint main(){ return add(1,2); }' },
          companionFiles: [
            { path: "src/math.hpp", content: "int add(int a, int b);" },
            { path: "src/math.cpp", content: '#include "math.hpp"\nint add(int a, int b){ return a + b; }' }
          ],
          stdin: "42\n"
        });

        assert.equal(payload.stdin, "42\n");
        assert.equal(payload.codes.length, 2);
        const headerCode = payload.codes.find((c) => c.file === "math.hpp");
        assert.ok(headerCode, "Debe incluir el header math.hpp en codes");

        const rawOpt = payload["compiler-option-raw"];
        assert.ok(rawOpt.includes("math.cpp"), "Debe incluir el archivo fuente companion en compiler-option-raw para compilación conjunta");
      });

      test("compileAndRunWandbox procesa salida estándar y códigos de estado", async () => {
        const mockFetch = async () => {
          return new Response(
            JSON.stringify({
              status: "0",
              program_output: "Resultado: 42\n",
              program_error: ""
            }),
            { status: 200 }
          );
        };

        const res = await compileAndRunWandbox({ compiler: "gcc-head", code: "..." }, mockFetch);
        assert.equal(res.status, 0);
        assert.equal(res.success, true);
        assert.equal(res.stdout, "Resultado: 42\n");
      });
    });
  });
});
