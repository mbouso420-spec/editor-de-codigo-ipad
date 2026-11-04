const PREF_KEYS = {
  wordWrap: "ide.editor.wordWrap",
  fontSize: "ide.editor.fontSize"
};

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 22;
const DEFAULT_FONT_SIZE = 14;

/**
 * Devuelve la cantidad de espacios de indentación inteligente según el lenguaje:
 * 4 espacios para Python, C, C++ y SQL; 2 espacios para HTML, CSS y JavaScript.
 * @param {string} lang
 * @returns {number}
 */
export function getIndentSize(lang) {
  return lang === "python" || lang === "cpp" || lang === "c" || lang === "sql" ? 4 : 2;
}

/**
 * Gestor del motor de código principal basado en CodeMirror 6 vía ES Modules,
 * con caché de estado (historial Undo/Redo y cursor por archivo), indentación inteligente,
 * controles táctiles y respaldo resiliente si no hay red en la primera carga.
 *
 * @param {{
 *   mountEl: HTMLElement,
 *   onDocChange: (fileId: string, content: string) => void,
 *   onSelectionChange: (selection: { text: string, lineCount: number }) => void
 * }} config
 */
export async function createEditorManager({ mountEl, onDocChange, onSelectionChange }) {
  let wordWrap = readStoredBool(PREF_KEYS.wordWrap, true);
  let fontSize = clampFontSize(Number(readStoredValue(PREF_KEYS.fontSize)) || DEFAULT_FONT_SIZE);
  let activeFileId = null;

  applyFontSize(fontSize);

  let cm = null;
  try {
    cm = await loadCodeMirrorModules();
  } catch (error) {
    console.warn("CodeMirror 6 no pudo cargarse desde la red; activando superficie local de respaldo.", error);
  }

  if (!cm) {
    return createFallbackEditor({
      mountEl,
      initialWrap: wordWrap,
      initialFontSize: fontSize,
      onDocChange,
      onSelectionChange
    });
  }

  const {
    EditorState,
    Compartment,
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    syntaxHighlighting,
    HighlightStyle,
    foldGutter,
    foldKeymap,
    bracketMatching,
    indentOnInput,
    indentUnit,
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    undo,
    redo,
    search,
    searchKeymap,
    openSearchPanel,
    autocompletion,
    completionKeymap,
    completeAnyWord,
    closeBrackets,
    closeBracketsKeymap,
    tags,
    langs
  } = cm;

  const wrapCompartment = new Compartment();
  const statesByFile = new Map();

  // Tema sintáctico acoplado 100% a nuestros tokens CSS (:root)
  const highlightRules = [
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
    { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syn-type)" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-fn)" },
    { tag: [tags.string, tags.special(tags.string)], color: "var(--syn-string)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syn-number)" },
    { tag: [tags.operator, tags.punctuation], color: "var(--syn-operator)" },
    { tag: [tags.tagName], color: "var(--syn-tag)" },
    { tag: [tags.attributeName, tags.propertyName], color: "var(--syn-attr)" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syn-comment)", fontStyle: "italic" }
  ];
  if (tags.heading) {
    highlightRules.push({ tag: [tags.heading], color: "var(--syn-keyword)", fontWeight: "600" });
  }
  if (tags.strong) {
    highlightRules.push({ tag: [tags.strong], color: "var(--color-ink)", fontWeight: "600" });
  }
  if (tags.emphasis) {
    highlightRules.push({ tag: [tags.emphasis], fontStyle: "italic" });
  }
  if (tags.link) {
    highlightRules.push({ tag: [tags.link], color: "var(--syn-attr)" });
  }
  if (tags.monospace) {
    highlightRules.push({ tag: [tags.monospace], color: "var(--syn-string)" });
  }
  const studioHighlightStyle = HighlightStyle.define(highlightRules);

  const studioBaseTheme = EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--color-editor-bg)",
        color: "var(--color-ink)"
      },
      ".cm-content": {
        caretColor: "var(--color-accent-text)",
        paddingBlock: "var(--space-sm)"
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-editor-gutter)",
        color: "var(--color-gutter-ink)",
        borderRight: "var(--rule-hair) solid var(--color-rule)"
      },
      ".cm-matchingBracket": {
        backgroundColor: "var(--color-accent-soft)",
        outline: "1px solid var(--color-rule-strong)"
      }
    },
    { dark: true }
  );

  let view = null;

  function resolveLanguageExtension(lang) {
    switch (lang) {
      case "python":
        return langs.python ? langs.python() : [];
      case "markdown":
        return langs.markdown ? langs.markdown() : [];
      case "text":
        return [];
      case "cpp":
      case "c":
        return langs.cpp();
      case "html":
        return langs.html();
      case "css":
        return langs.css();
      case "sql":
        return langs.sql();
      case "js":
      case "json":
      default:
        return langs.javascript();
    }
  }

  function buildEditorState(file) {
    const spaces = getIndentSize(file.lang);
    const indentStr = " ".repeat(spaces);

    return EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, icons: false }),
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        history(),
        search({ top: true }),
        EditorState.tabSize.of(spaces),
        indentUnit.of(indentStr),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        resolveLanguageExtension(file.lang),
        syntaxHighlighting(studioHighlightStyle),
        studioBaseTheme,
        keymap.of([
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && activeFileId) {
            onDocChange(activeFileId, update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            emitSelection(update.state);
          }
        })
      ]
    });
  }

  function emitSelection(state) {
    const main = state.selection.main;
    const headLine = state.doc.lineAt(main.head);
    const cursorLine = headLine.number;
    const cursorCol = main.head - headLine.from + 1;

    if (main.empty) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const selectedText = state.sliceDoc(main.from, main.to);
    const fromLine = state.doc.lineAt(main.from).number;
    const toLine = state.doc.lineAt(main.to).number;
    onSelectionChange({
      text: selectedText,
      lineCount: Math.max(1, toLine - fromLine + 1),
      cursorLine,
      cursorCol
    });
  }

  function openFile(file) {
    if (view && activeFileId) {
      statesByFile.set(activeFileId, view.state);
    }

    activeFileId = file.id;
    let nextState = statesByFile.get(file.id);

    if (!nextState) {
      nextState = buildEditorState(file);
      statesByFile.set(file.id, nextState);
    } else {
      // Sincronizar Word Wrap actual al recuperar estado en caché
      nextState = nextState.update({
        effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : [])
      }).state;
    }

    if (!view) {
      mountEl.innerHTML = "";
      view = new EditorView({
        state: nextState,
        parent: mountEl
      });
    } else {
      view.setState(nextState);
    }

    emitSelection(view.state);
  }

  function clearActiveFile() {
    if (view && activeFileId) {
      statesByFile.set(activeFileId, view.state);
    }
    activeFileId = null;
    onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
  }

  function dropFileState(fileId) {
    statesByFile.delete(fileId);
    if (activeFileId === fileId) {
      activeFileId = null;
    }
  }

  function renameFileStates(oldPath, newPath, isFolder) {
    if (view && activeFileId) {
      statesByFile.set(activeFileId, view.state);
    }

    const updates = [];
    for (const [key, stateVal] of statesByFile.entries()) {
      if (key === oldPath) {
        updates.push([key, newPath, stateVal]);
      } else if (isFolder && key.startsWith(`${oldPath}/`)) {
        updates.push([key, `${newPath}${key.slice(oldPath.length)}`, stateVal]);
      }
    }

    for (const [fromKey, toKey, stateVal] of updates) {
      statesByFile.delete(fromKey);
      statesByFile.set(toKey, stateVal);
    }

    if (activeFileId === oldPath) {
      activeFileId = newPath;
    } else if (isFolder && activeFileId && activeFileId.startsWith(`${oldPath}/`)) {
      activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
    }
  }

  function insertAtCursor(text, cursorBack = 0) {
    if (!view) {
      return;
    }
    const range = view.state.selection.main;
    const nextAnchor = Math.max(0, range.from + text.length - cursorBack);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: nextAnchor },
      scrollIntoView: true
    });
    view.focus();
  }

  function replaceSelection(text) {
    insertAtCursor(text, 0);
  }

  function replaceEntireDocument(text) {
    if (!view) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text }
    });
  }

  function triggerUndo() {
    if (view) {
      undo(view);
      view.focus();
    }
  }

  function triggerRedo() {
    if (view) {
      redo(view);
      view.focus();
    }
  }

  function triggerSearch() {
    if (view) {
      openSearchPanel(view);
    }
  }

  function toggleWordWrap() {
    wordWrap = !wordWrap;
    saveStoredValue(PREF_KEYS.wordWrap, String(wordWrap));
    if (view) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : [])
      });
    }
    return wordWrap;
  }

  function stepFontSize(delta) {
    fontSize = clampFontSize(fontSize + delta);
    saveStoredValue(PREF_KEYS.fontSize, String(fontSize));
    applyFontSize(fontSize);
    if (view) {
      view.requestMeasure();
    }
    return fontSize;
  }

  return {
    openFile,
    clearActiveFile,
    dropFileState,
    renameFileStates,
    insertAtCursor,
    replaceSelection,
    replaceEntireDocument,
    triggerUndo,
    triggerRedo,
    triggerSearch,
    toggleWordWrap,
    isWordWrapEnabled: () => wordWrap,
    stepFontSize,
    getFontSize: () => fontSize
  };
}

async function loadCodeMirrorModules() {
  const [
    stateMod,
    viewMod,
    langMod,
    cmdMod,
    searchMod,
    autoMod,
    hiMod,
    cppMod,
    htmlMod,
    cssMod,
    jsMod,
    pyMod,
    mdMod,
    sqlMod
  ] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    import("@codemirror/autocomplete"),
    import("@lezer/highlight"),
    import("@codemirror/lang-cpp"),
    import("@codemirror/lang-html"),
    import("@codemirror/lang-css"),
    import("@codemirror/lang-javascript"),
    import("@codemirror/lang-python").catch(() => null),
    import("@codemirror/lang-markdown").catch(() => null),
    import("@codemirror/lang-sql")
  ]);

  return {
    EditorState: stateMod.EditorState,
    Compartment: stateMod.Compartment,
    EditorView: viewMod.EditorView,
    keymap: viewMod.keymap,
    lineNumbers: viewMod.lineNumbers,
    highlightActiveLine: viewMod.highlightActiveLine,
    highlightActiveLineGutter: viewMod.highlightActiveLineGutter,
    drawSelection: viewMod.drawSelection,
    syntaxHighlighting: langMod.syntaxHighlighting,
    HighlightStyle: langMod.HighlightStyle,
    foldGutter: langMod.foldGutter,
    foldKeymap: langMod.foldKeymap,
    bracketMatching: langMod.bracketMatching,
    indentOnInput: langMod.indentOnInput,
    indentUnit: langMod.indentUnit,
    defaultKeymap: cmdMod.defaultKeymap,
    history: cmdMod.history,
    historyKeymap: cmdMod.historyKeymap,
    indentWithTab: cmdMod.indentWithTab,
    undo: cmdMod.undo,
    redo: cmdMod.redo,
    search: searchMod.search,
    searchKeymap: searchMod.searchKeymap,
    openSearchPanel: searchMod.openSearchPanel,
    autocompletion: autoMod.autocompletion,
    completionKeymap: autoMod.completionKeymap,
    completeAnyWord: autoMod.completeAnyWord,
    closeBrackets: autoMod.closeBrackets,
    closeBracketsKeymap: autoMod.closeBracketsKeymap,
    tags: hiMod.tags,
    langs: {
      cpp: cppMod.cpp,
      html: htmlMod.html,
      css: cssMod.css,
      javascript: jsMod.javascript,
      python: pyMod?.python ?? null,
      markdown: mdMod?.markdown ?? null,
      sql: sqlMod.sql
    }
  };
}

/**
 * Respaldo local ligero por si el usuario abre el IDE sin conexión antes del cacheo PWA.
 */
function createFallbackEditor({ mountEl, initialWrap, initialFontSize, onDocChange, onSelectionChange }) {
  let wordWrap = initialWrap;
  let fontSize = initialFontSize;
  let activeFileId = null;
  let activeLang = "js";

  const textarea = document.createElement("textarea");
  textarea.className = "editor-fallback-surface";
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("aria-label", "Editor de código");
  textarea.wrap = wordWrap ? "soft" : "off";
  mountEl.innerHTML = "";
  mountEl.appendChild(textarea);

  textarea.addEventListener("input", () => {
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    emitSel();
  });

  const emitSel = () => {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const before = textarea.value.slice(0, end);
    const lastNl = before.lastIndexOf("\n");
    const cursorLine = lastNl === -1 ? 1 : before.split("\n").length;
    const cursorCol = lastNl === -1 ? end + 1 : end - lastNl;

    if (start === end) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const text = textarea.value.slice(start, end);
    onSelectionChange({ text, lineCount: text.split("\n").length, cursorLine, cursorCol });
  };

  textarea.addEventListener("select", emitSel);
  textarea.addEventListener("keyup", emitSel);
  textarea.addEventListener("mouseup", emitSel);
  textarea.addEventListener("click", emitSel);

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const spaces = " ".repeat(getIndentSize(activeLang));
      insertInTextarea(spaces, 0);
    }
  });

  function insertInTextarea(text, cursorBack = 0) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.focus();
    textarea.setRangeText(text, start, end, "end");
    if (cursorBack > 0) {
      const pos = Math.max(0, start + text.length - cursorBack);
      textarea.setSelectionRange(pos, pos);
    }
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    emitSel();
  }

  return {
    openFile(file) {
      activeFileId = file.id;
      activeLang = file.lang;
      if (!mountEl.contains(textarea)) {
        mountEl.innerHTML = "";
        mountEl.appendChild(textarea);
      }
      textarea.value = file.content;
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    clearActiveFile() {
      activeFileId = null;
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    dropFileState(fileId) {
      if (activeFileId === fileId) {
        activeFileId = null;
      }
    },
    renameFileStates() {},
    insertAtCursor: insertInTextarea,
    replaceSelection: (text) => insertInTextarea(text, 0),
    replaceEntireDocument(text) {
      textarea.value = text;
      if (activeFileId) {
        onDocChange(activeFileId, text);
      }
      emitSel();
    },
    triggerUndo() {
      textarea.focus();
      document.execCommand("undo");
    },
    triggerRedo() {
      textarea.focus();
      document.execCommand("redo");
    },
    triggerSearch() {
      textarea.focus();
    },
    toggleWordWrap() {
      wordWrap = !wordWrap;
      textarea.wrap = wordWrap ? "soft" : "off";
      saveStoredValue(PREF_KEYS.wordWrap, String(wordWrap));
      return wordWrap;
    },
    isWordWrapEnabled: () => wordWrap,
    stepFontSize(delta) {
      fontSize = clampFontSize(fontSize + delta);
      saveStoredValue(PREF_KEYS.fontSize, String(fontSize));
      applyFontSize(fontSize);
      return fontSize;
    },
    getFontSize: () => fontSize
  };
}

function applyFontSize(px) {
  document.documentElement.style.setProperty("--editor-font-size", `${px}px`);
}

function clampFontSize(px) {
  return Math.min(Math.max(Math.round(px), MIN_FONT_SIZE), MAX_FONT_SIZE);
}

function readStoredBool(key, fallback) {
  const raw = readStoredValue(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignorar errores de almacenamiento restringido
  }
}
