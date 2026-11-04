import { icon } from "./icons.js";

/**
 * Paleta de apertura rápida de archivos (Cmd/Ctrl + P y botón de búsqueda en el Explorador),
 * ideal para saltar en un toque a cualquier archivo de un repositorio grande en el iPad o PC.
 */
export function initQuickOpenModal({ getFiles, onSelectFile }) {
  const openBtn = document.getElementById("btn-quick-open");
  const dialog = document.getElementById("quick-open-dialog");
  const closeBtn = document.getElementById("btn-close-quick-open");
  const input = document.getElementById("quick-open-input");
  const listEl = document.getElementById("quick-open-list");

  let filtered = [];
  let activeIndex = 0;

  function open() {
    if (!dialog) return;
    if (input) {
      input.value = "";
    }
    activeIndex = 0;
    renderResults("");
    if (!dialog.open) {
      dialog.showModal();
    }
    window.requestAnimationFrame(() => {
      input?.focus();
    });
  }

  function close() {
    dialog?.close();
  }

  openBtn?.addEventListener("click", () => open());
  closeBtn?.addEventListener("click", () => close());

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  input?.addEventListener("input", () => {
    activeIndex = 0;
    renderResults(input.value);
  });

  input?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        activeIndex = (activeIndex + 1) % filtered.length;
        syncHighlight();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
        syncHighlight();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = filtered[activeIndex];
      if (chosen) {
        pickFile(chosen.path);
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      if (dialog?.open) {
        close();
      } else {
        open();
      }
    }
  });

  function pickFile(path) {
    close();
    onSelectFile(path);
  }

  function renderResults(rawQuery) {
    if (!listEl) return;
    const allFiles = getFiles() || [];
    const query = String(rawQuery || "").trim().toLowerCase();

    if (!query) {
      filtered = allFiles.slice(0, 50);
    } else {
      const scored = [];
      for (const file of allFiles) {
        const lowerPath = file.path.toLowerCase();
        const lowerName = file.shortName.toLowerCase();
        if (lowerName === query) {
          scored.push({ file, score: 0 });
        } else if (lowerName.startsWith(query)) {
          scored.push({ file, score: 1 });
        } else if (lowerName.includes(query)) {
          scored.push({ file, score: 2 });
        } else if (lowerPath.includes(query)) {
          scored.push({ file, score: 3 });
        }
      }
      scored.sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path));
      filtered = scored.slice(0, 50).map((s) => s.file);
    }

    listEl.innerHTML = "";
    if (filtered.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "quick-open-empty";
      emptyLi.textContent = allFiles.length === 0
        ? "Este proyecto aún no tiene archivos."
        : "No se encontraron archivos con ese nombre.";
      listEl.appendChild(emptyLi);
      return;
    }

    filtered.forEach((file, idx) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = idx === activeIndex ? "quick-open-item is-active" : "quick-open-item";
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "raíz";
      btn.innerHTML = `
        <span class="quick-open-main">
          ${icon(file.icon)}
          <span class="quick-open-name">${escapeHtml(file.shortName)}</span>
          <span class="quick-open-dir code-font">${escapeHtml(dir)}</span>
        </span>
        <span class="file-tree-lang">${escapeHtml(file.badge)}</span>
      `;
      btn.addEventListener("click", () => pickFile(file.path));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function syncHighlight() {
    if (!listEl) return;
    const buttons = listEl.querySelectorAll(".quick-open-item");
    buttons.forEach((btn, idx) => {
      btn.classList.toggle("is-active", idx === activeIndex);
      if (idx === activeIndex && btn instanceof HTMLElement) {
        btn.scrollIntoView({ block: "nearest" });
      }
    });
  }

  return {
    open,
    close
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
