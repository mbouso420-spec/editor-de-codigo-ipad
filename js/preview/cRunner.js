/**
 * Compilador y ejecutor interactivo de C y C++ para la Vista Previa.
 * Conecta con la API pública de Wandbox (GCC C17 y GCC C++20) con soporte multi-archivo
 * para proyectos universitarios y profesionales con headers (.h/.hpp) y módulos (.c/.cpp).
 */

export const C_SOURCE_EXTENSIONS = new Set(["c"]);
export const C_HEADER_EXTENSIONS = new Set(["h"]);
export const CPP_SOURCE_EXTENSIONS = new Set(["cpp", "cxx", "cc"]);
export const CPP_HEADER_EXTENSIONS = new Set(["hpp", "hxx", "hh"]);

export const ALL_HEADER_EXTENSIONS = new Set(["h", "hpp", "hxx", "hh"]);
export const ALL_C_EXTENSIONS = new Set(["c", "h"]);
export const ALL_CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp", "hxx", "hh"]);

/**
 * Detecta si un código fuente en C o C++ define la función de punto de entrada main().
 * Descarta comentarios de bloque y de línea para prevenir falsos positivos.
 * @param {string} code
 * @returns {boolean}
 */
export function hasMainFunction(code) {
  if (!code || typeof code !== "string") return false;
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ");
  return /\b(?:int|void|auto|signed)?\s*main\s*\([^)]*\)\s*(?:->\s*[a-zA-Z0-9_:<>]+\s*)?\{/m.test(stripped);
}

/**
 * Genera el payload de compilación para la API de Wandbox con soporte multi-archivo.
 * Reglas de aislamiento estricto:
 * 1. Si el archivo activo es C (.c): JAMÁS incluye archivos C++ (.cpp, .hpp) para no romper el compilador gcc de C.
 * 2. Si un archivo compañero define su propia función main(), se EXCLUYE del enlace para evitar "multiple definition of `main`".
 * 3. Las cabeceras (.h/.hpp) se cargan en `codes` para #include pero NUNCA se pasan como unidades de compilación al linker.
 * @param {{
 *   activeFile: { path: string, shortName?: string, content: string },
 *   companionFiles?: Array<{ path: string, shortName?: string, content: string }>,
 *   stdin?: string
 * }} options
 * @returns {{
 *   compiler: string,
 *   code: string,
 *   codes: Array<{ file: string, code: string }>,
 *   options: string,
 *   stdin: string,
 *   "compiler-option-raw": string
 * }}
 */
export function buildWandboxPayload({ activeFile, companionFiles = [], stdin = "" }) {
  const ext = getFileExtension(activeFile.path);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));

  const compiler = isC ? "gcc-head-c" : "gcc-head";
  const options = isC ? "c17,warning" : "c++20,warning";

  const cleanActivePath = normalizePath(activeFile.path);
  const activeBaseDir = getParentFolder(cleanActivePath);
  const prefix = activeBaseDir ? `${activeBaseDir}/` : "";

  const codes = [];
  const extraSourceFiles = [];

  for (const comp of companionFiles) {
    if (!comp || !comp.path) continue;
    const compClean = normalizePath(comp.path);
    if (compClean === cleanActivePath) continue;

    const compExt = getFileExtension(comp.path);

    // 1. REGLA ESTRICTA DE LENGUAJE:
    // Si estamos compilando un archivo C (gcc-head-c):
    // JAMÁS incluir archivos de código fuente C++ (.cpp, .cxx, .cc) ni cabeceras C++ (.hpp).
    // El compilador GCC de C no puede procesar C++ ni enlazar con libstdc++.
    if (isC) {
      if (!C_SOURCE_EXTENSIONS.has(compExt) && !C_HEADER_EXTENSIONS.has(compExt)) {
        continue;
      }
    } else {
      // Si estamos compilando C++ (gcc-head / g++):
      if (!ALL_CPP_EXTENSIONS.has(compExt) && !ALL_C_EXTENSIONS.has(compExt)) {
        continue;
      }
    }

    // Obtener ruta relativa respecto al archivo principal
    const relName = prefix && compClean.startsWith(prefix)
      ? compClean.slice(prefix.length)
      : comp.shortName || compClean.split("/").pop();

    const isHeader = ALL_HEADER_EXTENSIONS.has(compExt);
    const compContent = String(comp.content || "");

    // 2. CABECERAS (.h, .hpp, etc.):
    // Se agregan al disco virtual de Wandbox (`codes`) para que puedan ser importadas con `#include "..."`.
    // NUNCA se agregan como fuentes a compilar directamente en `extraSourceFiles` / `compiler-option-raw`.
    if (isHeader) {
      codes.push({
        file: relName,
        code: compContent
      });
      continue;
    }

    // 3. ARCHIVOS DE CÓDIGO FUENTE (.c, .cpp, .cxx, .cc):
    // Verificar si el archivo compañero define su propia función `main()`.
    const compHasMain = hasMainFunction(compContent);

    // Si el archivo compañero define `main()`, es un programa INDEPENDIENTE
    // (ej: otro ejercicio o programa separado en la misma carpeta).
    // Si lo vinculáramos a la compilación de `activeFile`, el linker fallará con:
    // `multiple definition of 'main'`.
    // Por ende, NUNCA se debe compilar ni enlazar como módulo adicional.
    if (compHasMain) {
      continue;
    }

    // Si NO define `main()`, es un módulo auxiliar (ej: utils.c, calculos.cpp).
    // Se incluye en `codes` y se pasa al compilador para enlace.
    codes.push({
      file: relName,
      code: compContent
    });
    extraSourceFiles.push(relName);
  }

  const rawOptions = ["-O2", "-Wall"];
  if (extraSourceFiles.length > 0) {
    rawOptions.unshift(...extraSourceFiles);
  }

  return {
    compiler,
    code: activeFile.content || "",
    codes,
    options,
    stdin: String(stdin || ""),
    "compiler-option-raw": rawOptions.join("\n")
  };
}

/**
 * Envía el código a la API de Wandbox para su compilación y ejecución.
 * @param {object} payload
 * @param {typeof fetch} [fetchFn=fetch]
 * @returns {Promise<{
 *   status: number,
 *   success: boolean,
 *   stdout: string,
 *   stderr: string,
 *   compilerOut: string,
 *   compilerErr: string
 * }>}
 */
export async function compileAndRunWandbox(payload, fetchFn = (typeof window !== "undefined" ? window.fetch : fetch)) {
  const res = await fetchFn("https://wandbox.org/api/compile.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Error en servidor de compilación (HTTP ${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  const statusCode = Number(data.status ?? (data.compiler_error || data.compiler_output ? 1 : 0));

  return {
    status: statusCode,
    success: statusCode === 0 && !data.compiler_error,
    stdout: data.program_output || "",
    stderr: data.program_error || "",
    compilerOut: data.compiler_output || "",
    compilerErr: data.compiler_error || ""
  };
}

/**
 * Parsea errores y advertencias de compilación devueltos por GCC / Clang en stderr o compiler_output.
 * @param {string} output
 * @returns {Array<{ line: number, column: number, severity: string, message: string, raw: string }>}
 */
export function parseGccErrors(output) {
  if (!output || typeof output !== "string") return [];
  const errors = [];
  const regex = /(?:^|\n)(?:[^\s:]+):(\d+)(?::(\d+))?:\s*(fatal error|error|warning)?:\s*([^\r\n]+)/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const line = parseInt(match[1], 10);
    const column = match[2] ? parseInt(match[2], 10) : 1;
    const severity = (match[3] || "error").toLowerCase();
    const rawMessage = match[4].trim();
    if (!isNaN(line)) {
      errors.push({
        line,
        column,
        severity,
        message: rawMessage,
        raw: match[0].trim()
      });
    }
  }
  return errors;
}

/**
 * Monta la interfaz interactiva nativa del Runner C/C++ directamente en el DOM del modal
 * evitando el uso de iframes sandboxeados para una conectividad sin trabas con Wandbox y CodeMirror.
 * @param {HTMLElement} containerEl
 * @param {{
 *   activeFile: { path: string, shortName?: string, content: string },
 *   companionFiles?: Array<{ path: string, shortName?: string, content: string }>,
 *   onCompilerResult?: (res: { success: boolean, errors: Array<{ line: number, column: number, severity: string, message: string }> }) => void,
 *   onGoToLine?: (lineNum: number) => void,
 *   fetchFn?: typeof fetch
 * }} options
 * @returns {{ destroy: () => void, run: () => Promise<void> }}
 */
export function mountCRunnerView(containerEl, {
  activeFile,
  companionFiles = [],
  onCompilerResult = () => {},
  onGoToLine = () => {},
  fetchFn = (typeof window !== "undefined" ? window.fetch : fetch)
}) {
  if (!containerEl) return { destroy: () => {}, run: async () => {} };
  containerEl.innerHTML = "";

  const ext = getFileExtension(activeFile.path);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isHeader = ALL_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));
  const langLabel = isHeader ? (isC ? "C Header (.h)" : "C++ Header (.hpp)") : (isC ? "C (GCC 14 / C17)" : "C++ (GCC 14 / C++20)");
  const initialPayload = buildWandboxPayload({ activeFile, companionFiles, stdin: "" });
  const companionCount = initialPayload.codes.length;
  const companionLabel = companionCount > 0
    ? `+ ${companionCount} archivo(s) vinculado(s): ${initialPayload.codes.map((c) => c.file).join(", ")}`
    : "Archivo único";

  const shell = document.createElement("div");
  shell.className = "c-runner-shell";

  // 1. Cabecera con metadatos y botón de compilación
  const header = document.createElement("div");
  header.className = "c-runner-header";

  const meta = document.createElement("div");
  meta.className = "c-runner-meta";
  const title = document.createElement("span");
  title.className = "c-runner-title";
  title.textContent = activeFile.shortName || activeFile.path;
  const badge = document.createElement("span");
  badge.className = "c-runner-badge";
  badge.textContent = langLabel;
  const companionBadge = document.createElement("span");
  companionBadge.className = "c-runner-companion-badge";
  companionBadge.textContent = companionLabel;
  meta.append(title, badge, companionBadge);

  const btnCompile = document.createElement("button");
  btnCompile.type = "button";
  btnCompile.className = "btn btn-primary btn-sm btn-c-compile";
  btnCompile.innerHTML = '<span data-icon="play"></span><span>Compilar y Ejecutar</span> <span class="c-key-hint" style="opacity:0.75;font-size:11px;">(Ctrl+Enter)</span>';

  header.append(meta, btnCompile);

  // 2. Tarjeta stdin
  const hasInteractiveInput = /\b(scanf|cin|getline|getchar|fgets|gets)\b/.test(activeFile.content || "");
  const stdinCard = document.createElement("div");
  stdinCard.className = "c-stdin-card";

  const stdinHeader = document.createElement("div");
  stdinHeader.className = "c-stdin-header";
  const stdinLabel = document.createElement("label");
  stdinLabel.className = "c-section-label";
  stdinLabel.textContent = "Entrada estándar (stdin para cin / scanf):";
  const stdinHelp = document.createElement("span");
  stdinHelp.className = "c-stdin-help";
  stdinHelp.textContent = "Los datos se enviarán a tu programa al ejecutar";
  stdinHeader.append(stdinLabel, stdinHelp);

  const stdinTextarea = document.createElement("textarea");
  stdinTextarea.className = "c-stdin-textarea code-font";
  stdinTextarea.placeholder = hasInteractiveInput
    ? "Escribí aquí las opciones y números de tu programa (ej: 1\\n10 20\\n5)..."
    : "Escribí aquí los datos de entrada que tu programa solicitará en tiempo de ejecución...";

  const stdinFooter = document.createElement("div");
  stdinFooter.className = "c-stdin-footer";

  const btnClearStdin = document.createElement("button");
  btnClearStdin.type = "button";
  btnClearStdin.className = "btn btn-subtle btn-sm btn-c-clear-stdin";
  btnClearStdin.textContent = "Limpiar";

  const btnSendStdin = document.createElement("button");
  btnSendStdin.type = "button";
  btnSendStdin.className = "btn btn-primary btn-sm btn-c-send-stdin";
  btnSendStdin.innerHTML = '<span data-icon="play"></span><span>Enviar entrada y Ejecutar</span> <span class="c-key-hint" style="opacity:0.75;font-size:11px;">(Ctrl+Enter)</span>';

  stdinFooter.append(btnClearStdin, btnSendStdin);
  stdinCard.append(stdinHeader, stdinTextarea, stdinFooter);

  // 3. Tarjeta Terminal
  const termCard = document.createElement("div");
  termCard.className = "c-terminal-card";
  const termHeader = document.createElement("div");
  termHeader.className = "c-terminal-header";
  const termTitle = document.createElement("span");
  termTitle.className = "c-section-label";
  termTitle.textContent = "Terminal de Ejecución";
  const termStatus = document.createElement("span");
  termStatus.className = "c-term-status is-idle";
  termStatus.textContent = "Listo para compilar";
  termHeader.append(termTitle, termStatus);

  const termBody = document.createElement("div");
  termBody.className = "c-terminal-body code-font";
  termBody.textContent = "Iniciando compilador GCC en Wandbox...";

  termCard.append(termHeader, termBody);
  shell.append(header, stdinCard, termCard);
  containerEl.appendChild(shell);

  let isCompiling = false;

  async function executeCompile() {
    if (isCompiling) return;
    isCompiling = true;
    btnCompile.disabled = true;
    btnSendStdin.disabled = true;
    termStatus.className = "c-term-status is-running";
    termStatus.textContent = "Compilando en Wandbox...";
    termBody.innerHTML = '<span class="c-term-hint">Conectando con GCC en Wandbox y compilando proyecto...</span>';

    const payload = buildWandboxPayload({
      activeFile,
      companionFiles,
      stdin: stdinTextarea.value || ""
    });

    const t0 = performance.now();
    try {
      const res = await compileAndRunWandbox(payload, fetchFn);
      const ms = Math.round(performance.now() - t0);
      termBody.innerHTML = "";

      const compilerErrors = parseGccErrors(`${res.compilerErr}\n${res.compilerOut}\n${res.stderr}`);

      if (res.success && compilerErrors.length === 0) {
        termStatus.className = "c-term-status is-ok";
        termStatus.textContent = `Código de salida: 0 (Éxito) — ${ms} ms`;
        onCompilerResult({ success: true, errors: [] });
      } else {
        termStatus.className = "c-term-status is-err";
        termStatus.textContent = `Falló compilación / ejecución (código ${res.status}) — ${ms} ms`;
        onCompilerResult({ success: false, errors: compilerErrors });
      }

      // Si hubo advertencias o errores del compilador
      if (res.compilerErr || res.compilerOut) {
        const compBlock = document.createElement("div");
        compBlock.className = res.compilerErr ? "c-term-comp-err" : "c-term-comp-warn";
        compBlock.textContent = res.compilerErr || res.compilerOut;
        if (compilerErrors.length > 0) {
          compBlock.title = `Hacé clic para saltar a la línea ${compilerErrors[0].line} en el editor`;
          compBlock.addEventListener("click", () => {
            onGoToLine(compilerErrors[0].line);
          });
        }
        termBody.appendChild(compBlock);
      }

      // Salida estándar stdout
      if (res.stdout) {
        const outDiv = document.createElement("div");
        outDiv.className = "c-term-stdout";
        outDiv.textContent = res.stdout;
        termBody.appendChild(outDiv);
      }

      // Salida de error stderr
      if (res.stderr) {
        const errDiv = document.createElement("div");
        errDiv.className = "c-term-stderr";
        errDiv.textContent = res.stderr;
        termBody.appendChild(errDiv);
      }

      if (!res.stdout && !res.stderr && !res.compilerErr && !res.compilerOut) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "c-term-hint";
        emptyDiv.textContent = "(El programa terminó sin producir salida en stdout ni stderr).";
        termBody.appendChild(emptyDiv);
      }

      const isStdinEmpty = !(stdinTextarea.value || "").trim();
      if (hasInteractiveInput && isStdinEmpty) {
        const hintDiv = document.createElement("div");
        hintDiv.className = "c-term-hint c-term-stdin-tip";
        hintDiv.style.cssText = "margin-top: 10px; padding: 8px 12px; background: rgba(56, 189, 248, 0.08); border-left: 3px solid #38bdf8; color: #bae6fd; font-size: 12px; border-radius: 4px; line-height: 1.4;";
        hintDiv.textContent = "💡 Consejo: Tu programa solicita datos con scanf/cin y la caja de Entrada estándar está vacía. Si ves que el menú se repite en bucle o termina de golpe, ingresá las opciones y números en la caja de 'Entrada estándar' arriba y volvé a presionar 'Compilar y Ejecutar'.";
        termBody.appendChild(hintDiv);
      }
    } catch (err) {
      termStatus.className = "c-term-status is-err";
      termStatus.textContent = "Error de red / API";
      termBody.innerHTML = `<span class="c-term-stderr">Error al conectar con la API de compilación: ${escapeHtml(err.message)}</span>`;
      onCompilerResult({ success: false, errors: [] });
    } finally {
      isCompiling = false;
      btnCompile.disabled = false;
      btnSendStdin.disabled = false;
    }
  }

  btnCompile.addEventListener("click", executeCompile);
  btnSendStdin.addEventListener("click", executeCompile);

  btnClearStdin.addEventListener("click", () => {
    stdinTextarea.value = "";
    stdinTextarea.focus();
  });

  stdinTextarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeCompile();
    }
  });

  function handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeCompile();
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", handleKeydown);
  }

  // Ejecución inicial automática al montar
  executeCompile();

  return {
    destroy() {
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", handleKeydown);
      }
    },
    run: executeCompile
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

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Construye el documento HTML completo del Runner de C y C++ para el iframe.
 * @param {{ path: string, shortName: string, content: string }} activeFile
 * @param {Array<{ path: string, shortName: string, content: string }>} [companionFiles=[]]
 * @returns {string}
 */
export function buildCRunnerPreview(activeFile, companionFiles = []) {
  const ext = getFileExtension(activeFile.path);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isHeader = ALL_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));
  const langLabel = isHeader ? (isC ? "C Header (.h)" : "C++ Header (.hpp)") : (isC ? "C (GCC 14 / C17)" : "C++ (GCC 14 / C++20)");
  const safeTitle = escapeHtml(activeFile.shortName || activeFile.path);

  const initialPayload = buildWandboxPayload({ activeFile, companionFiles, stdin: "" });
  const safePayloadJson = JSON.stringify(initialPayload).replace(/</g, "\\u003c");

  const companionCount = initialPayload.codes.length;
  const companionLabel = companionCount > 0
    ? `+ ${companionCount} archivo(s) vinculado(s): ${initialPayload.codes.map((c) => c.file).join(", ")}`
    : "Archivo único";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} — ${langLabel}</title>
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --card-alt: oklch(17.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --border-focus: oklch(72% 0.145 252);
      --ink: oklch(94.5% 0.007 255);
      --ink-dim: oklch(81% 0.012 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --accent-solid: oklch(52% 0.165 252);
      --accent-hover: oklch(57% 0.165 252);
      --accent-ink: oklch(98% 0.005 252);
      --ok: oklch(66% 0.14 152);
      --ok-soft: oklch(66% 0.14 152 / 0.18);
      --warn: oklch(74% 0.14 75);
      --warn-soft: oklch(74% 0.14 75 / 0.18);
      --err: oklch(62% 0.18 25);
      --err-soft: oklch(62% 0.18 25 / 0.18);
      --font-body: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-body);
      font-size: 13px;
      line-height: 1.5;
    }
    .c-shell {
      max-width: 1000px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .c-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .c-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .c-title {
      font-weight: 600;
      font-size: 14px;
    }
    .c-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--card-alt);
      border: 1px solid var(--border);
      color: var(--accent);
    }
    .c-companion-badge {
      font-size: 11px;
      color: var(--muted);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 6px;
      font-family: var(--font-body);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--card-alt);
      color: var(--ink);
      transition: background 120ms ease;
    }
    .btn:hover { background: oklch(24% 0.015 255); }
    .btn-primary {
      background: var(--accent-solid);
      color: var(--accent-ink);
      border-color: transparent;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .c-stdin-box {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .c-stdin-label {
      font-size: 12px;
      color: var(--muted);
      font-weight: 500;
    }
    .c-stdin-input {
      width: 100%;
      height: 54px;
      padding: 6px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    .c-stdin-input:focus {
      outline: 2px solid var(--border-focus);
      outline-offset: -1px;
    }
    .terminal-card {
      background: oklch(11% 0.008 255);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .terminal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: oklch(14% 0.01 255);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .terminal-title {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
    }
    .terminal-status {
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .terminal-status.is-ok { color: var(--ok); }
    .terminal-status.is-err { color: var(--err); }
    .terminal-status.is-running { color: var(--warn); }
    .terminal-body {
      padding: 14px;
      min-height: 220px;
      max-height: 480px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .out-stdout { color: var(--ink); }
    .out-stderr { color: var(--err); }
    .out-comp-warn { color: var(--warn); }
    .out-comp-err { color: var(--err); font-weight: 600; }
    .out-hint { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
  <div class="c-shell">
    <div class="c-header">
      <div class="c-meta">
        <span class="c-title">${langLabel}</span>
        <span class="c-badge">${safeTitle}</span>
        <span class="c-companion-badge">${escapeHtml(companionLabel)}</span>
      </div>
      <div>
        <button type="button" id="btn-compile" class="btn btn-primary" title="Compilar y ejecutar en Wandbox (Ctrl+Enter)">
          <span>Compilar y Ejecutar</span>
        </button>
      </div>
    </div>

    <div class="c-stdin-box">
      <label for="stdin-val" class="c-stdin-label">Datos de entrada estándar (stdin para cin / scanf):</label>
      <textarea id="stdin-val" class="c-stdin-input" placeholder="Valores de entrada separados por espacio o saltos de línea (opcional)..." spellcheck="false"></textarea>
    </div>

    <div class="terminal-card">
      <div class="terminal-head">
        <span class="terminal-title">Terminal de salida (stdout / stderr)</span>
        <span id="term-status" class="terminal-status">Listo para compilar</span>
      </div>
      <div id="terminal-body" class="terminal-body">
        <span class="out-hint">Presioná "Compilar y Ejecutar" o Ctrl + Enter para compilar con GCC...</span>
      </div>
    </div>
  </div>

  <script>
    (function () {
      var basePayload = ${safePayloadJson};
      var btnCompile = document.getElementById("btn-compile");
      var stdinInput = document.getElementById("stdin-val");
      var termStatus = document.getElementById("term-status");
      var termBody = document.getElementById("terminal-body");

      function sendLog(level, text) {
        try {
          parent.postMessage({
            source: "studio-ide-preview",
            level: level,
            text: text
          }, "*");
        } catch (_) {}
      }

      async function runCompile() {
        btnCompile.disabled = true;
        termStatus.className = "terminal-status is-running";
        termStatus.textContent = "Compilando con GCC en Wandbox...";
        termBody.innerHTML = '<span class="out-hint">[Compilando con GCC...]</span>\\n';
        sendLog("log", "[C/C++] Iniciando compilación en Wandbox...");

        var payload = Object.assign({}, basePayload, {
          stdin: stdinInput.value || ""
        });

        var t0 = performance.now();
        try {
          var res = await fetch("https://wandbox.org/api/compile.json", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            throw new Error("HTTP " + res.status + " " + res.statusText);
          }

          var data = await res.json();
          var ms = Math.round(performance.now() - t0);
          renderOutput(data, ms);
        } catch (err) {
          termStatus.className = "terminal-status is-err";
          termStatus.textContent = "Error de red / API";
          termBody.innerHTML = '<span class="out-stderr">Error al conectar con la API de compilación: ' + err.message + '</span>';
          sendLog("error", "[C/C++] Error de conexión: " + err.message);
        } finally {
          btnCompile.disabled = false;
        }
      }

      function renderOutput(data, ms) {
        termBody.innerHTML = "";
        var statusCode = Number(data.status ?? (data.compiler_error || data.compiler_output ? 1 : 0));
        var isSuccess = statusCode === 0 && !data.compiler_error;

        termStatus.className = isSuccess ? "terminal-status is-ok" : "terminal-status is-err";
        termStatus.textContent = (isSuccess ? "Código de salida: 0 (Éxito)" : "Falló (código " + statusCode + ")") + " — " + ms + " ms";

        if (data.compiler_output || data.compiler_error) {
          var compDiv = document.createElement("div");
          compDiv.className = data.compiler_error ? "out-comp-err" : "out-comp-warn";
          compDiv.textContent = data.compiler_error || data.compiler_output;
          termBody.appendChild(compDiv);
        }

        if (data.program_output) {
          var outDiv = document.createElement("div");
          outDiv.className = "out-stdout";
          outDiv.textContent = data.program_output;
          termBody.appendChild(outDiv);
          sendLog("log", data.program_output.trim());
        }

        if (data.program_error) {
          var errDiv = document.createElement("div");
          errDiv.className = "out-stderr";
          errDiv.textContent = data.program_error;
          termBody.appendChild(errDiv);
          sendLog("error", data.program_error.trim());
        }

        if (!data.program_output && !data.program_error && !data.compiler_output && !data.compiler_error) {
          var emptyDiv = document.createElement("div");
          emptyDiv.className = "out-hint";
          emptyDiv.textContent = "(El programa terminó sin producir salida en stdout ni stderr).";
          termBody.appendChild(emptyDiv);
        }
      }

      btnCompile.addEventListener("click", runCompile);
      window.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          runCompile();
        }
      });

      // Compilar automáticamente al abrir la vista previa
      runCompile();
    })();
  </script>
</body>
</html>`;
}
