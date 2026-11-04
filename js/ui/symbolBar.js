const SYMBOL_STORAGE_KEY = "ide.symbols.visible";

/**
 * Mapas de símbolos táctiles adaptados al lenguaje activo.
 * Indentación inteligente: 4 espacios en C/C++ y SQL; 2 espacios en HTML, CSS y JS.
 */
const LANGUAGE_SYMBOLS = {
  cpp: {
    label: "C / C++",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "->", insert: "->", cursorBack: 0 },
      { label: "::", insert: "::", cursorBack: 0 },
      { label: "#include", insert: "#include <>", cursorBack: 1 },
      { label: "std::", insert: "std::", cursorBack: 0 },
      { label: "*", insert: "*", cursorBack: 0 },
      { label: "&", insert: "&", cursorBack: 0 },
      { label: "=", insert: " = ", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  html: {
    label: "HTML",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "< >", insert: "<>", cursorBack: 1 },
      { label: "</>", insert: "</>", cursorBack: 1 },
      { label: "/>", insert: " />", cursorBack: 0 },
      { label: "=\"\"", insert: "=\"\"", cursorBack: 1 },
      { label: "class", insert: "class=\"\"", cursorBack: 1 },
      { label: "id", insert: "id=\"\"", cursorBack: 1 },
      { label: "div", insert: "<div></div>", cursorBack: 6 },
      { label: "!", insert: "!", cursorBack: 0 }
    ]
  },
  css: {
    label: "CSS",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "{ }", insert: " {\n  \n}", cursorBack: 2 },
      { label: ":", insert: ": ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "var()", insert: "var(--)", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "--", insert: "--", cursorBack: 0 },
      { label: "px", insert: "px", cursorBack: 0 },
      { label: "rem", insert: "rem", cursorBack: 0 },
      { label: ".", insert: ".", cursorBack: 0 }
    ]
  },
  js: {
    label: "JavaScript",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "=>", insert: " => ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "const", insert: "const ", cursorBack: 0 },
      { label: "===", insert: " === ", cursorBack: 0 },
      { label: "` `", insert: "``", cursorBack: 1 },
      { label: "${}", insert: "${}", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  python: {
    label: "Python",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: ":", insert: ":", cursorBack: 0 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "def", insert: "def ", cursorBack: 0 },
      { label: "return", insert: "return ", cursorBack: 0 },
      { label: "print()", insert: "print()", cursorBack: 1 },
      { label: "f\"\"", insert: "f\"\"", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 },
      { label: "=", insert: " = ", cursorBack: 0 },
      { label: "==", insert: " == ", cursorBack: 0 },
      { label: "#", insert: "# ", cursorBack: 0 },
      { label: "_", insert: "_", cursorBack: 0 }
    ]
  },
  sql: {
    label: "SQL",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "SELECT", insert: "SELECT ", cursorBack: 0 },
      { label: "FROM", insert: "FROM ", cursorBack: 0 },
      { label: "WHERE", insert: "WHERE ", cursorBack: 0 },
      { label: "JOIN", insert: "JOIN ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "' '", insert: "''", cursorBack: 1 },
      { label: "=", insert: " = ", cursorBack: 0 },
      { label: "*", insert: "*", cursorBack: 0 },
      { label: "_", insert: "_", cursorBack: 0 }
    ]
  }
};

/**
 * Inicializa la barra inferior de símbolos rápidos para iPad, adaptable al lenguaje y ocultable en PC.
 * @param {{ onInsert: (text: string, cursorBack: number) => void }} options
 */
export function initSymbolBar({ onInsert }) {
  const track = document.getElementById("symbol-keys-track");
  const langPill = document.getElementById("symbol-lang-pill");
  const toggleBtn = document.getElementById("btn-toggle-symbols");

  const defaultVisible = readDefaultVisibility();
  let visible = readStoredBool(SYMBOL_STORAGE_KEY, defaultVisible);

  applyVisibility();

  toggleBtn?.addEventListener("click", () => {
    visible = !visible;
    saveStoredBool(SYMBOL_STORAGE_KEY, visible);
    applyVisibility();
  });

  function applyVisibility() {
    document.body.dataset.symbolsVisible = String(visible);
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-pressed", String(visible));
    }
  }

  /**
   * Actualiza las teclas rápidas según la extensión o lenguaje del archivo activo.
   * @param {string} langKey
   */
  function setLanguage(langKey) {
    const normalized = langKey === "c" ? "cpp" : langKey;
    const config = LANGUAGE_SYMBOLS[normalized] ?? LANGUAGE_SYMBOLS.js;
    if (langPill) {
      langPill.textContent = config.label;
    }
    if (!track) {
      return;
    }

    track.innerHTML = "";
    for (const item of config.keys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "symbol-key";
      btn.textContent = item.label;
      btn.setAttribute("aria-label", `Insertar ${item.label}`);

      btn.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });

      btn.addEventListener("click", () => {
        onInsert(item.insert, item.cursorBack);
      });

      track.appendChild(btn);
    }
  }

  return { setLanguage };
}

function readDefaultVisibility() {
  if (typeof window.matchMedia === "function") {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (coarse) {
      return true;
    }
  }
  return true;
}

function readStoredBool(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Sin acceso a storage
  }
  return fallback;
}

function saveStoredBool(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Sin acceso a storage
  }
}
