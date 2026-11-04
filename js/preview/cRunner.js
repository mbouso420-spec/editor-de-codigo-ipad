/**
 * Compilador y ejecutor interactivo de C y C++ para la Vista Previa.
 * Conecta con la API pública de Wandbox (GCC C17 y GCC C++20) con soporte multi-archivo
 * para proyectos universitarios y profesionales con headers (.h/.hpp) y módulos (.c/.cpp).
 */

const C_EXTENSIONS = new Set(["c"]);
const CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "h", "hpp"]);

/**
 * Genera el payload de compilación para la API de Wandbox con soporte multi-archivo.
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
  const isC = C_EXTENSIONS.has(ext);

  const compiler = isC ? "gcc-head-c" : "gcc-head";
  const options = isC ? "c17,warning" : "c++20,warning";

  const cleanActivePath = normalizePath(activeFile.path);
  const activeBaseDir = getParentFolder(cleanActivePath);
  const prefix = activeBaseDir ? `${activeBaseDir}/` : "";

  const codes = [];
  const extraSourceFiles = [];

  for (const comp of companionFiles) {
    const compClean = normalizePath(comp.path);
    if (compClean === cleanActivePath) continue;

    const compExt = getFileExtension(comp.path);
    if (!C_EXTENSIONS.has(compExt) && !CPP_EXTENSIONS.has(compExt)) continue;

    // Obtener ruta relativa respecto al archivo principal
    const relName = prefix && compClean.startsWith(prefix) ? compClean.slice(prefix.length) : comp.shortName || compClean.split("/").pop();

    codes.push({
      file: relName,
      code: comp.content || ""
    });

    // Si es un archivo de código fuente (.c o .cpp) adicional, pasarlo al compilador para enlace
    if (compExt === "c" || compExt === "cpp" || compExt === "cxx" || compExt === "cc") {
      extraSourceFiles.push(relName);
    }
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
  const isC = C_EXTENSIONS.has(ext);
  const langLabel = isC ? "C (GCC 14 / C17)" : "C++ (GCC 14 / C++20)";
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
