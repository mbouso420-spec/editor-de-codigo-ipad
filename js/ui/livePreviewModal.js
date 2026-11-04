import { normalizePath } from "../storage/workspaceDb.js";
import { buildLoopGuardRuntime, instrumentLoops } from "../preview/loopGuard.js";
import { buildSqlRunnerPreview } from "../preview/sqlRunner.js";
import { buildCRunnerPreview, mountCRunnerView } from "../preview/cRunner.js";

const ACORN_URL = "https://esm.sh/acorn@8.14.0";
let acornModule = null;
let acornLoading = null;

/** Carga (una sola vez) el analizador de JS usado para proteger los bucles. Sin red, la vista previa sigue sin protección. */
function loadAcorn() {
  if (!acornLoading) {
    acornLoading = Promise.race([
      import(ACORN_URL),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 5000))
    ])
      .then((mod) => {
        acornModule = mod && typeof mod.parse === "function" ? mod : null;
        return acornModule;
      })
      .catch(() => {
        acornLoading = null; // reintentar la próxima vez que se abra la vista previa
        return null;
      });
  }
  return acornLoading;
}

/** Inserta el guardián de bucles si el analizador está disponible. */
function guardJs(code, isModule = false) {
  if (!acornModule) return code;
  return instrumentLoops(code, acornModule, { module: isModule }).code;
}

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
const CSS_EXTENSIONS = new Set(["css"]);
const PYTHON_EXTENSIONS = new Set(["py", "pyw"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const SQL_EXTENSIONS = new Set(["sql"]);
const C_EXTENSIONS = new Set(["c", "h"]);
const CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp"]);

/**
 * Vista previa contextual según la pestaña activa:
 * - Si la pestaña es .html -> "Vista previa de HTML" (ensambla CSS y JS de su misma carpeta/subcarpetas).
 * - Si la pestaña es .js   -> "Vista previa de JS" (ejecuta el JS mostrando su salida en pantalla y consola,
 *                             o junto al HTML de su misma carpeta si forman un proyecto web conjunto).
 * - Si la pestaña es .py   -> "Vista previa de Python" (ejecuta Python 3 real en el navegador vía Pyodide WebAssembly,
 *                             incluyendo módulos .py vecinos de su misma carpeta, print() e input()).
 * - Si la pestaña es .css  -> "Vista previa de CSS" (aplica sobre el HTML de su misma carpeta si existe).
 * - Cualquier otro archivo (.c, .cpp, .sql, etc.) -> informa claramente que la vista previa no está disponible.
 */
export function initLivePreviewModal({
  getWorkspaceSnapshot,
  onBeforePreview,
  onErrorMarker,
  onClearErrorMarkers,
  onGoToLine,
  ensureFileLoaded,
  ensureFilesLoaded
}) {
  const openBtn = document.getElementById("btn-live-preview");
  const dialog = document.getElementById("preview-dialog");
  const titleEl = document.getElementById("preview-dialog-title");
  const fileBadgeEl = document.getElementById("preview-file-badge");
  const jsModeBtn = document.getElementById("btn-preview-js-mode");
  const closeBtn = document.getElementById("btn-close-preview");
  const reloadBtn = document.getElementById("btn-preview-reload");
  const toggleConsoleBtn = document.getElementById("btn-preview-console");
  const clearConsoleBtn = document.getElementById("btn-preview-clear-console");
  const unavailableBox = document.getElementById("preview-unavailable-state");
  const unavailableTitleEl = document.getElementById("preview-unavailable-title");
  const unavailableDescEl = document.getElementById("preview-unavailable-desc");
  const consolePanel = document.getElementById("preview-console-panel");
  const consoleTitleEl = document.getElementById("preview-console-title");
  const consoleList = document.getElementById("preview-console-list");
  const iframeWrapper = document.getElementById("preview-iframe-wrapper");
  const iframe = document.getElementById("preview-iframe");
  const cRunnerContainer = document.getElementById("preview-c-runner");
  const pageSelect = document.getElementById("preview-page-select");
  const backBtn = document.getElementById("btn-preview-back");
  const forwardBtn = document.getElementById("btn-preview-forward");
  const navControls = dialog?.querySelector(".preview-nav-controls");

  let consoleVisible = true;
  let previewRunSeq = 0;
  let currentPreviewPath = null;
  /** @type {"auto" | "standalone" | "folder"} */
  let jsRunOverride = "auto";
  let activeCRunnerDestroy = null;

  let historyStack = [];
  let historyIndex = -1;

  function updateNavButtons() {
    if (backBtn) backBtn.disabled = historyIndex <= 0;
    if (forwardBtn) forwardBtn.disabled = historyIndex >= historyStack.length - 1;
  }

  function hideWebNavigationControls() {
    if (pageSelect) pageSelect.hidden = true;
    if (navControls) navControls.hidden = true;
  }

  function syncPageSelect(allFiles, activeHtmlPath) {
    if (!pageSelect) return;
    const validHtmlFiles = (allFiles || []).filter((f) => {
      if (!f || !f.path) return false;
      const clean = normalizePath(f.path);
      const parts = clean.split("/");
      for (const part of parts) {
        if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
      }
      const ext = getFileExtension(f.path);
      return HTML_EXTENSIONS.has(ext);
    });

    const uniqueMap = new Map();
    for (const hf of validHtmlFiles) {
      const clean = normalizePath(hf.path);
      if (!uniqueMap.has(clean)) {
        uniqueMap.set(clean, hf);
      }
    }
    const htmlFiles = Array.from(uniqueMap.values());

    if (htmlFiles.length === 0) {
      hideWebNavigationControls();
      return;
    }

    const nameCount = new Map();
    for (const hf of htmlFiles) {
      const base = hf.path.split("/").pop();
      nameCount.set(base, (nameCount.get(base) || 0) + 1);
    }

    pageSelect.innerHTML = "";
    for (const hf of htmlFiles) {
      const opt = document.createElement("option");
      opt.value = hf.path;
      const base = hf.path.split("/").pop();
      opt.textContent = (nameCount.get(base) > 1 || hf.path.includes("/")) ? hf.path : base;
      if (normalizePath(hf.path) === normalizePath(activeHtmlPath)) {
        opt.selected = true;
      }
      pageSelect.appendChild(opt);
    }

    pageSelect.hidden = false;
    if (navControls) navControls.hidden = false;
  }

  pageSelect?.addEventListener("change", () => {
    if (pageSelect.value) {
      void navigateToHtml(pageSelect.value, true);
    }
  });

  backBtn?.addEventListener("click", () => {
    if (historyIndex > 0) {
      historyIndex -= 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  });

  forwardBtn?.addEventListener("click", () => {
    if (historyIndex < historyStack.length - 1) {
      historyIndex += 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  });

  async function prepareHtmlForPreview(targetFile, allFiles) {
    if (!targetFile) return { html: "", assetMap: new Map() };

    // 1. Si el HTML está pendiente de descarga bajo demanda (lazy en GitHub), descargarlo primero
    if (targetFile.contentLoaded === false || (targetFile.content === "" && targetFile.blobSha)) {
      if (typeof ensureFileLoaded === "function") {
        await ensureFileLoaded(targetFile);
      }
    }

    // 2. Extraer todos los assets locales referenciados por el HTML
    const referencedPaths = extractReferencedAssetPaths(targetFile.path, targetFile.content || "");
    const unloadedToFetch = [];

    for (const refPath of referencedPaths) {
      const assetFile = (allFiles || []).find((f) => normalizePath(f.path) === normalizePath(refPath));
      if (assetFile && (assetFile.contentLoaded === false || (assetFile.content === "" && assetFile.blobSha))) {
        unloadedToFetch.push(assetFile);
      }
    }

    // 3. Descargar en lote los assets pendientes desde GitHub
    if (unloadedToFetch.length > 0 && typeof ensureFilesLoaded === "function") {
      await ensureFilesLoaded(unloadedToFetch);
    }

    // 4. Revisar si entre los CSS descargados hay reglas @import url(...) que a su vez requieran descarga
    const secondaryUnloaded = [];
    for (const refPath of referencedPaths) {
      const assetFile = (allFiles || []).find((f) => normalizePath(f.path) === normalizePath(refPath));
      if (assetFile && getFileExtension(assetFile.path) === "css" && typeof assetFile.content === "string") {
        const cssImports = extractCssImportPaths(assetFile.path, assetFile.content);
        for (const impPath of cssImports) {
          const impFile = (allFiles || []).find((f) => normalizePath(f.path) === normalizePath(impPath));
          if (impFile && (impFile.contentLoaded === false || (impFile.content === "" && impFile.blobSha))) {
            secondaryUnloaded.push(impFile);
          }
        }
      }
    }
    if (secondaryUnloaded.length > 0 && typeof ensureFilesLoaded === "function") {
      await ensureFilesLoaded(secondaryUnloaded);
    }

    // 5. Construir mapa de assets del proyecto completo
    const assetMap = buildWorkspaceAssetMap(allFiles);
    return {
      html: targetFile.content || "",
      assetMap
    };
  }

  async function navigateToHtml(targetPath, pushHistory = true) {
    const { files } = getWorkspaceSnapshot();
    const targetFile = files.find((f) => normalizePath(f.path) === normalizePath(targetPath));
    if (!targetFile) return;

    currentPreviewPath = targetFile.path;

    if (pushHistory) {
      if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
      }
      historyStack.push(targetFile.path);
      historyIndex = historyStack.length - 1;
    }
    updateNavButtons();
    syncPageSelect(files, targetFile.path);

    const { html, assetMap } = await prepareHtmlForPreview(targetFile, files);
    const compiledHtml = bundleHtmlWithFolderAssets(targetFile.path, html, assetMap, null, guardJs, null, true);

    showRunnableIframe({
      headerTitle: "Vista previa de HTML",
      badgeText: targetFile.path,
      compiledHtml,
      siblingHtml: null
    });
  }

  const deviceButtons = dialog?.querySelectorAll(".preview-device-btn") || [];
  deviceButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const device = btn.getAttribute("data-device") || "desktop";
      deviceButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      if (iframe) {
        iframe.className = `preview-iframe device-${device}`;
      }
    });
  });

  // Precargar el analizador Acorn en segundo plano para tener el guardián listo de inmediato
  if (typeof window !== "undefined") {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => void loadAcorn());
    } else {
      window.setTimeout(() => void loadAcorn(), 1500);
    }
  }

  openBtn?.addEventListener("click", async () => {
    jsRunOverride = "auto";
    if (typeof onBeforePreview === "function") {
      await onBeforePreview();
    }
    await loadAcorn();
    await openPreview();
  });

  closeBtn?.addEventListener("click", () => {
    stopIframe();
    dialog?.close();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      stopIframe();
      dialog.close();
    }
  });

  jsModeBtn?.addEventListener("click", () => {
    jsRunOverride = jsRunOverride === "folder" ? "standalone" : "folder";
    void renderActiveTabPreview();
  });

  reloadBtn?.addEventListener("click", () => {
    void renderActiveTabPreview();
  });

  toggleConsoleBtn?.addEventListener("click", () => {
    consoleVisible = !consoleVisible;
    if (consolePanel && !iframe?.hidden) {
      consolePanel.hidden = !consoleVisible;
    }
    toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
  });

  clearConsoleBtn?.addEventListener("click", () => {
    clearConsoleOutput();
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "studio-ide-preview") {
      return;
    }
    if (!iframe || event.source !== iframe.contentWindow) {
      return;
    }
    if (data.action === "clear") {
      clearConsoleOutput();
      return;
    }
    if (data.action === "navigate" && typeof data.href === "string") {
      handlePreviewNavigation(data.href);
      return;
    }
    appendConsoleLine(data.level || "log", data.text || "");
  });

  function handlePreviewNavigation(href) {
    const { files } = getWorkspaceSnapshot();
    const targetFile = findTargetHtmlFile(files, currentPreviewPath, href);
    if (!targetFile) {
      appendConsoleLine("warn", `No se encontró "${href}" en el proyecto (navegación desde "${currentPreviewPath || 'raíz'}").`);
      return;
    }

    navigateToHtml(targetFile.path, true);
  }

  function stopIframe() {
    if (iframe) {
      iframe.srcdoc = "";
    }
    if (activeCRunnerDestroy && typeof activeCRunnerDestroy === "function") {
      activeCRunnerDestroy();
      activeCRunnerDestroy = null;
    }
  }

  function clearConsoleOutput() {
    if (!consoleList) return;
    consoleList.innerHTML = "";
  }

  function appendConsoleLine(level, text) {
    if (!consoleList) return;
    const item = document.createElement("div");
    item.className =
      level === "error"
        ? "preview-log-item is-error"
        : level === "warn"
          ? "preview-log-item is-warn"
          : "preview-log-item";
    item.textContent = text;
    consoleList.appendChild(item);
    consoleList.scrollTop = consoleList.scrollHeight;
  }

  async function openPreview() {
    if (!dialog) return;
    if (typeof onBeforePreview === "function") {
      try {
        await onBeforePreview();
      } catch (_) {}
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    await renderActiveTabPreview();
  }

  function showUnavailableState({ headerTitle, badgeText, messageTitle, messageDesc }) {
    stopIframe();
    clearConsoleOutput();
    hideWebNavigationControls();

    if (titleEl) titleEl.textContent = headerTitle;
    if (fileBadgeEl) {
      fileBadgeEl.textContent = badgeText || "";
      fileBadgeEl.hidden = !badgeText;
    }
    if (jsModeBtn) jsModeBtn.hidden = true;
    if (reloadBtn) reloadBtn.hidden = true;
    if (toggleConsoleBtn) toggleConsoleBtn.hidden = true;
    if (iframe) iframe.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = true;
    if (cRunnerContainer) cRunnerContainer.hidden = true;
    if (consolePanel) consolePanel.hidden = true;

    if (unavailableTitleEl) unavailableTitleEl.textContent = messageTitle;
    if (unavailableDescEl) unavailableDescEl.textContent = messageDesc;
    if (unavailableBox) unavailableBox.hidden = false;
  }

  function showRunnableIframe({
    headerTitle,
    badgeText,
    compiledHtml,
    siblingHtml,
    consoleTitle = "Consola JS",
    hasConsole = true
  }) {
    clearConsoleOutput();
    if (cRunnerContainer) cRunnerContainer.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = false;

    if (titleEl) titleEl.textContent = headerTitle;
    if (consoleTitleEl) consoleTitleEl.textContent = consoleTitle;
    if (fileBadgeEl) {
      fileBadgeEl.textContent = badgeText || "";
      fileBadgeEl.hidden = !badgeText;
    }

    if (unavailableBox) unavailableBox.hidden = true;
    if (reloadBtn) reloadBtn.hidden = false;
    if (toggleConsoleBtn) {
      toggleConsoleBtn.hidden = !hasConsole;
      toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
    }
    if (iframe) {
      previewRunSeq += 1;
      iframe.hidden = false;
      iframe.srcdoc = `${compiledHtml}\n<!-- studio-run:${previewRunSeq} -->`;
    }
    if (consolePanel) {
      consolePanel.hidden = !hasConsole || !consoleVisible;
    }

    if (jsModeBtn) {
      if (siblingHtml) {
        jsModeBtn.hidden = false;
        jsModeBtn.textContent =
          jsRunOverride === "folder"
            ? "Ejecutar solo este .js"
            : `Ver junto a ${siblingHtml.shortName}`;
      } else {
        jsModeBtn.hidden = true;
      }
    }
  }

  function showCRunnerView(activeFile, companionFiles = []) {
    stopIframe();
    clearConsoleOutput();
    hideWebNavigationControls();

    const ext = getFileExtension(activeFile.path);
    const isC = C_EXTENSIONS.has(ext);
    if (titleEl) {
      if (ext === "h" || ext === "hpp") {
        titleEl.textContent = ext === "h" ? "Cabecera C (.h)" : "Cabecera C++ (.hpp)";
      } else {
        titleEl.textContent = isC ? "Compilador C (GCC)" : "Compilador C++ (G++)";
      }
    }
    if (fileBadgeEl) {
      fileBadgeEl.textContent = activeFile.path;
      fileBadgeEl.hidden = false;
    }

    if (unavailableBox) unavailableBox.hidden = true;
    if (iframe) iframe.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = true;
    if (consolePanel) consolePanel.hidden = true;
    if (jsModeBtn) jsModeBtn.hidden = true;
    if (reloadBtn) reloadBtn.hidden = true;
    if (toggleConsoleBtn) toggleConsoleBtn.hidden = true;

    if (cRunnerContainer) {
      cRunnerContainer.hidden = false;
      const runnerInstance = mountCRunnerView(cRunnerContainer, {
        activeFile,
        companionFiles,
        onCompilerResult({ success, errors }) {
          if (!success && errors && errors.length > 0) {
            if (typeof onClearErrorMarkers === "function") {
              onClearErrorMarkers();
            }
            for (const err of errors) {
              if (typeof onErrorMarker === "function") {
                onErrorMarker(err.line, err.message);
              }
            }
          } else if (success) {
            if (typeof onClearErrorMarkers === "function") {
              onClearErrorMarkers();
            }
          }
        },
        onGoToLine(lineNum) {
          if (typeof onGoToLine === "function") {
            onGoToLine(lineNum);
          }
        }
      });
      activeCRunnerDestroy = runnerInstance?.destroy || null;
    }
  }

  async function renderActiveTabPreview() {
    const { files, activeFileId } = getWorkspaceSnapshot();
    const activeFile = activeFileId
      ? files.find((f) => normalizePath(f.path) === normalizePath(activeFileId)) || null
      : null;

    if (!activeFile) {
      showUnavailableState({
        headerTitle: "Vista previa",
        badgeText: "",
        messageTitle: "No hay ninguna pestaña activa",
        messageDesc: "Abrí un archivo en el editor central para ver su vista previa."
      });
      return;
    }

    currentPreviewPath = activeFile.path;

    const ext = getFileExtension(activeFile.path);
    const extLabel = ext ? `.${ext}` : "sin extensión";
    const folder = getParentFolder(activeFile.path);
    const sameFolderFiles = filterFolderScopeFiles(files, folder);

    // 1. Pestaña HTML: ensambla recursos relativos de todo el proyecto web
    if (HTML_EXTENSIONS.has(ext)) {
      currentPreviewPath = activeFile.path;
      historyStack = [activeFile.path];
      historyIndex = 0;
      updateNavButtons();
      syncPageSelect(files, activeFile.path);

      const { html, assetMap } = await prepareHtmlForPreview(activeFile, files);
      const compiledHtml = bundleHtmlWithFolderAssets(activeFile.path, html, assetMap, null, guardJs, null, true);
      showRunnableIframe({
        headerTitle: "Vista previa de HTML",
        badgeText: activeFile.path,
        compiledHtml,
        siblingHtml: null
      });
      return;
    }

    // 2. Pestaña JS: ejecuta el archivo .js (asociado al HTML del proyecto o en sandbox aislado)
    if (JS_EXTENSIONS.has(ext)) {
      const bestHtml = findBestHtmlEntrypoint(files, activeFile);

      if (jsRunOverride === "auto") {
        jsRunOverride = bestHtml ? "folder" : "standalone";
      }

      if (jsRunOverride === "folder" && bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        assetMap.set(normalizePath(activeFile.path), activeFile);

        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          activeFile,
          guardJs,
          null,
          true
        );
        showRunnableIframe({
          headerTitle: "Vista previa de JS",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: bestHtml
        });
        return;
      }

      hideWebNavigationControls();
      const compiledJsHtml = buildStandaloneJsPreview(activeFile, guardJs);
      showRunnableIframe({
        headerTitle: "Vista previa de JS",
        badgeText: activeFile.path,
        compiledHtml: compiledJsHtml,
        siblingHtml: bestHtml
      });
      return;
    }

    // 3. Pestaña CSS: se previsualiza resolviendo de forma inteligente el HTML principal del proyecto
    if (CSS_EXTENSIONS.has(ext)) {
      const bestHtml = findBestHtmlEntrypoint(files, activeFile);
      if (bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        assetMap.set(normalizePath(activeFile.path), activeFile);

        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          null,
          guardJs,
          activeFile,
          true
        );
        showRunnableIframe({
          headerTitle: "Vista previa de CSS",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: null
        });
      } else {
        hideWebNavigationControls();
        showUnavailableState({
          headerTitle: "Vista previa de CSS",
          badgeText: activeFile.path,
          messageTitle: `No hay ningún archivo .html en el proyecto para ${activeFile.shortName}`,
          messageDesc: "Creá un archivo .html en el proyecto para ver estos estilos aplicados en vivo."
        });
      }
      return;
    }

    // 4. Pestaña Python: ejecuta Python 3 real en el navegador (Pyodide WebAssembly) con entrada inline sin popups
    if (PYTHON_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledPyHtml = buildStandalonePythonPreview(activeFile, sameFolderFiles, folder);
      showRunnableIframe({
        headerTitle: "Vista previa de Python",
        badgeText: activeFile.path,
        compiledHtml: compiledPyHtml,
        siblingHtml: null,
        consoleTitle: "Consola Python",
        hasConsole: true
      });
      return;
    }

    // 5. Pestaña Markdown (.md / README.md): documento formateado limpio
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledMdHtml = buildMarkdownPreview(activeFile);
      showRunnableIframe({
        headerTitle: "Vista previa de Markdown",
        badgeText: activeFile.path,
        compiledHtml: compiledMdHtml,
        siblingHtml: null,
        hasConsole: false
      });
      return;
    }

    // 6. Pestaña SQL (.sql): base de datos SQLite interactiva en WebAssembly
    if (SQL_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledSqlHtml = buildSqlRunnerPreview(activeFile, sameFolderFiles);
      showRunnableIframe({
        headerTitle: "Vista previa de SQL (SQLite)",
        badgeText: activeFile.path,
        compiledHtml: compiledSqlHtml,
        siblingHtml: null,
        consoleTitle: "Consola SQL",
        hasConsole: true
      });
      return;
    }

    // 7. Pestaña C / C++ (.c, .cpp, .cxx, .cc, .h, .hpp): Runner C/C++ nativo sin iframe
    if (C_EXTENSIONS.has(ext) || CPP_EXTENSIONS.has(ext)) {
      showCRunnerView(activeFile, sameFolderFiles);
      return;
    }

    // 8. Extensiones no soportadas
    hideWebNavigationControls();
    showUnavailableState({
      headerTitle: "Vista previa",
      badgeText: activeFile.path,
      messageTitle: `La vista previa no está disponible para este archivo ${extLabel}`,
      messageDesc: "La vista previa en vivo ejecuta archivos .html, .js, .css (en conjunto con el proyecto web), scripts .py de Python, bases de datos .sql de SQLite, código C/C++ y documentos .md."
    });
  }

  return {
    openPreview
  };
}

function getFileExtension(path) {
  const base = String(path || "").split("/").pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

function getParentFolder(path) {
  const clean = normalizePath(path);
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}

const MAX_PREVIEW_ASSET_BYTES = 512 * 1024; // 512 KB por recurso individual para evitar bloqueos
export const IGNORED_PREVIEW_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "venv",
  ".venv",
  "target",
  "bin",
  "obj",
  ".turbo",
  "out"
]);

/**
 * Filtra únicamente los archivos que pertenecen a la misma carpeta base (y subcarpetas relativas de ese conjunto),
 * omitiendo carpetas masivas (node_modules, dist, etc.) y archivos sin contenido descargado (lazy).
 */
export function filterFolderScopeFiles(allFiles, baseFolder) {
  if (!Array.isArray(allFiles)) return [];
  const cleanBase = baseFolder ? normalizePath(baseFolder) : "";
  const prefix = cleanBase ? `${cleanBase}/` : "";

  return allFiles.filter((f) => {
    if (!f || !f.path) return false;
    const clean = normalizePath(f.path);

    // Omitir carpetas pesadas de compilación o dependencias
    const parts = clean.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }

    // Omitir archivos no descargados todavía (lazy de GitHub)
    if (f.content === null || f.content === undefined) return false;

    if (prefix && !clean.startsWith(prefix)) return false;

    return true;
  });
}

/**
 * Construye un mapa de todos los archivos del espacio de trabajo disponibles para la vista previa,
 * indexados por su ruta normalizada y excluyendo directorios pesados (node_modules, dist, .git, etc.).
 * @param {Array<{ path: string, content: string }>} allFiles
 * @returns {Map<string, { path: string, content: string }>}
 */
export function buildWorkspaceAssetMap(allFiles) {
  const map = new Map();
  for (const f of allFiles || []) {
    if (!f || !f.path) continue;
    const clean = normalizePath(f.path);
    const parts = clean.split("/");
    let isIgnored = false;
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) {
        isIgnored = true;
        break;
      }
    }
    if (!isIgnored) {
      map.set(clean, f);
      const baseName = f.shortName || clean.split("/").pop();
      if (baseName && !map.has(baseName)) {
        map.set(baseName, f);
      }
    }
  }
  return map;
}

/**
 * Extrae todas las rutas relativas de hojas CSS y scripts JS referenciados por el HTML.
 * @param {string} entryPath
 * @param {string} rawHtml
 * @returns {string[]}
 */
export function extractReferencedAssetPaths(entryPath, rawHtml) {
  if (!rawHtml || typeof rawHtml !== "string") return [];
  const dir = getParentFolder(entryPath);
  const paths = new Set();

  const linkRegex = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(rawHtml)) !== null) {
    const hrefMatch = match[0].match(/href=["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1] && !/^(https?:|data:|blob:|\/\/)/i.test(hrefMatch[1])) {
      const cleanRef = hrefMatch[1].split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }

  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = scriptRegex.exec(rawHtml)) !== null) {
    const srcMatch = match[0].match(/src=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1] && !/^(https?:|data:|blob:|\/\/)/i.test(srcMatch[1])) {
      const cleanRef = srcMatch[1].split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }

  return Array.from(paths);
}

/**
 * Extrae las rutas locales de reglas @import url(...) presentes en un archivo CSS.
 * @param {string} cssPath
 * @param {string} cssContent
 * @returns {string[]}
 */
export function extractCssImportPaths(cssPath, cssContent) {
  if (!cssContent || typeof cssContent !== "string") return [];
  const dir = getParentFolder(cssPath);
  const paths = new Set();
  const importRegex = /@import\s+(?:url\(\s*["']?|["'])([^"')]+)["']?\s*\)?\s*;?/gi;
  let match;
  while ((match = importRegex.exec(cssContent)) !== null) {
    const importUrl = match[1];
    if (importUrl && !/^(https?:|data:|blob:|\/\/)/i.test(importUrl)) {
      const cleanRef = importUrl.split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }
  return Array.from(paths);
}

/**
 * Resuelve de forma inteligente el mejor archivo HTML de entrada para previsualizar
 * cuando la pestaña activa es un archivo .js o .css.
 * Prioridades:
 * 1. HTML que importe o referencie explícitamente ese archivo (<script src="..."> o <link href="...">).
 * 2. index.html en la misma carpeta o en la raíz del proyecto.
 * 3. Cualquier index.html o archivo .html disponible en el workspace.
 * @param {Array<{ path: string, shortName?: string, content: string }>} allFiles
 * @param {{ path: string, shortName?: string, content?: string }} activeFile
 * @returns {{ path: string, shortName: string, content: string } | null}
 */
export function findBestHtmlEntrypoint(allFiles, activeFile) {
  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path) return false;
    const clean = normalizePath(f.path);
    const parts = clean.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && typeof f.content === "string";
  });
  if (htmlFiles.length === 0) return null;

  const activePath = normalizePath(activeFile.path);
  const activeShort = activeFile.shortName || activePath.split("/").pop();
  const activeFolder = getParentFolder(activePath);
  const escapedName = activeShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 1. Prioridad: HTML que lo referencie explícitamente (<script src="..."> o <link href="...">)
  const scriptRegex = new RegExp(`<script[^>]+src=["'][^"']*${escapedName}["']`, "i");
  const linkRegex = new RegExp(`<link[^>]+href=["'][^"']*${escapedName}["']`, "i");

  const directRefs = htmlFiles.filter((f) => {
    const content = f.content || "";
    return scriptRegex.test(content) || linkRegex.test(content);
  });

  if (directRefs.length > 0) {
    const sameFolder = directRefs.find((f) => getParentFolder(f.path) === activeFolder);
    if (sameFolder) return sameFolder;
    const index = directRefs.find((f) => (f.shortName || "").toLowerCase() === "index.html");
    if (index) return index;
    return directRefs[0];
  }

  // 2. Prioridad: index.html en la misma carpeta
  const indexInSameFolder = htmlFiles.find(
    (f) => getParentFolder(f.path) === activeFolder && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInSameFolder) return indexInSameFolder;

  // 2b. Prioridad: index.html en la raíz del proyecto
  const indexInRoot = htmlFiles.find(
    (f) => !getParentFolder(f.path) && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInRoot) return indexInRoot;

  // 2c. Prioridad: Cualquier index.html en el workspace
  const anyIndex = htmlFiles.find((f) => (f.shortName || "").toLowerCase() === "index.html");
  if (anyIndex) return anyIndex;

  // 2d. Prioridad: Cualquier HTML en la misma carpeta
  const anyInSameFolder = htmlFiles.find((f) => getParentFolder(f.path) === activeFolder);
  if (anyInSameFolder) return anyInSameFolder;

  // 2e. El primer HTML disponible en el workspace
  return htmlFiles[0];
}

/**
 * Resuelve de forma tolerante el archivo HTML de destino al navegar dentro de la vista previa.
 * Admite enlaces relativos ('contacto.html', './contacto.html', '../contacto.html'),
 * absolutos ('/contacto.html') y sin extensión ('contacto').
 * @param {Array<{ path: string, shortName?: string, content: string }>} allFiles
 * @param {string} currentPreviewPath
 * @param {string} requestedHref
 * @returns {{ path: string, shortName: string, content: string } | null}
 */
export function findTargetHtmlFile(allFiles, currentPreviewPath, requestedHref) {
  if (!requestedHref || typeof requestedHref !== "string") return null;

  let clean = requestedHref.trim().split("?")[0].split("#")[0];
  if (!clean) return null;

  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path) return false;
    const cleanPath = normalizePath(f.path);
    const parts = cleanPath.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext);
  });
  if (htmlFiles.length === 0) return null;

  const currentFolder = currentPreviewPath ? getParentFolder(currentPreviewPath) : "";

  // 1. Ruta relativa directa desde la carpeta actual
  const relResolved = resolveRelativePath(currentFolder, clean);
  const match1 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(relResolved));
  if (match1) return match1;

  // 2. Ruta relativa añadiendo .html si no tenía extensión
  if (!clean.includes(".")) {
    const relHtml = resolveRelativePath(currentFolder, `${clean}.html`);
    const match2 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(relHtml));
    if (match2) return match2;
  }

  // 3. Ruta absoluta en el workspace
  const rootClean = clean.replace(/^\/+/, "");
  const match3 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(rootClean));
  if (match3) return match3;

  if (!rootClean.includes(".")) {
    const match4 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(`${rootClean}.html`));
    if (match4) return match4;
  }

  // 4. Búsqueda por nombre de archivo base (shortName) en todo el workspace
  const targetBase = rootClean.split("/").pop();
  const match5 = htmlFiles.find(
    (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === targetBase.toLowerCase()
  );
  if (match5) return match5;

  if (!targetBase.includes(".")) {
    const match6 = htmlFiles.find(
      (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === `${targetBase.toLowerCase()}.html`
    );
    if (match6) return match6;
  }

  return null;
}

export function findSiblingHtmlInSameFolder(scopeFiles, folder, targetFile) {
  const htmlInSameDir = scopeFiles.filter((f) => {
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && getParentFolder(f.path) === folder;
  });

  if (htmlInSameDir.length === 0) {
    return null;
  }

  const preferred =
    htmlInSameDir.find((f) => f.shortName.toLowerCase() === "index.html") || htmlInSameDir[0];

  const escapedName = targetFile.shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linksThisJs = new RegExp(`src=["'][^"']*${escapedName}["']`, "i").test(preferred.content);

  return {
    file: preferred,
    linksThisJs
  };
}

export function bundleHtmlWithFolderAssets(
  entryPath,
  rawHtml,
  fileMap,
  ensureJsFile = null,
  transformJs = (code) => code,
  ensureCssFile = null,
  allowParentTraversal = false
) {
  const dir = getParentFolder(entryPath);

  const resolveAsset = (rawHref) => {
    if (!rawHref || /^(https?:|data:|blob:|\/\/)/i.test(rawHref)) {
      return null;
    }
    const cleanRef = rawHref.split("?")[0].split("#")[0];
    if (cleanRef.startsWith("../") && !allowParentTraversal) {
      return null;
    }
    const resolved = resolveRelativePath(dir, cleanRef);
    let asset = fileMap.get(resolved) || null;
    if (!asset && cleanRef.startsWith("./")) {
      asset = fileMap.get(resolveRelativePath(dir, cleanRef.slice(2))) || null;
    }
    if (!asset && !cleanRef.startsWith("/")) {
      asset = fileMap.get(normalizePath(cleanRef)) || null;
    }
    if (!asset || asset.content == null || typeof asset.content !== "string") {
      return null;
    }
    if (asset.content.length > MAX_PREVIEW_ASSET_BYTES) {
      return null;
    }
    return asset;
  };

  let inlinedActiveJs = false;
  let inlinedActiveCss = false;
  const deferredScripts = [];

  function inlineCssImports(cssContent, cssPath, visited = new Set()) {
    const cleanPath = normalizePath(cssPath);
    if (visited.has(cleanPath)) return "";
    visited.add(cleanPath);

    const cssDir = getParentFolder(cleanPath);
    return cssContent.replace(/@import\s+(?:url\(\s*["']?|["'])([^"')]+)["']?\s*\)?\s*;?/gi, (match, importUrl) => {
      if (!importUrl || /^(https?:|data:|blob:|\/\/)/i.test(importUrl)) {
        return match;
      }
      const cleanRef = importUrl.split("?")[0].split("#")[0];
      if (cleanRef.startsWith("../") && !allowParentTraversal) {
        return match;
      }
      const resolved = resolveRelativePath(cssDir, cleanRef);
      let importedAsset = fileMap.get(resolved);
      if (!importedAsset && cleanRef.startsWith("./")) {
        importedAsset = fileMap.get(resolveRelativePath(cssDir, cleanRef.slice(2)));
      }
      if (!importedAsset && !cleanRef.startsWith("/")) {
        importedAsset = fileMap.get(normalizePath(cleanRef));
      }
      if (importedAsset && typeof importedAsset.content === "string") {
        return `/* @import "${cleanRef}" */\n` + inlineCssImports(importedAsset.content, importedAsset.path, visited);
      }
      return match;
    });
  }

  // Incrustar hojas CSS locales con soporte recursivo de @import
  let html = rawHtml.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return tag;
    const asset = resolveAsset(hrefMatch[1]);
    if (!asset) return tag;
    if (ensureCssFile && normalizePath(asset.path) === normalizePath(ensureCssFile.path)) {
      inlinedActiveCss = true;
    }
    const safeCss = inlineCssImports(asset.content, asset.path).replace(/<\/style>/gi, "<\\/style>");
    return `<style data-source="${escapeAttr(asset.path)}">\n${safeCss}\n</style>`;
  });

  // Si se especificó un archivo CSS activo y no estaba enlazado en el HTML, inyectarlo
  if (ensureCssFile && !inlinedActiveCss) {
    const safeExtraCss = inlineCssImports(ensureCssFile.content || "", ensureCssFile.path).replace(/<\/style>/gi, "<\\/style>");
    const styleTag = `<style data-source="${escapeAttr(ensureCssFile.path)}">\n${safeExtraCss}\n</style>`;
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${styleTag}`);
    } else {
      html = `${styleTag}\n${html}`;
    }
  }

  // Incrustar scripts JS locales respetando type="module" y defer
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (fullTag, attrs, inlineCode) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) {
      // Script escrito dentro del HTML: también se protege, salvo que no sea JavaScript (plantillas, JSON…)
      const typeMatch = attrs.match(/\btype=["']([^"']*)["']/i);
      const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
      const isJs = !type || type === "module" || type === "text/javascript" || type === "application/javascript";
      if (!isJs || !inlineCode.trim()) return fullTag;
      return `<script${attrs}>${transformJs(inlineCode, type === "module")}</script>`;
    }
    const asset = resolveAsset(srcMatch[1]);
    if (!asset) return fullTag;

    if (ensureJsFile && normalizePath(asset.path) === normalizePath(ensureJsFile.path)) {
      inlinedActiveJs = true;
    }

    const isModule = /\btype=["']module["']/i.test(attrs);
    const hasDefer = /\bdefer\b/i.test(attrs);
    const safeJs = transformJs(asset.content, isModule).replace(/<\/script>/gi, "<\\/script>");

    if (!isModule && hasDefer) {
      deferredScripts.push(`<script data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`);
      return "";
    }

    return `<script${isModule ? ' type="module"' : ""} data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`;
  });

  if (ensureJsFile && !inlinedActiveJs) {
    const safeExtraJs = transformJs(ensureJsFile.content, false).replace(/<\/script>/gi, "<\\/script>");
    deferredScripts.push(`<script data-source="${escapeAttr(ensureJsFile.path)}">\n${safeExtraJs}\n</script>`);
  }

  if (deferredScripts.length > 0) {
    const deferredBlock = deferredScripts.join("\n");
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, () => `${deferredBlock}\n</body>`);
    } else {
      html = `${html}\n${deferredBlock}`;
    }
  }

  const bridge = buildConsoleBridgeScript(false);
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${bridge}`);
  }
  return `${bridge}\n${html}`;
}

export function buildStandaloneJsPreview(jsFile, transformJs = (code) => code) {
  const bridge = buildConsoleBridgeScript(true);
  const isModule = /\b(import|export|await)\b/.test(jsFile.content);
  const safeJs = transformJs(jsFile.content, isModule).replace(/<\/script>/gi, "<\\/script>");
  const safeName = escapeHtmlText(jsFile.path);

  const scriptSnippet = isModule
    ? `<script type="module">
${safeJs}
</script>
<script type="module">
  window.addEventListener("load", function () {
    setTimeout(function () {
      var st = document.getElementById("__js_status");
      if (st && st.dataset.failed !== "1") {
        st.textContent = "Ejecutado correctamente (Módulo ES)";
      }
      var out = document.getElementById("__js_screen_log");
      if (out && out.children.length === 0) {
        var note = document.createElement("div");
        note.className = "js-empty";
        note.textContent = "El módulo JS se cargó sin errores. Usá console.log(...) para mostrar resultados acá.";
        out.appendChild(note);
      }
    }, 40);
  });
</script>`
    : `<script>
    try {
${safeJs}
      var st = document.getElementById("__js_status");
      if (st && st.dataset.failed !== "1") {
        st.textContent = "Ejecutado correctamente";
      }
      var out = document.getElementById("__js_screen_log");
      if (out && out.children.length === 0) {
        var note = document.createElement("div");
        note.className = "js-empty";
        note.textContent = "El archivo se ejecutó sin errores. Usá console.log(...) para mostrar resultados acá.";
        out.appendChild(note);
      }
    } catch (err) {
      var stErr = document.getElementById("__js_status");
      if (stErr) {
        stErr.dataset.failed = "1";
        stErr.style.color = "var(--err)";
        stErr.textContent = "Error en ejecución";
      }
      console.error(err && err.message ? err.message : String(err));
    }
  </script>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --ok: oklch(66% 0.14 152);
      --warn: oklch(74% 0.14 75);
      --err: oklch(62% 0.18 25);
      --font-ui: system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-ui);
    }
    .js-runner-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      overflow: hidden;
      margin-bottom: 16px;
    }
    .js-runner-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .js-runner-file {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }
    .js-runner-status {
      color: var(--ok);
      font-size: 12px;
    }
    .js-runner-output {
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .js-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 8px;
      border-radius: 4px;
      background: oklch(16.5% 0.012 255);
    }
    .js-line-warn { color: var(--warn); }
    .js-line-error { color: var(--err); }
    .js-empty { color: var(--muted); font-style: italic; }
    #app { margin-top: 12px; }
  </style>
  ${bridge}
</head>
<body>
  <section class="js-runner-card">
    <div class="js-runner-head">
      <span class="js-runner-file">${safeName}</span>
      <span id="__js_status" class="js-runner-status">Ejecutando…</span>
    </div>
    <div id="__js_screen_log" class="js-runner-output"></div>
  </section>
  <div id="app"></div>
  ${scriptSnippet}
</body>
</html>`;
}

function buildConsoleBridgeScript(mirrorOnScreen) {
  return `<script>
${buildLoopGuardRuntime()}
(function () {
  var mirror = ${mirrorOnScreen ? "true" : "false"};
  function formatArgs(args) {
    return Array.prototype.slice.call(args).map(function (item) {
      if (typeof item === "string") return item;
      try { return JSON.stringify(item, null, 2); } catch (_) { return String(item); }
    }).join(" ");
  }
  function send(level, args) {
    try {
      var msg = formatArgs(args);
      parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
      if (mirror) {
        var box = document.getElementById("__js_screen_log");
        if (box) {
          var row = document.createElement("div");
          row.className = level === "error" ? "js-line js-line-error" : level === "warn" ? "js-line js-line-warn" : "js-line";
          row.textContent = msg;
          box.appendChild(row);
        }
      }
    } catch (_) {}
  }
  var origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.log = function () { send("log", arguments); origLog.apply(console, arguments); };
  console.warn = function () { send("warn", arguments); origWarn.apply(console, arguments); };
  console.error = function () { send("error", arguments); origErr.apply(console, arguments); };
  window.addEventListener("error", function (e) {
    var stErr = document.getElementById("__js_status");
    if (stErr) {
      stErr.dataset.failed = "1";
      stErr.style.color = "var(--err)";
      stErr.textContent = "Error en ejecución";
    }
    var fromLoopGuard = /Bucle detenido en la línea/.test(e.message || "");
    send("error", [e.message + (e.lineno && !fromLoopGuard ? " (línea " + e.lineno + ")" : "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["Promesa rechazada: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
  });
  // Interceptor total de navegación local en enlaces
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#") || href.startsWith("javascript:")) return;
    if (/^(https?:|mailto:|tel:|blob:|data:)/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: href
    }, "*");
  }, true);

  // Interceptor de envíos de formularios locales
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var action = form.getAttribute("action");
    if (!action || action.startsWith("#") || action.startsWith("javascript:") || /^(https?:|mailto:|tel:)/i.test(action)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: action
    }, "*");
  }, true);

  // Interceptor de llamadas programáticas de navegación
  try {
    var triggerNav = function (targetUrl) {
      if (!targetUrl || typeof targetUrl !== "string") return;
      if (targetUrl.startsWith("#") || targetUrl.startsWith("javascript:") || /^(https?:|mailto:|tel:)/i.test(targetUrl)) {
        window.open(targetUrl, "_blank");
        return;
      }
      parent.postMessage({
        source: "studio-ide-preview",
        action: "navigate",
        href: targetUrl
      }, "*");
    };
    window.navigate = triggerNav;
    if (window.location) {
      window.location.assign = triggerNav;
      window.location.replace = triggerNav;
    }
  } catch (_) {}
})();
</script>`;
}

export function resolveRelativePath(baseDir, relPath) {
  if (relPath.startsWith("/")) {
    return normalizePath(relPath);
  }
  const stack = baseDir ? baseDir.split("/").filter(Boolean) : [];
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildStandalonePythonPreview(pyFile, sameFolderFiles, baseFolder) {
  const prefix = baseFolder ? `${baseFolder}/` : "";
  const modules = [];
  const modPrefixes = new Set();
  const TEXT_OR_DATA_EXTENSIONS = new Set([
    "json", "txt", "csv", "tsv", "sql", "xml", "yaml", "yml", "md"
  ]);

  for (const candidate of sameFolderFiles) {
    const ext = getFileExtension(candidate.path);
    const isPy = PYTHON_EXTENSIONS.has(ext);
    const isData = TEXT_OR_DATA_EXTENSIONS.has(ext);
    if (!isPy && !isData) continue;
    const cleanPath = normalizePath(candidate.path);
    if (cleanPath === normalizePath(pyFile.path)) continue;
    const relPath = prefix && cleanPath.startsWith(prefix) ? cleanPath.slice(prefix.length) : cleanPath;
    if (relPath && !relPath.startsWith("..")) {
      modules.push({ path: relPath, content: candidate.content });
      if (isPy) {
        const topMod = relPath.split("/")[0].replace(/\.(py|pyw)$/i, "");
        if (topMod) modPrefixes.add(topMod);
      }
    }
  }

  const pythonBootstrap = [
    "import builtins, json, random, sys, traceback",
    "if '.' not in sys.path:",
    "    sys.path.insert(0, '.')",
    "class _StudioPauseForInput(BaseException):",
    "    def __init__(self, prompt_text):",
    "        self.prompt_text = prompt_text",
    "for _mod_prefix in json.loads(__studio_mod_prefixes_json):",
    "    for _loaded in list(sys.modules.keys()):",
    "        if _loaded == _mod_prefix or _loaded.startswith(_mod_prefix + '.'):",
    "            sys.modules.pop(_loaded, None)",
    "random.seed(int(__studio_seed))",
    "_inputs = json.loads(__studio_inputs_json)",
    "_idx = 0",
    "def __studio_input(prompt=''):",
    "    global _idx",
    "    texto = str(prompt) if prompt is not None else ''",
    "    if _idx < len(_inputs):",
    "        item = _inputs[_idx]",
    "        _idx += 1",
    "        if item.get('cancelled'):",
    "            print(f'{texto}(cancelado)')",
    "            raise EOFError('Entrada cancelada por el usuario.')",
    "        val = str(item.get('value', ''))",
    "        print(f'{texto}{val}')",
    "        return val",
    "    raise _StudioPauseForInput(texto)",
    "builtins.input = __studio_input",
    "_result = {'status': 'ok'}",
    "_ns = {'__name__': '__main__', '__file__': __studio_entry_name}",
    "try:",
    "    exec(compile(__studio_entry_code, __studio_entry_name, 'exec'), _ns)",
    "except _StudioPauseForInput as _pause:",
    "    _result = {'status': 'need_input', 'prompt': _pause.prompt_text}",
    "except SystemExit:",
    "    pass",
    "except Exception as _exc:",
    "    _result = {'status': 'error'}",
    "    _tb = traceback.extract_tb(_exc.__traceback__)",
    "    _clean = [f for f in _tb if f.filename == __studio_entry_name or not f.filename.startswith('<')]",
    "    _lines = ['Traceback (most recent call last):']",
    "    for _f in _clean:",
    "        _lines.append(f'  Archivo \"{_f.filename}\", línea {_f.lineno}, en {_f.name}')",
    "    _lines.extend([l.rstrip('\\n') for l in traceback.format_exception_only(type(_exc), _exc)])",
    "    print('\\n'.join(_lines), file=sys.stderr)",
    "finally:",
    "    sys.stdout.flush()",
    "    sys.stderr.flush()",
    "json.dumps(_result)"
  ].join("\n");

  const payloadJson = JSON.stringify({
    entryName: pyFile.shortName,
    entryPath: pyFile.path,
    code: pyFile.content,
    modules,
    modPrefixes: [...modPrefixes],
    bootstrap: pythonBootstrap
  }).replace(/</g, "\\u003c");

  const safePathLabel = escapeHtmlText(pyFile.path);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --surface-input: oklch(16.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --accent-solid: oklch(52% 0.165 252);
      --accent-ink: oklch(98% 0.005 252);
      --ok: oklch(66% 0.14 152);
      --warn: oklch(74% 0.14 75);
      --err: oklch(62% 0.18 25);
      --font-ui: system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-ui);
    }
    .py-runner-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      overflow: hidden;
    }
    .py-runner-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .py-runner-file {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }
    .py-runner-status {
      color: var(--warn);
      font-size: 12px;
    }
    .py-runner-output {
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .py-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--surface-input);
    }
    .py-line-error { color: var(--err); }
    .py-empty { color: var(--muted); font-style: italic; }
    .py-input-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      background: var(--surface-input);
    }
    .py-input-bar[hidden] { display: none; }
    .py-input-prompt {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--accent);
      font-weight: 500;
    }
    .py-input-field {
      flex: 1;
      min-width: 160px;
      min-height: 36px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 16px;
    }
    .py-input-field:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .py-btn {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-ui);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .py-btn-primary {
      background: var(--accent-solid);
      border-color: var(--accent-solid);
      color: var(--accent-ink);
    }
    .py-runner-controls {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .py-btn-stop {
      min-height: 30px;
      padding: 4px 12px;
      border-color: var(--err);
      color: var(--err);
    }
    .py-btn-stop[hidden] { display: none; }
  </style>
</head>
<body>
  <section class="py-runner-card">
    <div class="py-runner-head">
      <span class="py-runner-file">${safePathLabel}</span>
      <span class="py-runner-controls">
        <span id="__py_status" class="py-runner-status">Iniciando motor Python 3 (WebAssembly)…</span>
        <button type="button" id="__py_stop" class="py-btn py-btn-stop" hidden>Detener</button>
      </span>
    </div>
    <div id="__py_screen_log" class="py-runner-output"></div>
    <form id="__py_input_form" class="py-input-bar" hidden>
      <label id="__py_input_prompt" for="__py_input_field" class="py-input-prompt">input():</label>
      <input id="__py_input_field" type="text" class="py-input-field" autocomplete="off" spellcheck="false" placeholder="Escribí un valor y tocá Enviar…">
      <button type="submit" class="py-btn py-btn-primary">Enviar</button>
      <button type="button" id="__py_input_cancel" class="py-btn">Cancelar</button>
    </form>
  </section>

  <script id="__py_payload" type="application/json">${payloadJson}</script>
  <script id="__py_runner_src" type="text/plain">
    var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/";
    var pyodide = null;
    var loading = null;
    function send(msg) { self.postMessage(msg); }
    function ensurePyodide() {
      if (pyodide) return Promise.resolve(pyodide);
      if (!loading) {
        send({ type: "status", text: "loading" });
        loading = (async function () {
          await __loadScript(PYODIDE_URL + "pyodide.js");
          var py = await loadPyodide({ indexURL: PYODIDE_URL });
          py.setStdout({ batched: function (line) { send({ type: "out", level: "log", text: line }); } });
          py.setStderr({ batched: function (line) { send({ type: "out", level: "error", text: line }); } });
          pyodide = py;
          return py;
        })();
      }
      return loading;
    }
    function ensureParentDirs(FS, filePath) {
      var parts = filePath.split("/");
      var current = "";
      for (var i = 0; i < parts.length - 1; i += 1) {
        current = current ? current + "/" + parts[i] : parts[i];
        try { FS.mkdir(current); } catch (_) {}
      }
    }
    function writeFiles(py, job) {
      ensureParentDirs(py.FS, job.entryName);
      try { py.FS.writeFile(job.entryName, job.code, { encoding: "utf8" }); } catch (_) {}
      if (job.entryPath && job.entryPath !== job.entryName) {
        ensureParentDirs(py.FS, job.entryPath);
        try { py.FS.writeFile(job.entryPath, job.code, { encoding: "utf8" }); } catch (_) {}
      }
      for (var i = 0; i < job.modules.length; i += 1) {
        var mod = job.modules[i];
        ensureParentDirs(py.FS, mod.path);
        py.FS.writeFile(mod.path, mod.content, { encoding: "utf8" });
      }
    }
    self.onmessage = async function (event) {
      var job = event.data;
      if (!job || job.type !== "run") return;
      try {
        var py = await ensurePyodide();
        send({ type: "status", text: "running" });
        writeFiles(py, job);
        py.globals.set("__studio_entry_name", job.entryName);
        py.globals.set("__studio_entry_code", job.code);
        py.globals.set("__studio_seed", job.seed);
        py.globals.set("__studio_inputs_json", JSON.stringify(job.inputs));
        py.globals.set("__studio_mod_prefixes_json", JSON.stringify(job.modPrefixes));
        var raw = await py.runPythonAsync(job.bootstrap);
        send({ type: "result", outcome: JSON.parse(String(raw || '{"status":"ok"}')) });
      } catch (err) {
        send({ type: "fatal", message: err && err.message ? String(err.message) : String(err) });
      }
    };
  </script>
  <script>
    (function () {
      var statusEl = document.getElementById("__py_status");
      var stopBtn = document.getElementById("__py_stop");
      var screenBox = document.getElementById("__py_screen_log");
      var inputForm = document.getElementById("__py_input_form");
      var inputPromptEl = document.getElementById("__py_input_prompt");
      var inputField = document.getElementById("__py_input_field");
      var cancelBtn = document.getElementById("__py_input_cancel");
      var payload = JSON.parse(document.getElementById("__py_payload").textContent);
      var runnerSrc = document.getElementById("__py_runner_src").textContent;

      var sessionSeed = Math.floor(Math.random() * 1000000000);
      var submittedInputs = [];
      var MAX_INPUT_STEPS = 200;
      var runner = null;
      var running = false;
      var runStartedAt = 0;
      var ticker = 0;
      var sawWorkerMessage = false;

      function clearOutputs() {
        if (screenBox) screenBox.innerHTML = "";
        try {
          parent.postMessage({ source: "studio-ide-preview", action: "clear" }, "*");
        } catch (_) {}
      }

      function emit(level, text) {
        var msg = String(text == null ? "" : text);
        try {
          parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
        } catch (_) {}
        if (screenBox) {
          var row = document.createElement("div");
          row.className = level === "error" ? "py-line py-line-error" : "py-line";
          row.textContent = msg;
          screenBox.appendChild(row);
        }
      }

      function setStatus(label, colorVar) {
        if (!statusEl) return;
        statusEl.textContent = label;
        statusEl.style.color = colorVar;
      }

      function setRunning(next) {
        running = next;
        window.clearInterval(ticker);
        if (stopBtn) stopBtn.hidden = !(next && runner && runner.canStop);
        if (next) {
          runStartedAt = Date.now();
          ticker = window.setInterval(function () {
            var secs = Math.floor((Date.now() - runStartedAt) / 1000);
            if (secs >= 1) {
              setStatus(
                secs >= 5
                  ? "Ejecutando… " + secs + " s (¿bucle infinito? Tocá Detener)"
                  : "Ejecutando… " + secs + " s",
                secs >= 5 ? "var(--warn)" : "var(--accent)"
              );
            }
          }, 1000);
        }
      }

      function loadScriptTag(url) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = url;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error("No se pudo descargar el motor Python 3 (Pyodide). Conectate a internet al menos una vez para almacenarlo en caché.")); };
          document.head.appendChild(s);
        });
      }

      // Respaldo: mismo ejecutor en el hilo principal (si el navegador no permite Workers aquí).
      // En este modo no se puede detener un bucle infinito.
      function createMainThreadRunner() {
        var fakeSelf = {
          postMessage: function (msg) { window.setTimeout(function () { handle(msg); }, 0); },
          onmessage: null
        };
        new Function("self", "__loadScript", runnerSrc)(fakeSelf, loadScriptTag);
        return {
          canStop: false,
          post: function (msg) { fakeSelf.onmessage({ data: msg }); },
          stop: function () {}
        };
      }

      // Normal: el motor Python corre en un Worker. Si el script entra en un bucle infinito,
      // la página y el IDE siguen respondiendo y "Detener" lo corta al instante.
      function createRunner() {
        try {
          var prefix = "var __loadScript = function (url) { importScripts(url); return Promise.resolve(); };\\n";
          var blobUrl = URL.createObjectURL(new Blob([prefix + runnerSrc], { type: "text/javascript" }));
          var worker = new Worker(blobUrl);
          var r = {
            canStop: true,
            post: function (msg) { worker.postMessage(msg); },
            stop: function () { worker.terminate(); }
          };
          worker.onmessage = function (event) {
            sawWorkerMessage = true;
            handle(event.data);
          };
          worker.onerror = function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (!sawWorkerMessage && runner === r) {
              // El Worker no pudo arrancar en este navegador: reintentar en el hilo principal.
              worker.terminate();
              runner = createMainThreadRunner();
              executePass();
              return;
            }
            handle({ type: "fatal", message: event && event.message ? event.message : "Error en el motor Python." });
          };
          return r;
        } catch (_) {
          return createMainThreadRunner();
        }
      }

      function handle(msg) {
        if (!msg) return;
        if (msg.type === "out") {
          emit(msg.level, msg.text);
          return;
        }
        if (msg.type === "status") {
          if (msg.text === "loading") setStatus("Iniciando motor Python 3 (WebAssembly)…", "var(--warn)");
          if (msg.text === "running") setStatus("Ejecutando script…", "var(--accent)");
          return;
        }
        if (msg.type === "fatal") {
          setRunning(false);
          setStatus("Error al iniciar Python", "var(--err)");
          emit("error", msg.message);
          return;
        }
        if (msg.type === "result") {
          setRunning(false);
          var outcome = msg.outcome || { status: "ok" };
          if (outcome.status === "need_input") {
            setStatus("Esperando entrada en consola…", "var(--warn)");
            if (inputPromptEl) inputPromptEl.textContent = outcome.prompt || "Entrada (input):";
            if (inputForm && inputField) {
              inputField.value = "";
              inputForm.hidden = false;
              inputField.focus();
            }
            return;
          }
          if (outcome.status === "error") {
            setStatus("Error en ejecución", "var(--err)");
          } else {
            setStatus("Ejecutado correctamente", "var(--ok)");
            if (screenBox && screenBox.children.length === 0) {
              var note = document.createElement("div");
              note.className = "py-empty";
              note.textContent = "El script Python finalizó sin errores. Usá print(...) para mostrar resultados acá.";
              screenBox.appendChild(note);
            }
          }
        }
      }

      function executePass() {
        if (inputForm) inputForm.hidden = true;
        if (submittedInputs.length > MAX_INPUT_STEPS) {
          emit("error", "Se superó el límite de 200 lecturas input() consecutivas.");
          setStatus("Detenido por límite de entradas", "var(--err)");
          return;
        }
        if (!runner) runner = createRunner();
        clearOutputs();
        setRunning(true);
        runner.post({
          type: "run",
          entryName: payload.entryName,
          entryPath: payload.entryPath,
          code: payload.code,
          modules: payload.modules,
          modPrefixes: payload.modPrefixes,
          bootstrap: payload.bootstrap,
          inputs: submittedInputs,
          seed: sessionSeed
        });
      }

      if (stopBtn) {
        stopBtn.addEventListener("click", function () {
          if (!running || !runner || !runner.canStop) return;
          runner.stop();
          runner = null;
          setRunning(false);
          if (inputForm) inputForm.hidden = true;
          setStatus("Ejecución detenida", "var(--err)");
          emit("error", "Ejecución detenida por el usuario. Tocá Recargar para volver a ejecutar.");
        });
      }

      if (inputForm) {
        inputForm.addEventListener("submit", function (ev) {
          ev.preventDefault();
          submittedInputs.push({ value: inputField ? inputField.value : "" });
          executePass();
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          submittedInputs.push({ cancelled: true });
          executePass();
        });
      }

      executePass();
    })();
  </script>
</body>
</html>`;
}

function buildMarkdownPreview(mdFile) {
  const renderedBody = renderMarkdownDocumentHtml(mdFile.content || "");
  const safeTitle = escapeHtmlText(mdFile.shortName);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --code-bg: oklch(18% 0.013 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --ink-2: oklch(83% 0.011 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --font-body: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 24px 48px;
      background: var(--bg);
      color: var(--ink-2);
      font-family: var(--font-body);
      font-size: 15px;
      line-height: 1.68;
    }
    .md-article {
      max-width: 760px;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      color: var(--ink);
      margin: 1.4em 0 0.55em;
      line-height: 1.3;
      overflow-wrap: break-word;
    }
    h1 { font-size: 1.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35em; margin-top: 0; }
    h2 { font-size: 1.35rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
    h3 { font-size: 1.12rem; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
    ul, ol { padding-left: 1.5em; }
    li + li { margin-top: 0.28em; }
    a { color: var(--accent); text-underline-offset: 0.18em; }
    code {
      font-family: var(--font-mono);
      font-size: 0.86em;
      padding: 0.15em 0.4em;
      border-radius: 5px;
      background: var(--card);
      color: var(--ink);
    }
    pre {
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      overflow-x: auto;
    }
    pre code {
      padding: 0;
      background: transparent;
      font-size: 13px;
      line-height: 1.6;
    }
    blockquote {
      padding: 8px 14px;
      border-left: 3px solid var(--accent);
      background: var(--card);
      border-radius: 0 6px 6px 0;
      color: var(--ink-2);
    }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 1.6em 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background: var(--card);
      color: var(--ink);
      font-weight: 600;
    }
    .md-empty {
      color: var(--muted);
      font-style: italic;
    }
  </style>
</head>
<body>
  <article class="md-article">
    ${renderedBody || '<p class="md-empty">Este archivo Markdown está vacío.</p>'}
  </article>
</body>
</html>`;
}

export function renderMarkdownDocumentHtml(rawMd) {
  const blocks = [];
  const fenceRe = /```([^\r\n]*)\r?\n?([\s\S]*?)```/g;
  let cursor = 0;
  let m;

  while ((m = fenceRe.exec(rawMd)) !== null) {
    if (m.index > cursor) {
      blocks.push({ type: "prose", text: rawMd.slice(cursor, m.index) });
    }
    const rawHeader = (m[1] || "").trim();
    const lang = (rawHeader.split(/\s+/)[0] || "").toLowerCase();
    blocks.push({ type: "code", lang, code: m[2].replace(/\n$/, "") });
    cursor = fenceRe.lastIndex;
  }
  if (cursor < rawMd.length) {
    blocks.push({ type: "prose", text: rawMd.slice(cursor) });
  }

  return blocks
    .map((b) => {
      if (b.type === "code") {
        return `<pre><code>${escapeHtmlText(b.code)}</code></pre>`;
      }
      return renderMarkdownProseBlock(b.text);
    })
    .join("\n");
}

function renderMarkdownProseBlock(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let listTag = null;
  let listItems = [];
  let tableRows = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(formatMdInline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listTag && listItems.length > 0) {
      out.push(`<${listTag}>${listItems.join("")}</${listTag}>`);
      listTag = null;
      listItems = [];
    }
  };
  const flushTable = () => {
    if (tableRows.length === 0) return;
    const parsed = tableRows.map((r) =>
      r
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
    );
    const hasSep = parsed.length >= 2 && parsed[1].every((c) => /^:?-{2,}:?$/.test(c));
    const head = parsed[0];
    const body = hasSep ? parsed.slice(2) : parsed.slice(1);
    const thead = `<thead><tr>${head.map((h) => `<th>${formatMdInline(h)}</th>`).join("")}</tr></thead>`;
    const tbody =
      body.length > 0
        ? `<tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${formatMdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
    out.push(`<table>${thead}${tbody}</table>`);
    tableRows = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      flushTable();
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushPara();
      flushList();
      tableRows.push(trimmed);
      continue;
    }
    flushTable();

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      flushList();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${formatMdInline(hMatch[2])}</h${lvl}>`);
      continue;
    }

    const qMatch = trimmed.match(/^>\s?(.*)$/);
    if (qMatch) {
      flushPara();
      flushList();
      out.push(`<blockquote>${formatMdInline(qMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      if (listTag && listTag !== "ul") flushList();
      listTag = "ul";
      listItems.push(`<li>${formatMdInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      if (listTag && listTag !== "ol") flushList();
      listTag = "ol";
      listItems.push(`<li>${formatMdInline(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  flushTable();
  return out.join("\n");
}

export function formatMdInline(str) {
  const codes = [];
  const masked = String(str).replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length;
    codes.push(`<code>${escapeHtmlText(c)}</code>`);
    return `\u0000C${i}\u0000`;
  });

  let safe = escapeHtmlText(masked);
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  safe = safe.replace(/\[([^\]]+)\]\((#[a-zA-Z0-9_-]+)\)/g, '<a href="$2">$1</a>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  safe = safe.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || "");
  return safe;
}
