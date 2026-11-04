import { normalizePath } from "../storage/workspaceDb.js";
import { buildLoopGuardRuntime, instrumentLoops } from "../preview/loopGuard.js";

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
export function initLivePreviewModal({ getWorkspaceSnapshot, onBeforePreview }) {
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
  const iframe = document.getElementById("preview-iframe");

  let consoleVisible = true;
  let previewRunSeq = 0;
  /** @type {"auto" | "standalone" | "folder"} */
  let jsRunOverride = "auto";

  openBtn?.addEventListener("click", async () => {
    jsRunOverride = "auto";
    if (typeof onBeforePreview === "function") {
      await onBeforePreview();
    }
    await loadAcorn();
    openPreview();
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
    renderActiveTabPreview();
  });

  reloadBtn?.addEventListener("click", () => {
    renderActiveTabPreview();
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
    appendConsoleLine(data.level || "log", data.text || "");
  });

  function stopIframe() {
    if (iframe) {
      iframe.srcdoc = "";
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

  function openPreview() {
    if (!dialog) return;
    renderActiveTabPreview();
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function showUnavailableState({ headerTitle, badgeText, messageTitle, messageDesc }) {
    stopIframe();
    clearConsoleOutput();

    if (titleEl) titleEl.textContent = headerTitle;
    if (fileBadgeEl) {
      fileBadgeEl.textContent = badgeText || "";
      fileBadgeEl.hidden = !badgeText;
    }
    if (jsModeBtn) jsModeBtn.hidden = true;
    if (reloadBtn) reloadBtn.hidden = true;
    if (toggleConsoleBtn) toggleConsoleBtn.hidden = true;
    if (iframe) iframe.hidden = true;
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

  function renderActiveTabPreview() {
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

    const ext = getFileExtension(activeFile.path);
    const extLabel = ext ? `.${ext}` : "sin extensión";
    const folder = getParentFolder(activeFile.path);
    const sameFolderFiles = filterFolderScopeFiles(files, folder);
    const sameFolderMap = new Map(sameFolderFiles.map((f) => [normalizePath(f.path), f]));

    // 1. Pestaña HTML: ensambla recursos relativos de su misma carpeta/subcarpetas
    if (HTML_EXTENSIONS.has(ext)) {
      const compiledHtml = bundleHtmlWithFolderAssets(activeFile.path, activeFile.content, sameFolderMap, null, guardJs);
      showRunnableIframe({
        headerTitle: "Vista previa de HTML",
        badgeText: activeFile.path,
        compiledHtml,
        siblingHtml: null
      });
      return;
    }

    // 2. Pestaña JS: ejecuta el archivo .js (o junto al HTML de su misma carpeta si interactúa con el DOM)
    if (JS_EXTENSIONS.has(ext)) {
      const siblingHtml = findSiblingHtmlInSameFolder(sameFolderFiles, folder, activeFile);
      const usesDom = /\b(document\s*\.|window\s*\.)/.test(activeFile.content);

      if (jsRunOverride === "auto") {
        jsRunOverride = siblingHtml && siblingHtml.linksThisJs && usesDom ? "folder" : "standalone";
      }

      if (jsRunOverride === "folder" && siblingHtml) {
        const compiledHtml = bundleHtmlWithFolderAssets(
          siblingHtml.file.path,
          siblingHtml.file.content,
          sameFolderMap,
          activeFile,
          guardJs
        );
        showRunnableIframe({
          headerTitle: "Vista previa de JS",
          badgeText: `${activeFile.path} (${siblingHtml.file.shortName})`,
          compiledHtml,
          siblingHtml: siblingHtml.file
        });
        return;
      }

      const compiledJsHtml = buildStandaloneJsPreview(activeFile, guardJs);
      showRunnableIframe({
        headerTitle: "Vista previa de JS",
        badgeText: activeFile.path,
        compiledHtml: compiledJsHtml,
        siblingHtml: siblingHtml ? siblingHtml.file : null
      });
      return;
    }

    // 3. Pestaña CSS: se previsualiza si forma conjunto con un .html en la misma carpeta
    if (CSS_EXTENSIONS.has(ext)) {
      const siblingHtml = findSiblingHtmlInSameFolder(sameFolderFiles, folder, activeFile);
      if (siblingHtml) {
        const compiledHtml = bundleHtmlWithFolderAssets(
          siblingHtml.file.path,
          siblingHtml.file.content,
          sameFolderMap,
          null,
          guardJs
        );
        showRunnableIframe({
          headerTitle: "Vista previa de CSS",
          badgeText: `${activeFile.path} (${siblingHtml.file.shortName})`,
          compiledHtml,
          siblingHtml: null
        });
      } else {
        showUnavailableState({
          headerTitle: "Vista previa de CSS",
          badgeText: activeFile.path,
          messageTitle: `No hay un archivo .html en la misma carpeta para ${activeFile.shortName}`,
          messageDesc: "Colocá un archivo .html en esta misma carpeta para ver estos estilos aplicados en conjunto."
        });
      }
      return;
    }

    // 4. Pestaña Python: ejecuta Python 3 real en el navegador (Pyodide WebAssembly) con entrada inline sin popups
    if (PYTHON_EXTENSIONS.has(ext)) {
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

    // 6. Pestaña C, C++, SQL, etc.: no disponible en vista previa web
    showUnavailableState({
      headerTitle: "Vista previa",
      badgeText: activeFile.path,
      messageTitle: `La vista previa no está disponible para este archivo ${extLabel}`,
      messageDesc: "La vista previa en vivo ejecuta archivos .html, .js, .css (en conjunto con su carpeta), scripts .py de Python y documentos .md."
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

/**
 * Filtra únicamente los archivos que pertenecen a la misma carpeta base (y subcarpetas relativas de ese conjunto).
 */
function filterFolderScopeFiles(allFiles, baseFolder) {
  if (!baseFolder) {
    // Si el archivo está en la raíz del proyecto, solo toma archivos de la raíz (o rutas relativas directas)
    // evitando mezclar carpetas paralelas independientes salvo que el HTML las enlace explícitamente.
    return allFiles;
  }
  const prefix = `${baseFolder}/`;
  return allFiles.filter((f) => {
    const clean = normalizePath(f.path);
    return clean.startsWith(prefix);
  });
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

export function bundleHtmlWithFolderAssets(entryPath, rawHtml, fileMap, ensureJsFile = null, transformJs = (code) => code) {
  const dir = getParentFolder(entryPath);

  const resolveAsset = (rawHref) => {
    if (!rawHref || /^(https?:|data:|blob:|\/\/)/i.test(rawHref)) {
      return null;
    }
    const cleanRef = rawHref.split("?")[0].split("#")[0];
    if (cleanRef.startsWith("../")) {
      return null;
    }
    const resolved = resolveRelativePath(dir, cleanRef);
    return fileMap.get(resolved) || null;
  };

  let inlinedActiveJs = false;
  const deferredScripts = [];

  // Incrustar hojas CSS locales de la misma carpeta
  let html = rawHtml.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return tag;
    const asset = resolveAsset(hrefMatch[1]);
    if (!asset) return tag;
    const safeCss = asset.content.replace(/<\/style>/gi, "<\\/style>");
    return `<style data-source="${escapeAttr(asset.path)}">\n${safeCss}\n</style>`;
  });

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
