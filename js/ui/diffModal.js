/**
 * Visor de diferencias (Diff en verde y rojo) para revisar cambios línea por línea
 * antes de aplicar reemplazos de la IA o antes de hacer Commit y Push en GitHub.
 */
export function initDiffModal() {
  const dialog = document.getElementById("diff-dialog");
  const titleEl = document.getElementById("diff-dialog-title");
  const statsEl = document.getElementById("diff-dialog-stats");
  const bodyEl = document.getElementById("diff-lines-view");
  const closeBtn = document.getElementById("btn-close-diff");
  const cancelBtn = document.getElementById("btn-diff-cancel");
  const confirmBtn = document.getElementById("btn-diff-confirm");

  let pendingConfirmAction = null;

  closeBtn?.addEventListener("click", () => close());
  cancelBtn?.addEventListener("click", () => close());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  confirmBtn?.addEventListener("click", () => {
    const action = pendingConfirmAction;
    close();
    if (typeof action === "function") {
      action();
    }
  });

  function close() {
    pendingConfirmAction = null;
    dialog?.close();
  }

  function renderDiffView({ title, oldCode, newCode, confirmLabel, onConfirm }) {
    if (!dialog || !bodyEl) return;

    pendingConfirmAction = onConfirm || null;
    if (titleEl) {
      titleEl.textContent = title || "Revisar diferencias";
    }

    const { rows, addedCount, removedCount, lineEndingsOnly } = computeLineDiff(oldCode || "", newCode || "");
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="diff-stat-add">+${addedCount}</span>
        <span class="diff-stat-del">-${removedCount}</span>
      `;
    }

    bodyEl.innerHTML = "";
    if (rows.length === 0 || (addedCount === 0 && removedCount === 0)) {
      const empty = document.createElement("div");
      empty.className = "diff-empty-note";
      empty.textContent = lineEndingsOnly
        ? "Los archivos solo difieren en el formato de fin de línea (CRLF de Windows vs LF de Unix)."
        : "El contenido nuevo es idéntico al actual (sin diferencias).";
      bodyEl.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const row of rows) {
        if (row.type === "skip") {
          const skipEl = document.createElement("div");
          skipEl.className = "diff-row diff-row-skip";
          skipEl.textContent = `… ${row.count} líneas sin cambios …`;
          frag.appendChild(skipEl);
          continue;
        }

        const rowEl = document.createElement("div");
        rowEl.className =
          row.type === "add"
            ? "diff-row diff-row-add"
            : row.type === "del"
              ? "diff-row diff-row-del"
              : "diff-row";

        const numEl = document.createElement("span");
        numEl.className = "diff-line-num";
        numEl.textContent = String(row.lineNo ?? "");

        const signEl = document.createElement("span");
        signEl.className = "diff-line-sign";
        signEl.textContent = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";

        const textEl = document.createElement("span");
        textEl.className = "diff-line-code";
        textEl.textContent = row.text;

        rowEl.append(numEl, signEl, textEl);
        frag.appendChild(rowEl);
      }
      bodyEl.appendChild(frag);
    }

    if (confirmBtn && cancelBtn) {
      if (onConfirm) {
        confirmBtn.hidden = false;
        confirmBtn.textContent = confirmLabel || "Confirmar y aplicar";
        cancelBtn.textContent = "Cancelar";
      } else {
        confirmBtn.hidden = true;
        cancelBtn.textContent = "Cerrar";
      }
    }

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  return {
    openConfirmApplyDiff({ fileName, oldCode, newCode, onConfirm }) {
      renderDiffView({
        title: `Aplicar cambios en ${fileName}`,
        oldCode,
        newCode,
        confirmLabel: "Confirmar y aplicar",
        onConfirm
      });
    },
    openReadOnlyDiff({ title, oldCode, newCode }) {
      renderDiffView({
        title,
        oldCode,
        newCode,
        onConfirm: null
      });
    }
  };
}

function computeLineDiff(oldStr, newStr) {
  const lineEndingsOnly =
    oldStr !== newStr &&
    oldStr.replace(/\r\n/g, "\n") === newStr.replace(/\r\n/g, "\n");

  const a = oldStr === "" ? [] : oldStr.replace(/\r\n/g, "\n").split("\n");
  const b = newStr === "" ? [] : newStr.replace(/\r\n/g, "\n").split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const n = midA.length;
  const m = midB.length;

  let rawOps = [];
  if (n * m <= 900000) {
    rawOps = lcsDiff(a, b, start, endA, endB, midA, midB);
  } else {
    rawOps = fastLargeDiff(a, b);
  }

  let addedCount = 0;
  let removedCount = 0;
  for (const op of rawOps) {
    if (op.type === "add") addedCount += 1;
    if (op.type === "del") removedCount += 1;
  }

  // Colapsar bloques largos de líneas iguales dejando 3 líneas de contexto
  const CONTEXT = 3;
  const keep = new Array(rawOps.length).fill(false);
  for (let i = 0; i < rawOps.length; i += 1) {
    if (rawOps[i].type !== "eq") {
      const segStart = Math.max(0, i - CONTEXT);
      const segEnd = Math.min(rawOps.length - 1, i + CONTEXT);
      for (let k = segStart; k <= segEnd; k += 1) {
        keep[k] = true;
      }
    }
  }

  const rows = [];
  let skipped = 0;
  for (let i = 0; i < rawOps.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        rows.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      rows.push(rawOps[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    rows.push({ type: "skip", count: skipped });
  }

  return { rows, addedCount, removedCount, lineEndingsOnly };
}

function lcsDiff(a, b, start, endA, endB, midA, midB) {
  const n = midA.length;
  const m = midB.length;

  const ArrType = Math.max(n, m) >= 65535 ? Uint32Array : Uint16Array;
  const dp = Array.from({ length: n + 1 }, () => new ArrType(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (midA[i] === midB[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops = [];
  for (let k = 0; k < start; k += 1) {
    ops.push({ type: "eq", lineNo: k + 1, text: a[k] });
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ type: "eq", lineNo: start + j + 1, text: midB[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", lineNo: start + i + 1, text: midA[i] });
      i += 1;
    } else {
      ops.push({ type: "add", lineNo: start + j + 1, text: midB[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", lineNo: start + i + 1, text: midA[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", lineNo: start + j + 1, text: midB[j] });
    j += 1;
  }

  const tailCount = a.length - 1 - endA;
  for (let k = 0; k < tailCount; k += 1) {
    ops.push({ type: "eq", lineNo: endB + 2 + k, text: a[endA + 1 + k] });
  }

  return ops;
}

function fastLargeDiff(a, b) {
  const ops = [];
  for (let i = 0; i < a.length; i += 1) {
    ops.push({ type: "del", lineNo: i + 1, text: a[i] });
  }
  for (let j = 0; j < b.length; j += 1) {
    ops.push({ type: "add", lineNo: j + 1, text: b[j] });
  }
  return ops;
}
