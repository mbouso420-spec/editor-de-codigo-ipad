/**
 * Respaldo de emergencia para no perder lo último escrito si la página se cierra o recarga
 * antes de que el autoguardado asíncrono en IndexedDB termine (Safari en iPadOS puede matar la pestaña).
 *
 * localStorage es síncrono: lo que se escribe en pagehide/visibilitychange queda guardado aunque
 * el navegador destruya la página en el instante siguiente. Al abrir la app se vuelca a IndexedDB.
 *
 * Soporta particionamiento por proyecto (studio_ide_emergency_backup_${projectId}) para evitar
 * colisiones si el usuario mantiene múltiples pestañas abiertas simultáneamente.
 */
export const EMERGENCY_BACKUP_KEY = "ide.emergencyBackup.v1";
export const EMERGENCY_BACKUP_PREFIX = "studio_ide_emergency_backup_";

/**
 * Obtiene la clave de almacenamiento para un proyecto o la clave por defecto.
 * @param {string|null} [projectId]
 * @returns {string}
 */
export function getEmergencyBackupKey(projectId = null) {
  return projectId ? `${EMERGENCY_BACKUP_PREFIX}${projectId}` : EMERGENCY_BACKUP_KEY;
}

function getAllStorageKeys(storage) {
  if (!storage) return [];
  try {
    if (typeof storage.length === "number") {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k) keys.push(k);
      }
      if (keys.length > 0) return keys;
    }
  } catch (_) {}

  try {
    return Object.keys(storage);
  } catch (_) {
    return [];
  }
}

function parseBackupItems(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter(
      (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
    );
  } catch {
    return [];
  }
}

/**
 * @param {Array<{ projectId: string, filePath: string, content: string }>} items
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @returns {boolean} true si quedó escrito
 */
export function writeEmergencyBackup(items, storage = window.localStorage, projectId = null) {
  const clean = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
  );
  const targetKey = getEmergencyBackupKey(projectId);

  try {
    if (clean.length === 0) {
      storage.removeItem(targetKey);
      return true;
    }
    storage.setItem(
      targetKey,
      JSON.stringify({
        savedAt: Date.now(),
        projectId: projectId || null,
        items: clean.map(({ projectId: p, filePath, content }) => ({ projectId: p, filePath, content }))
      })
    );
    return true;
  } catch {
    // Cuota llena o almacenamiento bloqueado: queda el autoguardado normal como única vía.
    return false;
  }
}

/**
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @returns {Array<{ projectId: string, filePath: string, content: string }>}
 */
export function readEmergencyBackup(storage = window.localStorage, projectId = null) {
  if (projectId) {
    const targetKey = getEmergencyBackupKey(projectId);
    const direct = parseBackupItems(storage.getItem(targetKey));
    if (direct.length > 0) return direct;
    // Si no está particionado aún, buscar si existe en la clave legado
    const legacy = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
    return legacy.filter((it) => it.projectId === projectId);
  }

  // Si no se especifica proyecto, agregar clave legado y todas las particiones existentes
  const result = [];
  const legacyItems = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
  result.push(...legacyItems);

  const keys = getAllStorageKeys(storage);
  for (const k of keys) {
    if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
      const partItems = parseBackupItems(storage.getItem(k));
      result.push(...partItems);
    }
  }

  return result;
}

/**
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 */
export function clearEmergencyBackup(storage = window.localStorage, projectId = null) {
  try {
    if (projectId) {
      storage.removeItem(getEmergencyBackupKey(projectId));
      return;
    }
    storage.removeItem(EMERGENCY_BACKUP_KEY);
    const keys = getAllStorageKeys(storage);
    for (const k of keys) {
      if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
        storage.removeItem(k);
      }
    }
  } catch {
    // Ignorar errores de almacenamiento restringido
  }
}

/**
 * Vuelca a IndexedDB el respaldo pendiente (si existe) y lo borra solo cuando todo quedó guardado.
 * Nunca recrea archivos que ya no existen (p. ej. borrados en otra pestaña).
 * @param {{ entryExists: (projectId: string, path: string) => Promise<boolean>, updateFileContent: (projectId: string, path: string, content: string) => Promise<unknown> }} db
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @returns {Promise<number>} cantidad de archivos recuperados
 */
export async function restoreEmergencyBackup(db, storage = window.localStorage, projectId = null) {
  const items = readEmergencyBackup(storage, projectId);
  if (items.length === 0) {
    clearEmergencyBackup(storage, projectId);
    return 0;
  }
  let restored = 0;
  for (const item of items) {
    if (await db.entryExists(item.projectId, item.filePath)) {
      await db.updateFileContent(item.projectId, item.filePath, item.content);
      restored += 1;
    }
  }
  clearEmergencyBackup(storage, projectId);
  return restored;
}
