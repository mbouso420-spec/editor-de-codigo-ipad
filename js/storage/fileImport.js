/**
 * Decide si un archivo elegido para importar es texto editable.
 * Los binarios (imágenes, PDFs, ZIP…) convertidos a texto quedarían corruptos y, si se publicaran
 * con un commit, dañarían el original en GitHub; por eso se rechazan con un motivo claro.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "psd",
  "pdf", "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "o", "a", "obj", "bin", "wasm", "class", "jar", "pyc",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "sqlite", "db"
]);

const SNIFF_BYTES = 8000;

/**
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function decodeImportedFile(bytes, fileName) {
  const base = String(fileName || "").split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
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
