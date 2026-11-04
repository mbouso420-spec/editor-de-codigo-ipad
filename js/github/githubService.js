import { getKeyStorageMode } from "../ai/providers.js";

const GH_TOKEN_KEY = "ide.github.pat";
const GH_REPOS_CACHE_KEY = "ide.github.reposCache";

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp",
  "pdf", "zip", "tar", "gz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "ogg", "mp4", "webm", "mov",
  "exe", "dll", "so", "dylib", "o", "a", "obj", "bin", "wasm"
]);

const MAX_TEXT_FILE_BYTES = 350000;

export function getGithubToken() {
  try {
    return window.sessionStorage.getItem(GH_TOKEN_KEY) || window.localStorage.getItem(GH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveGithubToken(token) {
  const trimmed = token.trim();
  try {
    window.localStorage.removeItem(GH_TOKEN_KEY);
    window.sessionStorage.removeItem(GH_TOKEN_KEY);
    if (!trimmed) {
      window.localStorage.removeItem(GH_REPOS_CACHE_KEY);
      window.sessionStorage.removeItem(GH_REPOS_CACHE_KEY);
      return;
    }
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_TOKEN_KEY, trimmed);
  } catch {
    // Entorno restringido
  }
}

export function clearGithubToken() {
  saveGithubToken("");
}

export function getCachedUserRepositories() {
  try {
    const raw =
      window.sessionStorage.getItem(GH_REPOS_CACHE_KEY) ||
      window.localStorage.getItem(GH_REPOS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCachedUserRepositories(repos) {
  try {
    const slim = repos.map((r) => ({
      full_name: r.full_name,
      default_branch: r.default_branch || "main",
      private: Boolean(r.private)
    }));
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_REPOS_CACHE_KEY, JSON.stringify(slim));
  } catch {
    // Ignorar cuota de almacenamiento
  }
}

/**
 * Crea un cliente ligero sobre Octokit (@octokit/core vía ESM) con respaldo directo a GitHub REST API v3.
 * @param {string} token
 */
async function createGithubClient(token) {
  try {
    const mod = await import("@octokit/core");
    if (mod && typeof mod.Octokit === "function") {
      const octokit = new mod.Octokit({ auth: token || undefined });
      return {
        async request(route, params = {}) {
          const res = await octokit.request(route, params);
          return res.data;
        }
      };
    }
  } catch {
    // Si falla la carga desde CDN, usar cliente REST directo compatible con las mismas rutas
  }

  return {
    async request(route, params = {}) {
      const [method, rawPath] = route.split(" ");
      let path = rawPath;
      const bodyPayload = { ...params };

      path = path.replace(/\{([^}]+)\}/g, (_, key) => {
        const val = String(bodyPayload[key] ?? "");
        delete bodyPayload[key];
        if (key === "ref" || key === "branch") {
          return val.split("/").map(encodeURIComponent).join("/");
        }
        return encodeURIComponent(val);
      });

      let url = `https://api.github.com${path}`;
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const init = { method, headers };
      if (method === "GET") {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(bodyPayload)) {
          if (v !== undefined && v !== null) {
            qs.set(k, String(v));
          }
        }
        const queryStr = qs.toString();
        if (queryStr) {
          url += `?${queryStr}`;
        }
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(bodyPayload);
      }

      const res = await fetch(url, init);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.message) detail = errJson.message;
        } catch {
          // Ignorar
        }
        const err = new Error(`GitHub API: ${detail}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  };
}

export async function fetchGithubUser(token) {
  const client = await createGithubClient(token);
  return client.request("GET /user");
}

export async function fetchUserRepositories(token) {
  const client = await createGithubClient(token);
  const repos = await client.request("GET /user/repos", {
    sort: "updated",
    per_page: 80,
    affiliation: "owner,collaborator,organization_member"
  });
  if (Array.isArray(repos)) {
    saveCachedUserRepositories(repos);
  }
  return repos;
}

export async function fetchRepositoryBranches(token, owner, repo) {
  const client = await createGithubClient(token);
  return client.request("GET /repos/{owner}/{repo}/branches", {
    owner,
    repo,
    per_page: 100
  });
}

/**
 * Obtiene únicamente el índice liviano de carpetas y archivos del repositorio (sin descargar contenidos),
 * permitiendo mostrar cualquier repositorio en el Explorador en ~250ms bajo demanda.
 */
export async function fetchRepoTreeIndex({ token, owner, repo, branch }) {
  const client = await createGithubClient(token);

  let branchInfo = null;
  try {
    branchInfo = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    const st = err?.status;
    if (st === 404 || st === 409 || msg.includes("not found") || msg.includes("empty")) {
      // Verificar si el repositorio existe pero aún no tiene commits (vacío)
      const repoInfo = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
      if (repoInfo) {
        return {
          commitSha: null,
          isEmptyRepo: true,
          branch: repoInfo.default_branch || branch || "main",
          entries: []
        };
      }
    }
    throw err;
  }

  const commitSha = branchInfo?.commit?.sha;
  const treeSha = branchInfo?.commit?.commit?.tree?.sha || commitSha;
  if (!commitSha || !treeSha) {
    return { commitSha: null, isEmptyRepo: true, branch, entries: [] };
  }

  let treeData;
  try {
    treeData = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "1"
    });
  } catch (err) {
    if (err?.status === 409 || String(err?.message || "").toLowerCase().includes("empty")) {
      return { commitSha: null, isEmptyRepo: true, branch, entries: [] };
    }
    throw err;
  }

  const rawTree = Array.isArray(treeData?.tree) ? treeData.tree : [];
  const entries = rawTree
    .filter((node) => {
      if (node.type !== "blob" || !node.path || !node.sha) return false;
      if (typeof node.size === "number" && node.size > MAX_TEXT_FILE_BYTES) return false;
      if (node.path.startsWith("node_modules/") || node.path.startsWith(".git/")) return false;
      const ext = node.path.includes(".") ? node.path.split(".").pop().toLowerCase() : "";
      return !BINARY_EXTENSIONS.has(ext);
    })
    .map((node) => ({
      path: node.path,
      blobSha: node.sha,
      size: node.size || 0
    }));

  return {
    commitSha,
    isEmptyRepo: false,
    branch,
    entries
  };
}

/**
 * Descarga el contenido de un único archivo puntual desde GitHub bajo demanda (~120ms).
 */
export async function fetchSingleRepoBlob({ token, owner, repo, blobSha }) {
  const client = await createGithubClient(token);
  const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner,
    repo,
    file_sha: blobSha
  });
  return blob.encoding === "base64" ? decodeBase64Utf8(blob.content || "") : String(blob.content || "");
}

/**
 * Descarga en lote una lista de archivos pendientes para dejar el repositorio disponible sin internet.
 */
export async function downloadBatchBlobs({ token, owner, repo, items, onProgress }) {
  const client = await createGithubClient(token);
  const results = [];
  let completed = 0;
  const total = items.length;
  onProgress?.(0, total);

  const CONCURRENCY = 6;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: item.blobSha
        });
        completed += 1;
        onProgress?.(completed, total);
        const content =
          blob.encoding === "base64" ? decodeBase64Utf8(blob.content || "") : String(blob.content || "");
        return {
          path: item.path,
          blobSha: item.blobSha,
          content
        };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * Descarga completa de un repositorio y rama hacia memoria para hidratar IndexedDB (modo offline completo).
 */
export async function downloadRepoFiles({ token, owner, repo, branch, onProgress }) {
  const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
  if (index.isEmptyRepo || index.entries.length === 0) {
    onProgress?.(0, 0);
    return {
      commitSha: index.commitSha,
      files: []
    };
  }

  const files = await downloadBatchBlobs({
    token,
    owner,
    repo,
    items: index.entries,
    onProgress
  });

  return {
    commitSha: index.commitSha,
    files
  };
}

/**
 * Error lanzado cuando la rama remota avanzó desde la última descarga/sincronización local.
 */
export class RemoteAheadError extends Error {
  constructor(remoteSha, expectedSha) {
    super("El repositorio en GitHub tiene commits nuevos que todavía no descargaste.");
    this.name = "RemoteAheadError";
    this.remoteSha = remoteSha;
    this.expectedSha = expectedSha;
  }
}

/**
 * Lista los archivos que cambiaron en GitHub entre dos commits (compare API).
 * @returns {Promise<Array<{ path: string, status: string, blobSha: string | null }>>}
 */
export async function compareRemoteCommits({ token, owner, repo, base, head }) {
  const client = await createGithubClient(token);
  const data = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${base}...${head}`
  });
  const files = Array.isArray(data?.files) ? data.files : [];
  return files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename || null,
    status: f.status,
    blobSha: f.status === "removed" ? null : f.sha || null
  }));
}

/**
 * Crea un único Commit + Push atómico en GitHub (soporta incluso repositorios recién creados sin commits previos).
 * Si se indica expectedBaseSha y la rama remota avanzó, lanza RemoteAheadError salvo que force sea true.
 */
export async function pushAtomicCommit({
  token,
  owner,
  repo,
  branch,
  message,
  changes,
  expectedBaseSha = null,
  force = false
}) {
  if (!changes.length) {
    throw new Error("No hay archivos modificados para enviar en el commit.");
  }

  const client = await createGithubClient(token);
  const cleanMsg = message.trim() || "Actualización desde Studio IDE";

  let latestCommitSha = null;
  let baseTreeSha = null;
  let remainingChanges = [...changes];

  try {
    const branchData = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
    latestCommitSha = branchData?.commit?.sha || null;
    baseTreeSha = branchData?.commit?.commit?.tree?.sha || null;
  } catch (err) {
    const st = err?.status;
    const msg = String(err?.message || "").toLowerCase();
    if (st === 404 || st === 409 || msg.includes("not found") || msg.includes("empty")) {
      if (expectedBaseSha && !force) {
        throw new Error(
          `La rama ${branch} ya no existe en GitHub o fue reiniciada. Tocá Actualizar remoto antes de subir.`
        );
      }
      // Repositorio vacío: inicializar rama con el primer archivo nuevo vía Contents API
      const firstAddedIdx = remainingChanges.findIndex((c) => c.status !== "deleted");
      if (firstAddedIdx === -1) {
        throw new Error("El repositorio remoto está vacío; creá al menos un archivo para inicializarlo.");
      }
      const firstFile = remainingChanges[firstAddedIdx];
      const initRes = await client.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: firstFile.path,
        message: cleanMsg,
        content: encodeUtf8Base64(firstFile.content),
        branch
      });
      latestCommitSha = initRes?.commit?.sha || null;
      remainingChanges.splice(firstAddedIdx, 1);

      if (remainingChanges.length === 0 && latestCommitSha) {
        return { commitSha: latestCommitSha };
      }

      const branchDataAfter = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        owner,
        repo,
        branch
      });
      latestCommitSha = branchDataAfter?.commit?.sha || null;
      baseTreeSha = branchDataAfter?.commit?.commit?.tree?.sha || null;
    } else {
      throw err;
    }
  }

  if (!latestCommitSha || !baseTreeSha) {
    throw new Error("No se pudo leer el último commit de la rama remota.");
  }

  if (!force && expectedBaseSha && latestCommitSha !== expectedBaseSha) {
    throw new RemoteAheadError(latestCommitSha, expectedBaseSha);
  }

  const treeItems = remainingChanges.map((change) => {
    if (change.status === "deleted") {
      return {
        path: change.path,
        mode: "100644",
        type: "blob",
        sha: null
      };
    }
    return {
      path: change.path,
      mode: "100644",
      type: "blob",
      content: change.content
    };
  });

  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems
  });

  const createdCommit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: cleanMsg,
    tree: createdTree.sha,
    parents: [latestCommitSha]
  });

  await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: createdCommit.sha
  });

  return {
    commitSha: createdCommit.sha
  };
}

function decodeBase64Utf8(base64) {
  const clean = base64.replace(/\s+/g, "");
  const binary = window.atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
