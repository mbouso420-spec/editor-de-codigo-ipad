import "./setup.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { uint8ArrayToBase64 } from "../js/storage/fileImport.js";
import { searchInFiles } from "../js/search/projectSearch.js";
import { createEditorManager } from "../js/editor/editorManager.js";
import {
  ensureInitialWorkspace,
  deleteProject,
  deleteProjectEntry,
  upsertEntry,
  getProjectEntries,
  closeWorkspaceBroadcast,
  broadcastWorkspaceChange,
  onWorkspaceBroadcast
} from "../js/storage/workspaceDb.js";

describe("Auditoría de Rendimiento, Ciclo de Vida y Resiliencia", () => {
  describe("1. Conversión de Búferes Binarios Grandes (uint8ArrayToBase64)", () => {
    test("procesa búfer vacío y pequeños fragmentos", () => {
      assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
      assert.equal(uint8ArrayToBase64(null), "");

      const small = new TextEncoder().encode("Studio IDE 2026");
      const b64 = uint8ArrayToBase64(small);
      assert.equal(Buffer.from(b64, "base64").toString("utf-8"), "Studio IDE 2026");
    });

    test("procesa búferes grandes (>16 KB y >64 KB) con particionado sin desbordar la pila", () => {
      const size = 70000; // >8192 límite de chunk
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        raw[i] = (i * 37) & 0xff;
      }
      const b64 = uint8ArrayToBase64(raw);
      assert.ok(b64.length > 0);
      const decoded = Buffer.from(b64, "base64");
      assert.equal(decoded.length, size);
      assert.deepEqual(new Uint8Array(decoded), raw);
    });
  });

  describe("2. Optimización de Búsqueda Global (searchInFiles)", () => {
    test("encuentra coincidencias exactas y descarta archivos no relacionados", () => {
      const files = [
        { path: "src/utils.js", content: "function calculateTax() { return 0.21; }" },
        { path: "src/empty.js", content: "const a = 1;\nconst b = 2;\nconst c = 3;" },
        { path: "docs/readme.txt", content: "Documentación interna del proyecto sin la clave." }
      ];

      const res = searchInFiles(files, "calculateTax");
      assert.equal(res.totalMatches, 1);
      assert.equal(res.filesMatched, 1);
      assert.equal(res.results[0].path, "src/utils.js");
      assert.equal(res.results[0].matches[0].line, 1);
    });

    test("admite expresiones regulares con anclas de inicio y fin de línea", () => {
      const files = [
        { path: "main.py", content: "def start():\n    pass\n\ndef stop():\n    pass" }
      ];

      const res = searchInFiles(files, "^def ", { isRegex: true });
      assert.equal(res.totalMatches, 2);
      assert.equal(res.filesMatched, 1);
      assert.equal(res.results[0].matches[0].line, 1);
      assert.equal(res.results[0].matches[1].line, 4);
    });
  });

  describe("3. Gestión de Memoria del Editor (dropFileState y destroy)", () => {
    test("dropFileState limpia selección y marcadores al soltar archivo activo", async () => {
      const mount = {
        innerHTML: "",
        appendChild: () => {},
        contains: () => true
      };

      let lastSel = null;
      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: (sel) => {
          lastSel = sel;
        }
      });

      editor.openFile({ id: "test.js", path: "test.js", lang: "javascript", content: "let x = 1;" });
      editor.addErrorMarker(1, "Sintaxis incorrecta");
      assert.equal(editor.getErrorMarkers().length, 1);

      editor.dropFileState("test.js");
      assert.equal(editor.getActiveFileId(), null);
      assert.equal(editor.getErrorMarkers().length, 0);
      assert.deepEqual(lastSel, { text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });

      editor.destroy();
    });
  });

  describe("4. Borrado Atómico en Lote y Resiliencia de BroadcastChannel", () => {
    test("deleteProjectEntry elimina una carpeta con múltiples archivos en lote", async () => {
      const projId = "test-atomic-delete";
      await ensureInitialWorkspace();

      // Crear estructura jerárquica
      await upsertEntry(projId, "components/Button.jsx", { content: "export const Button = () => null;" });
      await upsertEntry(projId, "components/Input.jsx", { content: "export const Input = () => null;" });
      await upsertEntry(projId, "components/sub/Icon.jsx", { content: "export const Icon = () => null;" });
      await upsertEntry(projId, "index.js", { content: "console.log('root');" });

      let entries = await getProjectEntries(projId);
      assert.ok(entries.some((e) => e.path === "components/Button.jsx"));
      assert.ok(entries.some((e) => e.path === "components/Input.jsx"));
      assert.ok(entries.some((e) => e.path === "components/sub/Icon.jsx"));

      // Borrar carpeta components/ de manera atómica
      await deleteProjectEntry(projId, "components", true);

      entries = await getProjectEntries(projId);
      assert.ok(!entries.some((e) => e.path.startsWith("components/")));
      assert.ok(entries.some((e) => e.path === "index.js"));

      await deleteProject(projId);
    });

    test("closeWorkspaceBroadcast y reconexión transparente sin excepciones", () => {
      closeWorkspaceBroadcast();
      assert.doesNotThrow(() => {
        broadcastWorkspaceChange({ type: "TEST_EVENT" });
      });

      const unsub = onWorkspaceBroadcast(() => {});
      assert.equal(typeof unsub, "function");
      assert.doesNotThrow(() => {
        unsub();
      });
      closeWorkspaceBroadcast();
    });
  });
});
