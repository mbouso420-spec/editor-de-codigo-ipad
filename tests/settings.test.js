import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { KEYBOARD_SHORTCUTS, initSettingsModal } from "../js/ui/settingsModal.js";
import { keyboardRouter } from "../js/ui/keyboardRouter.js";

function createMockEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  if (attrs.id) el.id = attrs.id;
  if (attrs.class) el.className = attrs.class;
  if (attrs.type) el.type = attrs.type;
  if (attrs.checked !== undefined) el.checked = attrs.checked;
  if (attrs.value !== undefined) el.value = attrs.value;
  for (const [k, v] of Object.entries(attrs)) {
    if (!["id", "class", "type", "checked", "value"].includes(k)) {
      el.setAttribute(k, v);
    }
  }
  for (const ch of children) {
    el.appendChild(ch);
  }
  return el;
}

describe("SettingsModal y Ranura de Configuración del IDE", () => {
  beforeEach(() => {
    localStorage.clear();
    if (document.documentElement.dataset) {
      delete document.documentElement.dataset.theme;
    }
    keyboardRouter.modalStack = [];

    // Clear document.body
    document.body.children = [];

    // Build DOM structure
    const btnOpen = createMockEl("button", { id: "btn-open-settings" });
    const btnWrap = createMockEl("button", { id: "btn-editor-wrap", "aria-pressed": "true" });
    const btnMinimap = createMockEl("button", { id: "btn-editor-minimap", "aria-pressed": "true" });

    const dialog = createMockEl("dialog", { id: "settings-dialog" });
    dialog.open = false;
    dialog.showModal = function () {
      this.open = true;
    };
    dialog.close = function () {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };

    const btnClose = createMockEl("button", { id: "btn-close-settings" });
    const tabAppearance = createMockEl("button", { class: "settings-tab-btn is-active", "data-tab": "appearance", "aria-selected": "true" });
    const tabShortcuts = createMockEl("button", { class: "settings-tab-btn", "data-tab": "shortcuts", "aria-selected": "false" });
    const tabStorage = createMockEl("button", { class: "settings-tab-btn", "data-tab": "storage", "aria-selected": "false" });

    const selectTheme = createMockEl("select", { id: "select-theme" });
    const chkWordWrap = createMockEl("input", { id: "setting-word-wrap", type: "checkbox", checked: true });
    const chkMinimap = createMockEl("input", { id: "setting-minimap", type: "checkbox", checked: true });
    const panelAppearance = createMockEl("section", { class: "settings-tab-panel", "data-tab": "appearance" }, [
      selectTheme, chkWordWrap, chkMinimap
    ]);

    const filterShortcuts = createMockEl("input", { id: "setting-shortcuts-filter", type: "search" });
    const listShortcuts = createMockEl("div", { id: "setting-shortcuts-list" });
    const panelShortcuts = createMockEl("section", { class: "settings-tab-panel", "data-tab": "shortcuts" }, [
      filterShortcuts, listShortcuts
    ]);
    panelShortcuts.hidden = true;

    const selectKeyStorage = createMockEl("select", { id: "setting-key-storage" });
    const quotaText = createMockEl("span", { id: "setting-quota-text" });
    const panelStorage = createMockEl("section", { class: "settings-tab-panel", "data-tab": "storage" }, [
      selectKeyStorage, quotaText
    ]);
    panelStorage.hidden = true;

    dialog.appendChild(btnClose);
    dialog.appendChild(tabAppearance);
    dialog.appendChild(tabShortcuts);
    dialog.appendChild(tabStorage);
    dialog.appendChild(panelAppearance);
    dialog.appendChild(panelShortcuts);
    dialog.appendChild(panelStorage);

    document.body.appendChild(btnOpen);
    document.body.appendChild(btnWrap);
    document.body.appendChild(btnMinimap);
    document.body.appendChild(dialog);
  });

  test("Catálogo de atajos de teclado completo y estructurado", () => {
    assert.ok(Array.isArray(KEYBOARD_SHORTCUTS));
    assert.ok(KEYBOARD_SHORTCUTS.length >= 8);

    const categories = new Set(KEYBOARD_SHORTCUTS.map((s) => s.category));
    assert.ok(categories.has("Navegación"));
    assert.ok(categories.has("Búsqueda"));
    assert.ok(categories.has("General"));
    assert.ok(categories.has("Editor"));

    for (const shortcut of KEYBOARD_SHORTCUTS) {
      assert.ok(shortcut.combo && typeof shortcut.combo === "string");
      assert.ok(shortcut.desc && typeof shortcut.desc === "string");
      assert.ok(shortcut.category && typeof shortcut.category === "string");
    }
  });

  test("Apertura, cierre y registro en KeyboardRouter modalStack", () => {
    let wrapState = true;
    let minimapState = true;

    const mockEditor = {
      isWordWrapEnabled: () => wrapState,
      toggleWordWrap: () => {
        wrapState = !wrapState;
        return wrapState;
      },
      isMinimapVisible: () => minimapState,
      toggleMinimap: () => {
        minimapState = !minimapState;
        return minimapState;
      },
      getFontSize: () => 14,
      stepFontSize: () => 14
    };

    const modal = initSettingsModal({ editor: mockEditor });
    const dialog = document.getElementById("settings-dialog");

    assert.equal(dialog.open, false);
    assert.equal(keyboardRouter.getActiveModal(), null);

    modal.open();
    assert.equal(dialog.open, true);
    assert.equal(keyboardRouter.getActiveModal()?.id, "settings-dialog");

    modal.close();
    assert.equal(dialog.open, false);
    assert.equal(keyboardRouter.getActiveModal(), null);
  });

  test("Cambio de tema actualiza dataset.theme y localStorage", () => {
    let notifiedTheme = null;
    initSettingsModal({
      editor: null,
      onThemeChange: (t) => {
        notifiedTheme = t;
      }
    });

    const select = document.getElementById("select-theme");

    select.value = "dracula";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, "dracula");
    assert.equal(localStorage.getItem("studio_theme"), "dracula");
    assert.equal(notifiedTheme, "dracula");

    select.value = "nord";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, "nord");
    assert.equal(localStorage.getItem("studio_theme"), "nord");

    select.value = "default";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, undefined);
    assert.equal(localStorage.getItem("studio_theme"), null);
  });

  test("Alternar Word Wrap y Minimap sincroniza checkboxes y barra de herramientas", () => {
    let wrapState = true;
    let minimapState = true;

    const mockEditor = {
      isWordWrapEnabled: () => wrapState,
      toggleWordWrap: () => {
        wrapState = !wrapState;
        return wrapState;
      },
      isMinimapVisible: () => minimapState,
      toggleMinimap: () => {
        minimapState = !minimapState;
        return minimapState;
      }
    };

    initSettingsModal({ editor: mockEditor });

    const chkWrap = document.getElementById("setting-word-wrap");
    const chkMinimap = document.getElementById("setting-minimap");
    const btnWrap = document.getElementById("btn-editor-wrap");
    const btnMinimap = document.getElementById("btn-editor-minimap");

    // Toggle wrap
    chkWrap.dispatchEvent(new Event("change"));
    assert.equal(wrapState, false);
    assert.equal(chkWrap.checked, false);
    assert.equal(btnWrap.getAttribute("aria-pressed"), "false");

    // Toggle minimap
    chkMinimap.dispatchEvent(new Event("change"));
    assert.equal(minimapState, false);
    assert.equal(chkMinimap.checked, false);
    assert.equal(btnMinimap.getAttribute("aria-pressed"), "false");
  });

  test("Filtrado interactivo de atajos de teclado", () => {
    const modal = initSettingsModal({ editor: null });
    modal.open();

    const filterInput = document.getElementById("setting-shortcuts-filter");
    const listEl = document.getElementById("setting-shortcuts-list");

    // Buscar "Shift + F"
    filterInput.value = "Shift + F";
    filterInput.dispatchEvent(new Event("input"));
    assert.ok(listEl.innerHTML.includes("Búsqueda"));
    assert.ok(listEl.innerHTML.includes("Cmd/Ctrl + Shift + F"));

    // Buscar término inexistente
    filterInput.value = "xyzInexistente123";
    filterInput.dispatchEvent(new Event("input"));
    assert.ok(listEl.innerHTML.includes("No se encontraron atajos"));
  });

  test("Cambio de pestaña actualiza clases y atributos aria-selected", () => {
    initSettingsModal({ editor: null });

    const tabButtons = document.querySelectorAll(".settings-tab-btn");
    const tabShortcuts = Array.from(tabButtons).find((b) => b.dataset.tab === "shortcuts");
    const panelShortcuts = document.querySelector('.settings-tab-panel[data-tab="shortcuts"]');
    const panelAppearance = document.querySelector('.settings-tab-panel[data-tab="appearance"]');

    tabShortcuts.click();

    assert.equal(tabShortcuts.classList.contains("is-active"), true);
    assert.equal(tabShortcuts.getAttribute("aria-selected"), "true");
    assert.equal(panelShortcuts.hidden, false);
    assert.equal(panelAppearance.hidden, true);
  });
});
