import { getKeyStorageMode } from "../ai/providers.js";

const GH_TOKEN_KEY = "ide.github.pat";

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
    if (!trimmed) return;
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_TOKEN_KEY, trimmed);
  } catch {
    // Entorno restringido
  }
}

export function clearGithubToken() {
  saveGithubToken("");
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
        const val = bodyPayload[key];
        delete bodyPayload[key];
        return encodeURIComponent(String(val ?? ""));
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
        throw new Error(`GitHub API: ${detail}`);
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
  return client.request("GET /user/repos", {
    sort: "updated",
    per_page: 80,
    affiliation: "owner,collaborator,organization_member"
  });
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
 * Descarga los archivos de código/texto de un repositorio y rama hacia memoria para hidratar IndexedDB.
 * @param {{
 *   token: string,
 *   owner: string,
 *   repo: string,
 *   branch: string,
 *   onProgress?: (done: number, total: number) => void
 * }} options
 */
export async function downloadRepoFiles({ token, owner, repo, branch, onProgress }) {
  const client = await createGithubClient(token);

  const branchInfo = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
    owner,
    repo,
    branch
  });

  const commitSha = branchInfo?.commit?.sha;
  const treeSha = branchInfo?.commit?.commit?.tree?.sha || commitSha;
  if (!commitSha || !treeSha) {
    throw new Error("No se pudo obtener el árbol de la rama seleccionada.");
  }

  const treeData = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "1"
  });

  const rawTree = Array.isArray(treeData?.tree) ? treeData.tree : [];
  const textBlobs = rawTree.filter((node) => {
    if (node.type !== "blob" || !node.path || !node.sha) return false;
    if (typeof node.size === "number" && node.size > MAX_TEXT_FILE_BYTES) return false;
    if (node.path.startsWith("node_modules/") || node.path.startsWith(".git/")) return false;
    const ext = node.path.includes(".") ? node.path.split(".").pop().toLowerCase() : "";
    return !BINARY_EXTENSIONS.has(ext);
  });

  const files = [];
  let completed = 0;
  const total = textBlobs.length;
  onProgress?.(0, total);

  const CONCURRENCY = 6;
  for (let i = 0; i < textBlobs.length; i += CONCURRENCY) {
    const batch = textBlobs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (blobNode) => {
        const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: blobNode.sha
        });
        completed += 1;
        onProgress?.(completed, total);
        const content = blob.encoding === "base64" ? decodeBase64Utf8(blob.content || "") : String(blob.content || "");
        return {
          path: blobNode.path,
          content
        };
      })
    );
    files.push(...batchResults);
  }

  return {
    commitSha,
    files
  };
}

/**
 * Crea un único Commit + Push atómico en GitHub con todos los archivos creados, editados y eliminados en el iPad.
 * @param {{
 *   token: string,
 *   owner: string,
 *   repo: string,
 *   branch: string,
 *   message: string,
 *   changes: Array<{ path: string, status: "added" | "modified" | "deleted", content: string }>
 * }} params
 */
export async function pushAtomicCommit({ token, owner, repo, branch, message, changes }) {
  if (!changes.length) {
    throw new Error("No hay archivos modificados para enviar en el commit.");
  }

  const client = await createGithubClient(token);

  const branchData = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
    owner,
    repo,
    branch
  });

  const latestCommitSha = branchData?.commit?.sha;
  const baseTreeSha = branchData?.commit?.commit?.tree?.sha;
  if (!latestCommitSha || !baseTreeSha) {
    throw new Error("No se pudo leer el último commit de la rama remota.");
  }

  const treeItems = changes.map((change) => {
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
    message: message.trim(),
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
