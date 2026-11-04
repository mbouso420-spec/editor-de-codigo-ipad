const STORAGE_KEYS = {
  leftOpen: "ide.layout.leftOpen",
  rightOpen: "ide.layout.rightOpen",
  leftWidth: "ide.layout.leftWidth",
  rightWidth: "ide.layout.rightWidth"
};

const COMPACT_MEDIA = "(max-width: 74rem)";

/**
 * Inicializa el sistema de layout híbrido de 3 paneles (islas acopladas en ancho / drawers flotantes en Stage Manager o vertical),
 * divisores táctiles, atajos de teclado, gestos swipe de cierre y ajuste al teclado virtual de iPadOS.
 */
export function initLayoutController() {
  const mqCompact = window.matchMedia(COMPACT_MEDIA);
  const btnLeft = document.getElementById("btn-toggle-left");
  const btnRight = document.getElementById("btn-toggle-right");
  const btnCloseLeft = document.getElementById("btn-close-left");
  const btnCloseRight = document.getElementById("btn-close-right");
  const backdrop = document.getElementById("drawer-backdrop");
  const panelLeft = document.getElementById("panel-explorer");
  const panelRight = document.getElementById("panel-assistant");
  const resizerLeft = document.getElementById("resizer-left");
  const resizerRight = document.getElementById("resizer-right");

  const isCompact = () => mqCompact.matches;

  let leftOpen = readStoredBool(STORAGE_KEYS.leftOpen, !isCompact());
  let rightOpen = readStoredBool(STORAGE_KEYS.rightOpen, !isCompact());

  // En modo compacto inicial evitamos abrir ambos drawers superpuestos a la vez
  if (isCompact() && leftOpen && rightOpen) {
    leftOpen = false;
  }

  restorePanelWidths();
  applyState();

  function applyState() {
    document.body.dataset.leftOpen = String(leftOpen);
    document.body.dataset.rightOpen = String(rightOpen);
    document.body.dataset.drawerBackdrop = String(isCompact() && (leftOpen || rightOpen));

    if (btnLeft) {
      btnLeft.setAttribute("aria-expanded", String(leftOpen));
    }
    if (btnRight) {
      btnRight.setAttribute("aria-expanded", String(rightOpen));
    }
  }

  function setLeftOpen(next) {
    leftOpen = Boolean(next);
    if (isCompact() && leftOpen && rightOpen) {
      rightOpen = false;
    }
    persistBool(STORAGE_KEYS.leftOpen, leftOpen);
    persistBool(STORAGE_KEYS.rightOpen, rightOpen);
    applyState();
  }

  function setRightOpen(next) {
    rightOpen = Boolean(next);
    if (isCompact() && rightOpen && leftOpen) {
      leftOpen = false;
    }
    persistBool(STORAGE_KEYS.leftOpen, leftOpen);
    persistBool(STORAGE_KEYS.rightOpen, rightOpen);
    applyState();
  }

  btnLeft?.addEventListener("click", () => setLeftOpen(!leftOpen));
  btnRight?.addEventListener("click", () => setRightOpen(!rightOpen));
  btnCloseLeft?.addEventListener("click", () => setLeftOpen(false));
  btnCloseRight?.addEventListener("click", () => setRightOpen(false));
  backdrop?.addEventListener("click", () => {
    setLeftOpen(false);
    setRightOpen(false);
  });

  mqCompact.addEventListener("change", (event) => {
    if (event.matches && leftOpen && rightOpen) {
      leftOpen = false;
    }
    applyState();
  });

  // Atajos de teclado (Cmd/Ctrl + B para Explorador, Cmd/Ctrl + J para Asistente, Escape para cerrar drawers)
  window.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && !event.shiftKey && !event.altKey && key === "b") {
      event.preventDefault();
      setLeftOpen(!leftOpen);
      return;
    }

    if (mod && !event.shiftKey && !event.altKey && key === "j") {
      event.preventDefault();
      setRightOpen(!rightOpen);
      return;
    }

    if (event.key === "Escape" && isCompact() && (leftOpen || rightOpen)) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  });

  // Divisores arrastrables con soporte táctil y mouse (Pointer Events)
  if (resizerLeft) {
    bindSplitter(resizerLeft, "left");
  }
  if (resizerRight) {
    bindSplitter(resizerRight, "right");
  }

  // Gestos swipe cortos sobre cada panel abierto para cerrarlo sin interferir con bordes de Safari/Stage Manager
  if (panelLeft) {
    bindSwipeToClose(panelLeft, "left", () => setLeftOpen(false));
  }
  if (panelRight) {
    bindSwipeToClose(panelRight, "right", () => setRightOpen(false));
  }

  // Sincronización con visualViewport para elevar la barra de símbolos sobre el teclado virtual de iPadOS
  bindVisualViewport();

  return {
    closeLeftOnCompactSelect() {
      if (isCompact() && leftOpen) {
        setLeftOpen(false);
      }
    },
    closeRightOnCompactAction() {
      if (isCompact() && rightOpen) {
        setRightOpen(false);
      }
    }
  };
}

function bindSplitter(handle, side) {
  let activePointerId = null;

  handle.setAttribute("role", "separator");
  handle.setAttribute("tabindex", "0");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute(
    "aria-label",
    side === "left" ? "Divisor de ancho del explorador de archivos" : "Divisor de ancho del panel de asistente"
  );

  const applyWidth = (nextWidth) => {
    if (side === "left") {
      document.documentElement.style.setProperty("--left-panel-w", `${nextWidth}px`);
      safeSetStorage(STORAGE_KEYS.leftWidth, String(nextWidth));
    } else {
      document.documentElement.style.setProperty("--right-panel-w", `${nextWidth}px`);
      safeSetStorage(STORAGE_KEYS.rightWidth, String(nextWidth));
    }
    handle.setAttribute("aria-valuenow", String(nextWidth));
  };

  handle.addEventListener("keydown", (event) => {
    const step = 16;
    const viewportWidth = window.innerWidth;
    const isLeft = side === "left";
    const currentW = isLeft
      ? Number(safeGetStorage(STORAGE_KEYS.leftWidth)) || 256
      : Number(safeGetStorage(STORAGE_KEYS.rightWidth)) || 360;

    let targetW = currentW;
    if (event.key === "ArrowLeft") {
      targetW = isLeft ? currentW - step : currentW + step;
    } else if (event.key === "ArrowRight") {
      targetW = isLeft ? currentW + step : currentW - step;
    } else if (event.key === "Home") {
      targetW = isLeft ? 190 : 260;
    } else if (event.key === "End") {
      targetW = isLeft
        ? Math.min(420, Math.floor(viewportWidth * 0.36))
        : Math.min(540, Math.floor(viewportWidth * 0.44));
    } else {
      return;
    }

    event.preventDefault();
    const clampedW = isLeft
      ? clamp(targetW, 190, Math.min(420, Math.floor(viewportWidth * 0.36)))
      : clamp(targetW, 260, Math.min(540, Math.floor(viewportWidth * 0.44)));
    applyWidth(clampedW);
  });

  handle.addEventListener("pointerdown", (event) => {
    activePointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }

    const viewportWidth = window.innerWidth;
    if (side === "left") {
      const nextWidth = clamp(Math.round(event.clientX - 8), 190, Math.min(420, Math.floor(viewportWidth * 0.36)));
      applyWidth(nextWidth);
    } else {
      const nextWidth = clamp(Math.round(viewportWidth - event.clientX - 8), 260, Math.min(540, Math.floor(viewportWidth * 0.44)));
      applyWidth(nextWidth);
    }
  });

  const endDrag = (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    activePointerId = null;
    handle.classList.remove("is-dragging");
  };

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function bindSwipeToClose(panel, direction, onClose) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  panel.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.target;
      // No interceptar el scroll horizontal dentro de bloques <pre> de código
      if (target instanceof Element && target.closest("pre, code, input, textarea")) {
        tracking = false;
        return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  panel.addEventListener(
    "touchend",
    (event) => {
      if (!tracking || event.changedTouches.length !== 1) {
        return;
      }
      tracking = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;

      if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.35) {
        return;
      }

      if (direction === "left" && dx < 0) {
        onClose();
      } else if (direction === "right" && dx > 0) {
        onClose();
      }
    },
    { passive: true }
  );
}

function bindVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) {
    return;
  }

  const syncViewport = () => {
    const vHeight = Math.round(vv.height);
    const offsetTop = Math.max(0, Math.round(vv.offsetTop));
    const keyboardOpen = window.innerHeight - vHeight > 110;

    document.documentElement.style.setProperty("--vvh", `${vHeight}px`);
    document.documentElement.style.setProperty("--vv-offset-top", `${offsetTop}px`);
    document.body.dataset.keyboardOpen = String(keyboardOpen);

    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }

    if (keyboardOpen) {
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLElement &&
        (activeEl.matches("input, textarea") || activeEl.closest(".ide-dialog"))
      ) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  };

  syncViewport();
  vv.addEventListener("resize", syncViewport);
  vv.addEventListener("scroll", syncViewport);
}

function restorePanelWidths() {
  const leftW = Number(safeGetStorage(STORAGE_KEYS.leftWidth));
  const rightW = Number(safeGetStorage(STORAGE_KEYS.rightWidth));
  if (Number.isFinite(leftW) && leftW >= 190 && leftW <= 420) {
    document.documentElement.style.setProperty("--left-panel-w", `${leftW}px`);
  }
  if (Number.isFinite(rightW) && rightW >= 260 && rightW <= 540) {
    document.documentElement.style.setProperty("--right-panel-w", `${rightW}px`);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readStoredBool(key, fallback) {
  const raw = safeGetStorage(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function persistBool(key, value) {
  safeSetStorage(key, String(value));
}

function safeGetStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignorar en navegación privada estricta
  }
}
