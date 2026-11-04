/**
 * Protección contra bucles infinitos en la vista previa de JS/HTML.
 *
 * Safari en iPadOS ejecuta el iframe de la vista previa en el mismo hilo que el IDE: un `while (true) {}`
 * congelaría toda la app. Para evitarlo se inserta una llamada a `__studioLoopGuard(línea)` al comienzo del
 * cuerpo de cada bucle. El guardián mide cuánto tiempo seguido estuvo bloqueada la página (sin que el
 * navegador pudiera atender otras tareas) y, si supera el límite, corta la ejecución con un error claro.
 */
export const LOOP_GUARD_LIMIT_MS = 2500;

const LOOP_TYPES = new Set([
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement"
]);

/**
 * Inserta el guardián en cada bucle del código. Si el código no se puede analizar, se devuelve intacto
 * (el navegador mostrará su propio error de sintaxis).
 * @param {string} code
 * @param {{ parse: Function }} acorn módulo acorn (se inyecta para poder probarlo en Node)
 * @param {{ module?: boolean }} [options]
 * @returns {{ code: string, loops: number, instrumented: boolean }}
 */
export function instrumentLoops(code, acorn, { module = false } = {}) {
  const source = String(code ?? "");
  if (!acorn || typeof acorn.parse !== "function" || !/\b(for|while|do)\b/.test(source)) {
    return { code: source, loops: 0, instrumented: false };
  }

  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: module ? "module" : "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      locations: true
    });
  } catch {
    return { code: source, loops: 0, instrumented: false };
  }

  /** @type {Array<{ pos: number, text: string }>} */
  const edits = [];
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (LOOP_TYPES.has(node.type) && node.body) {
      const line = node.loc?.start?.line ?? 0;
      const call = `__studioLoopGuard(${line});`;
      if (node.body.type === "BlockStatement") {
        edits.push({ pos: node.body.start + 1, text: call });
      } else {
        edits.push({ pos: node.body.start, text: `{${call}` });
        edits.push({ pos: node.body.end, text: "}" });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  };
  visit(ast);

  if (edits.length === 0) {
    return { code: source, loops: 0, instrumented: false };
  }

  // Aplicar de atrás hacia adelante para no desplazar posiciones pendientes
  edits.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos);
  }
  const loops = edits.filter((e) => e.text.startsWith("__studioLoopGuard") || e.text.startsWith("{__studioLoopGuard")).length;
  return { code: out, loops, instrumented: true };
}

/**
 * Código del guardián que se inyecta en la página de la vista previa (antes de cualquier script del usuario).
 * Mide el tiempo bloqueado con un temporizador que solo corre cuando la página está libre.
 */
export function buildLoopGuardRuntime(limitMs = LOOP_GUARD_LIMIT_MS) {
  return `(function () {
  var lastFree = Date.now();
  setInterval(function () { lastFree = Date.now(); }, 100);
  // El tiempo con un alert/confirm/prompt abierto no cuenta como bloqueo
  ["alert", "confirm", "prompt"].forEach(function (name) {
    var original = window[name];
    if (typeof original !== "function") return;
    window[name] = function () {
      try { return original.apply(window, arguments); } finally { lastFree = Date.now(); }
    };
  });
  window.__studioLoopGuard = function (line) {
    if (Date.now() - lastFree > ${Number(limitMs) || 2500}) {
      throw new Error("Bucle detenido en la línea " + line + ": la página quedó bloqueada más de ${((Number(limitMs) || 2500) / 1000).toLocaleString("es-AR")} s (posible bucle infinito). Se cortó para que el iPad no se congele.");
    }
  };
})();`;
}
