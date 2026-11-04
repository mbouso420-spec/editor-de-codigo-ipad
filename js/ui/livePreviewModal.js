import { normalizePath } from "../storage/workspaceDb.js";

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
const CSS_EXTENSIONS = new Set(["css"]);
const PYTHON_EXTENSIONS = new Set(["py", "pyw"]);

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
export function initLivePreviewModal({ getWorkspaceSnapshot }) {
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
  /** @type {"auto" | "standalone" | "folder"} */
  let jsRunOverride = "auto";

  openBtn?.addEventListener("click", () => {
    jsRunOverride = "auto";
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

  function showRunnableIframe({ headerTitle, badgeText, compiledHtml, siblingHtml, consoleTitle = "Consola JS" }) {
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
      toggleConsoleBtn.hidden = false;
      toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
    }
    if (iframe) {
      iframe.hidden = false;
      iframe.srcdoc = compiledHtml;
    }
    if (consolePanel) {
      consolePanel.hidden = !consoleVisible;
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
      const compiledHtml = bundleHtmlWithFolderAssets(activeFile.path, activeFile.content, sameFolderMap);
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
          activeFile
        );
        showRunnableIframe({
          headerTitle: "Vista previa de JS",
          badgeText: `${activeFile.path} (${siblingHtml.file.shortName})`,
          compiledHtml,
          siblingHtml: siblingHtml.file
        });
        return;
      }

      const compiledJsHtml = buildStandaloneJsPreview(activeFile);
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
          sameFolderMap
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

    // 4. Pestaña Python: ejecuta Python 3 real en el navegador (Pyodide WebAssembly) junto a módulos .py de su carpeta
    if (PYTHON_EXTENSIONS.has(ext)) {
      const compiledPyHtml = buildStandalonePythonPreview(activeFile, sameFolderFiles, folder);
      showRunnableIframe({
        headerTitle: "Vista previa de Python",
        badgeText: activeFile.path,
        compiledHtml: compiledPyHtml,
        siblingHtml: null,
        consoleTitle: "Consola Python"
      });
      return;
    }

    // 5. Pestaña C, C++, SQL, Markdown, etc.: no disponible en vista previa web
    showUnavailableState({
      headerTitle: "Vista previa",
      badgeText: activeFile.path,
      messageTitle: `La vista previa no está disponible para este archivo ${extLabel}`,
      messageDesc: "La vista previa en vivo solo ejecuta archivos .html, .js, .css (en conjunto con su carpeta) y scripts .py de Python."
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

function findSiblingHtmlInSameFolder(scopeFiles, folder, targetFile) {
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

function bundleHtmlWithFolderAssets(entryPath, rawHtml, fileMap, ensureJsFile = null) {
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
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (fullTag, attrs) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) return fullTag;
    const asset = resolveAsset(srcMatch[1]);
    if (!asset) return fullTag;

    if (ensureJsFile && normalizePath(asset.path) === normalizePath(ensureJsFile.path)) {
      inlinedActiveJs = true;
    }

    const isModule = /\btype=["']module["']/i.test(attrs);
    const hasDefer = /\bdefer\b/i.test(attrs);
    const safeJs = asset.content.replace(/<\/script>/gi, "<\\/script>");

    if (!isModule && hasDefer) {
      deferredScripts.push(`<script data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`);
      return "";
    }

    return `<script${isModule ? ' type="module"' : ""} data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`;
  });

  if (ensureJsFile && !inlinedActiveJs) {
    const safeExtraJs = ensureJsFile.content.replace(/<\/script>/gi, "<\\/script>");
    deferredScripts.push(`<script data-source="${escapeAttr(ensureJsFile.path)}">\n${safeExtraJs}\n</script>`);
  }

  if (deferredScripts.length > 0) {
    const deferredBlock = deferredScripts.join("\n");
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${deferredBlock}\n</body>`);
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

function buildStandaloneJsPreview(jsFile) {
  const bridge = buildConsoleBridgeScript(true);
  const safeJs = jsFile.content.replace(/<\/script>/gi, "<\\/script>");
  const safeName = escapeHtmlText(jsFile.path);

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
  <script>
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
  </script>
</body>
</html>`;
}

function buildConsoleBridgeScript(mirrorOnScreen) {
  return `<script>
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
    send("error", [e.message + (e.lineno ? " (línea " + e.lineno + ")" : "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["Promesa rechazada: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
  });
})();
</script>`;
}

function resolveRelativePath(baseDir, relPath) {
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

function buildStandalonePythonPreview(pyFile, sameFolderFiles, baseFolder) {
  const prefix = baseFolder ? `${baseFolder}/` : "";
  const modules = [];

  for (const candidate of sameFolderFiles) {
    const ext = getFileExtension(candidate.path);
    if (!PYTHON_EXTENSIONS.has(ext)) continue;
    const cleanPath = normalizePath(candidate.path);
    if (cleanPath === normalizePath(pyFile.path)) continue;
    const relPath = prefix && cleanPath.startsWith(prefix) ? cleanPath.slice(prefix.length) : cleanPath;
    if (relPath && !relPath.startsWith("..")) {
      modules.push({ path: relPath, content: candidate.content });
    }
  }

  const pythonBootstrap = [
    "import builtins, sys, traceback, js",
    "if '.' not in sys.path:",
    "    sys.path.insert(0, '.')",
    "def __studio_input(prompt=''):",
    "    texto = str(prompt) if prompt is not None else ''",
    "    resp = js.prompt(texto or 'Entrada de datos (Python):')",
    "    if resp is None:",
    "        raise EOFError('Entrada cancelada por el usuario.')",
    "    print(f'{texto}{resp}')",
    "    return str(resp)",
    "builtins.input = __studio_input",
    "__had_err = False",
    "__ns = {'__name__': '__main__', '__file__': __studio_entry_name}",
    "try:",
    "    exec(compile(__studio_entry_code, __studio_entry_name, 'exec'), __ns)",
    "except SystemExit:",
    "    pass",
    "except Exception as __exc:",
    "    __had_err = True",
    "    __tb = traceback.extract_tb(__exc.__traceback__)",
    "    __clean = [f for f in __tb if f.filename == __studio_entry_name or not f.filename.startswith('<')]",
    "    __lines = ['Traceback (most recent call last):']",
    "    for __f in __clean:",
    "        __lines.append(f'  Archivo \"{__f.filename}\", línea {__f.lineno}, en {__f.name}')",
    "    __lines.extend([l.rstrip('\\n') for l in traceback.format_exception_only(type(__exc), __exc)])",
    "    print('\\n'.join(__lines), file=sys.stderr)",
    "__had_err"
  ].join("\n");

  const payloadJson = JSON.stringify({
    entryName: pyFile.shortName,
    entryPath: pyFile.path,
    code: pyFile.content,
    modules,
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
      background: oklch(16.5% 0.012 255);
    }
    .py-line-error { color: var(--err); }
    .py-empty { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
  <section class="py-runner-card">
    <div class="py-runner-head">
      <span class="py-runner-file">${safePathLabel}</span>
      <span id="__py_status" class="py-runner-status">Iniciando motor Python 3 (WebAssembly)…</span>
    </div>
    <div id="__py_screen_log" class="py-runner-output"></div>
  </section>

  <script id="__py_payload" type="application/json">${payloadJson}</script>
  <script>
    (function () {
      var statusEl = document.getElementById("__py_status");
      var screenBox = document.getElementById("__py_screen_log");
      var payload = JSON.parse(document.getElementById("__py_payload").textContent);

      function emit(level, text) {
        var msg = String(text ?? "");
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

      function ensureParentDirs(FS, filePath) {
        var parts = filePath.split("/");
        if (parts.length <= 1) return;
        var current = "";
        for (var i = 0; i < parts.length - 1; i += 1) {
          current = current ? current + "/" + parts[i] : parts[i];
          try { FS.mkdir(current); } catch (_) {}
        }
      }

      async function bootAndRun() {
        try {
          var pyodide = await window.loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/"
          });

          pyodide.setStdout({
            batched: function (line) { emit("log", line); }
          });
          pyodide.setStderr({
            batched: function (line) { emit("error", line); }
          });

          for (var i = 0; i < payload.modules.length; i += 1) {
            var mod = payload.modules[i];
            ensureParentDirs(pyodide.FS, mod.path);
            pyodide.FS.writeFile(mod.path, mod.content, { encoding: "utf8" });
          }

          setStatus("Ejecutando script…", "var(--accent)");

          pyodide.globals.set("__studio_entry_name", payload.entryName);
          pyodide.globals.set("__studio_entry_code", payload.code);

          var hadErr = await pyodide.runPythonAsync(payload.bootstrap);

          if (hadErr) {
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
        } catch (err) {
          setStatus("Error al iniciar Python", "var(--err)");
          emit("error", err && err.message ? err.message : String(err));
        }
      }

      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js";
      script.onload = bootAndRun;
      script.onerror = function () {
        setStatus("Sin conexión al motor Python", "var(--err)");
        emit("error", "No se pudo descargar el motor Python 3 (Pyodide). Conectate a internet al menos una vez para almacenarlo en caché.");
      };
      document.head.appendChild(script);
    })();
  </script>
</body>
</html>`;
}
