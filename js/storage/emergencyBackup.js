/**
 * Respaldo de emergencia para no perder lo último escrito si la página se cierra o recarga
 * antes de que el autoguardado asíncrono en IndexedDB termine (Safari en iPadOS puede matar la pestaña).
 *
 * localStorage es síncrono: lo que se escribe en pagehide/visibilitychange queda guardado aunque
 * el navegador destruya la página en el instante siguiente. Al abrir la app se vuelca a IndexedDB.
 */
export const EMERGENCY_BACKUP_KEY = "ide.emergencyBackup.v1";

/**
 * @param {Array<{ projectId: string, filePath: string, content: string }>} items
 * @param {Storage} [storage]
 * @returns {boolean} true si quedó escrito
 */
export function writeEmergencyBackup(items, storage = window.localStorage) {
  const clean = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
  );
  try {
    if (clean.length === 0) {
      storage.removeItem(EMERGENCY_BACKUP_KEY);
      return true;
    }
    storage.setItem(
      EMERGENCY_BACKUP_KEY,
      JSON.stringify({ savedAt: Date.now(), items: clean.map(({ projectId, filePath, content }) => ({ projectId, filePath, content })) })
    );
    return true;
  } catch {
    // Cuota llena o almacenamiento bloqueado: queda el autoguardado normal como única vía.
    return false;
  }
}

/**
 * @param {Storage} [storage]
 * @returns {Array<{ projectId: string, filePath: string, content: string }>}
 */
export function readEmergencyBackup(storage = window.localStorage) {
  try {
    const raw = storage.getItem(EMERGENCY_BACKUP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter(
      (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
    );
  } catch {
    return [];
  }
}

export function clearEmergencyBackup(storage = window.localStorage) {
  try {
    storage.removeItem(EMERGENCY_BACKUP_KEY);
  } catch {
    // Ignorar
  }
}

/**
 * Vuelca a IndexedDB el respaldo pendiente (si existe) y lo borra solo cuando todo quedó guardado.
 * Nunca recrea archivos que ya no existen (p. ej. borrados en otra pestaña).
 * @param {{ entryExists: (projectId: string, path: string) => Promise<boolean>, updateFileContent: (projectId: string, path: string, content: string) => Promise<unknown> }} db
 * @param {Storage} [storage]
 * @returns {Promise<number>} cantidad de archivos recuperados
 */
export async function restoreEmergencyBackup(db, storage = window.localStorage) {
  const items = readEmergencyBackup(storage);
  if (items.length === 0) {
    clearEmergencyBackup(storage);
    return 0;
  }
  let restored = 0;
  for (const item of items) {
    if (await db.entryExists(item.projectId, item.filePath)) {
      await db.updateFileContent(item.projectId, item.filePath, item.content);
      restored += 1;
    }
  }
  clearEmergencyBackup(storage);
  return restored;
}
