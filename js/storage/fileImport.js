/**
 * Decide si un archivo elegido para importar es texto editable o un recurso binario soportado.
 * Los binarios no soportados (ZIP, ejecutables, audio masivo…) se rechazan para evitar corrupciones.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "psd",
  "pdf", "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "o", "a", "obj", "bin", "wasm", "class", "jar", "pyc",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "sqlite", "db"
]);

export const SUPPORTED_BINARY_ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "pdf", "ico", "svg"
]);

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const SNIFF_BYTES = 8000;

export function uint8ArrayToBase64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 8192;
  const len = bytes.length;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const btoaFn = typeof btoa === "function" ? btoa : (globalThis.btoa || (typeof window !== "undefined" ? window.btoa : null));
  return btoaFn(binary);
}

/**
 * Convierte una cadena codificada en Base64 a su representación cruda en Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  if (!base64 || typeof base64 !== "string") return new Uint8Array(0);
  const clean = base64.replace(/\s+/g, "");
  const atobFn = typeof atob === "function" ? atob : (globalThis.atob || (typeof window !== "undefined" ? window.atob : null));
  if (!atobFn) {
    const nodeBuf = typeof globalThis !== "undefined" ? globalThis.Buffer : null;
    if (nodeBuf && typeof nodeBuf.from === "function") {
      return new Uint8Array(nodeBuf.from(clean, "base64"));
    }
    return new Uint8Array(0);
  }
  const binary = atobFn(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ allowBinaryAssets?: boolean }} [options]
 * @returns {{ ok: true, text?: string, isBinary?: boolean, base64?: string } | { ok: false, reason: string }}
 */
export function decodeImportedFile(bytes, fileName, options = {}) {
  if (bytes && bytes.length > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, reason: "supera el límite de 5 MB por archivo" };
  }
  const base = String(fileName || "").split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";

  if (options.allowBinaryAssets && SUPPORTED_BINARY_ASSET_EXTENSIONS.has(ext)) {
    return {
      ok: true,
      isBinary: true,
      base64: uint8ArrayToBase64(bytes),
      fileName: base
    };
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "es un archivo binario: imagen, documento o comprimido" };
  }

  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) {
      return { ok: false, reason: "parece un archivo binario" };
    }
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "no es texto UTF-8" };
  }
}
