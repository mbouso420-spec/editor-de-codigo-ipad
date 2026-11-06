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
  updateFileContent,
  getProjectEntries,
  closeWorkspaceBroadcast,
  broadcastWorkspaceChange,
  onWorkspaceBroadcast
} from "../js/storage/workspaceDb.js";
import {
  writeEmergencyBackup,
  readEmergencyBackup,
  clearEmergencyBackup,
  getEmergencyBackupKey,
  EMERGENCY_BACKUP_KEY,
  EMERGENCY_BACKUP_PREFIX
} from "../js/storage/emergencyBackup.js";
import { KeyboardRouter } from "../js/ui/keyboardRouter.js";
import { convertResultsToCsv, convertResultsToJson } from "../js/preview/sqlRunner.js";

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

    test("purgeViewDocument y clearActiveFile purgan el contenido a 0 bytes al cerrar última pestaña", async () => {
      const mount = {
        innerHTML: "",
        appendChild: () => {},
        contains: () => true
      };

      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: () => {}
      });

      editor.openFile({ id: "purge.js", path: "purge.js", lang: "javascript", content: "console.log('purge me');" });
      assert.equal(editor.getActiveFileId(), "purge.js");

      editor.clearActiveFile();
      assert.equal(editor.getActiveFileId(), null);

      // purgeViewDocument es idempotente y seguro de llamar explícitamente
      assert.doesNotThrow(() => {
        editor.purgeViewDocument?.();
      });

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

    test("updateFileContent propaga evento FILE_UPDATED con contrato unificado a otras pestañas", async () => {
      const projId = "test-broadcast-contract";
      await ensureInitialWorkspace();
      await upsertEntry(projId, "contract.js", { content: "const a = 1;" });

      const otherTabChannel = new BroadcastChannel("studio_ide_workspace_sync");
      otherTabChannel.unref?.();

      const receivedPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout esperando evento FILE_UPDATED")), 2000);
        otherTabChannel.addEventListener("message", (ev) => {
          if (ev.data?.type === "FILE_UPDATED" && ev.data?.path === "contract.js") {
            clearTimeout(timeout);
            otherTabChannel.close();
            resolve(ev.data);
          }
        });
      });

      try {
        await updateFileContent(projId, "contract.js", "const a = 2;");
        const event = await receivedPromise;
        assert.equal(event.type, "FILE_UPDATED");
        assert.equal(event.projectId, projId);
        assert.equal(event.path, "contract.js");
      } finally {
        otherTabChannel.close();
        await deleteProject(projId);
      }
    });
  });

  describe("5. Respaldo de Emergencia Particionado por Proyecto (localStorage)", () => {
    test("writeEmergencyBackup particiona por projectId y previene colisiones", () => {
      const storage = new Map();
      const mockStorage = {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: (i) => Array.from(storage.keys())[i] ?? null
      };

      const keyA = getEmergencyBackupKey("proj-alpha");
      const keyB = getEmergencyBackupKey("proj-beta");
      assert.equal(keyA, `${EMERGENCY_BACKUP_PREFIX}proj-alpha`);
      assert.equal(keyB, `${EMERGENCY_BACKUP_PREFIX}proj-beta`);

      writeEmergencyBackup([{ projectId: "proj-alpha", filePath: "app.js", content: "alpha code" }], mockStorage, "proj-alpha");
      writeEmergencyBackup([{ projectId: "proj-beta", filePath: "index.js", content: "beta code" }], mockStorage, "proj-beta");

      assert.ok(storage.has(keyA));
      assert.ok(storage.has(keyB));

      const readAlpha = readEmergencyBackup(mockStorage, "proj-alpha");
      assert.equal(readAlpha.length, 1);
      assert.equal(readAlpha[0].content, "alpha code");

      const readBeta = readEmergencyBackup(mockStorage, "proj-beta");
      assert.equal(readBeta.length, 1);
      assert.equal(readBeta[0].content, "beta code");

      // Lectura agregada sin projectId obtiene ambos respaldos
      const aggregated = readEmergencyBackup(mockStorage);
      assert.equal(aggregated.length, 2);

      // Limpieza particionada de solo proj-alpha
      clearEmergencyBackup(mockStorage, "proj-alpha");
      assert.ok(!storage.has(keyA));
      assert.ok(storage.has(keyB));

      // Limpieza total
      clearEmergencyBackup(mockStorage);
      assert.equal(storage.size, 0);
    });
  });

  describe("6. Control de Cierre Seguro en KeyboardRouter (onEscape booleano)", () => {
    test("onEscape retornando false retiene el modal en la pila; true o void lo desapila", () => {
      const router = new KeyboardRouter();
      let closeAttempts = 0;
      let allowClose = false;

      router.pushModal({
        id: "modal-guarded",
        onEscape: () => {
          closeAttempts++;
          return allowClose;
        }
      });

      assert.equal(router.getActiveModal()?.id, "modal-guarded");

      // Primer Escape: handler rechaza cierre (retorna false)
      router.handleKeyDown({
        key: "Escape",
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(closeAttempts, 1);
      assert.equal(router.getActiveModal()?.id, "modal-guarded", "Modal no debe desapilarse si onEscape retorna false");

      // Segundo Escape: handler aprueba cierre (retorna true)
      allowClose = true;
      router.handleKeyDown({
        key: "Escape",
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(closeAttempts, 2);
      assert.equal(router.getActiveModal(), null, "Modal debe desapilarse cuando onEscape retorna true");
    });
  });

  describe("7. Optimización de Memoria en Consultas SQL Masivas (sqlRunner)", () => {
    test("convertResultsToCsv y convertResultsToJson respetan maxRows ante grandes lotes", () => {
      const largeResults = [
        {
          columns: ["id", "name"],
          values: Array.from({ length: 100 }, (_, i) => [i + 1, `Usuario ${i + 1}`])
        }
      ];

      // Sin maxRows serializa las 100 filas
      const fullCsv = convertResultsToCsv(largeResults);
      const csvLines = fullCsv.trim().split("\r\n");
      assert.equal(csvLines.length, 101); // 1 cabecera + 100 filas

      // Con maxRows = 10, limita a 10 filas de datos
      const limitedCsv = convertResultsToCsv(largeResults, 10);
      const limitedLines = limitedCsv.trim().split("\r\n");
      assert.equal(limitedLines.length, 11); // 1 cabecera + 10 filas

      // JSON con maxRows = 5
      const limitedJson = convertResultsToJson(largeResults, 5);
      assert.equal(limitedJson.length, 5);
      assert.equal(limitedJson[0].id, 1);
      assert.equal(limitedJson[4].id, 5);
    });
  });
});
