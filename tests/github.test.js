import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const gh = await import("../js/github/githubService.js");

/** Servidor GitHub falso: registra llamadas y responde según rutas. */
function installFakeGithub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, url: String(url), body, headers: init.headers || {} });
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    const [status, json] = handler(body, u);
    return new Response(JSON.stringify(json), { status });
  };
  return calls;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("Cliente REST GitHub (fallback sin Octokit)", () => {
  test("fetchRepoTreeIndex filtra binarios, >350KB, node_modules, .git y nodos no-blob", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "C1", commit: { tree: { sha: "T1" } } } }],
      "GET /repos/o/r/git/trees/T1": () => [200, {
        tree: [
          { type: "blob", path: "a.js", sha: "s1", size: 10 },
          { type: "blob", path: "img.PNG", sha: "s2", size: 10 },
          { type: "blob", path: "big.txt", sha: "s3", size: 400000 },
          { type: "blob", path: "node_modules/x.js", sha: "s4", size: 1 },
          { type: "tree", path: "src", sha: "s5" },
          { type: "commit", path: "submod", sha: "s6" },
          { type: "blob", path: "src/ñ.py", sha: "s7", size: 5 }
        ]
      }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: "t", owner: "o", repo: "r", branch: "main" });
    assert.equal(idx.commitSha, "C1");
    assert.deepEqual(idx.entries.map((e) => e.path), ["a.js", "src/ñ.py"]);
  });

  test("rama con '/' se codifica por segmentos (feature/x)", async () => {
    const calls = installFakeGithub({
      "GET /repos/o/r/branches/feature/x": () => [200, { commit: { sha: "C", commit: { tree: { sha: "T" } } } }],
      "GET /repos/o/r/git/trees/T": () => [200, { tree: [] }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: "t", owner: "o", repo: "r", branch: "feature/x" });
    assert.equal(idx.isEmptyRepo, false);
    assert.ok(calls[0].url.endsWith("/branches/feature/x"));
  });

  test("repositorio vacío se detecta (409) y devuelve rama por defecto", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [409, { message: "Git Repository is empty." }],
      "GET /repos/o/r": () => [200, { default_branch: "trunk" }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: "t", owner: "o", repo: "r", branch: "main" });
    assert.equal(idx.isEmptyRepo, true);
    assert.equal(idx.branch, "trunk");
  });

  test("error 401 se propaga con mensaje de GitHub", async () => {
    installFakeGithub({ "GET /repos/o/r/branches/main": () => [401, { message: "Bad credentials" }] });
    await assert.rejects(gh.fetchRepoTreeIndex({ token: "x", owner: "o", repo: "r", branch: "main" }), /Bad credentials/);
  });

  test("fetchSingleRepoBlob decodifica base64 UTF-8 con saltos de línea (ñ, emoji, CJK)", async () => {
    const text = "hola ñandú 😀 文件\nlínea 2\n";
    const encoded = b64(text).replace(/(.{10})/g, "$1\n");
    installFakeGithub({ "GET /repos/o/r/git/blobs/abc": () => [200, { encoding: "base64", content: encoded }] });
    assert.equal(await gh.fetchSingleRepoBlob({ token: "t", owner: "o", repo: "r", blobSha: "abc" }), text);
  });

  test("downloadBatchBlobs descarga N>concurrencia y reporta progreso monotónico hasta total", async () => {
    installFakeGithub({});
    globalThis.fetch = async (url) => {
      const sha = String(url).split("/").pop();
      return new Response(JSON.stringify({ encoding: "base64", content: b64(`c-${sha}`) }), { status: 200 });
    };
    const items = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, blobSha: `s${i}` }));
    const progress = [];
    const res = await gh.downloadBatchBlobs({ token: "t", owner: "o", repo: "r", items, onProgress: (d, t) => progress.push([d, t]) });
    assert.equal(res.length, 15);
    assert.equal(res[7].content, "c-s7");
    assert.deepEqual(progress.at(-1), [15, 15]);
    for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i][0] >= progress[i - 1][0]);
  });
});

describe("pushAtomicCommit", () => {
  let routes;
  beforeEach(() => {
    routes = {
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "BASE", commit: { tree: { sha: "TREE0" } } } }],
      "POST /repos/o/r/git/trees": () => [201, { sha: "TREE1" }],
      "POST /repos/o/r/git/commits": () => [201, { sha: "NEWC" }],
      "PATCH /repos/o/r/git/refs/heads/main": () => [200, { object: { sha: "NEWC" } }]
    };
  });

  test("commit atómico: árbol con alta, modificación y borrado (sha:null)", async () => {
    const calls = installFakeGithub(routes);
    const res = await gh.pushAtomicCommit({
      token: "t", owner: "o", repo: "r", branch: "main", message: "  msg  ",
      expectedBaseSha: "BASE",
      changes: [
        { path: "a.txt", status: "added", content: "A" },
        { path: "b.txt", status: "modified", content: "B2" },
        { path: "c.txt", status: "deleted", content: "" }
      ]
    });
    assert.equal(res.commitSha, "NEWC");
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.equal(tree.base_tree, "TREE0");
    assert.deepEqual(tree.tree.map((t) => [t.path, t.sha === null ? "DEL" : t.content]), [["a.txt", "A"], ["b.txt", "B2"], ["c.txt", "DEL"]]);
    const commit = calls.find((c) => c.key === "POST /repos/o/r/git/commits").body;
    assert.equal(commit.message, "msg");
    assert.deepEqual(commit.parents, ["BASE"]);
    assert.equal(calls.at(-1).body.sha, "NEWC");
  });

  test("rama remota avanzada -> RemoteAheadError y no se escribe nada", async () => {
    const calls = installFakeGithub(routes);
    await assert.rejects(
      gh.pushAtomicCommit({ token: "t", owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "VIEJO", changes: [{ path: "a", status: "modified", content: "x" }] }),
      (e) => e instanceof gh.RemoteAheadError && e.remoteSha === "BASE" && e.expectedSha === "VIEJO"
    );
    assert.ok(!calls.some((c) => c.key.startsWith("POST") || c.key.startsWith("PATCH")));
  });

  test("force=true ignora la divergencia", async () => {
    installFakeGithub(routes);
    const r = await gh.pushAtomicCommit({ token: "t", owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "VIEJO", force: true, changes: [{ path: "a", status: "modified", content: "x" }] });
    assert.equal(r.commitSha, "NEWC");
  });

  test("sin cambios -> error claro", async () => {
    await assert.rejects(gh.pushAtomicCommit({ token: "t", owner: "o", repo: "r", branch: "main", message: "m", changes: [] }), /No hay archivos/);
  });

  test("repositorio vacío: primer archivo vía Contents API (UTF-8) y resto en árbol", async () => {
    let branchCalls = 0;
    routes["GET /repos/o/r/branches/main"] = () => {
      branchCalls += 1;
      return branchCalls === 1 ? [404, { message: "Branch not found" }] : [200, { commit: { sha: "INIT", commit: { tree: { sha: "T0" } } } }];
    };
    routes["PUT /repos/o/r/contents/src%2Fa.py"] = () => [201, { commit: { sha: "INIT" } }];
    routes["PUT /repos/o/r/contents/src/a.py"] = () => [201, { commit: { sha: "INIT" } }];
    const calls = installFakeGithub(routes);
    const r = await gh.pushAtomicCommit({
      token: "t", owner: "o", repo: "r", branch: "main", message: "init",
      changes: [{ path: "src/a.py", status: "added", content: "print('ñ')" }, { path: "b.md", status: "added", content: "# B" }]
    });
    assert.equal(r.commitSha, "NEWC");
    const put = calls.find((c) => c.key.startsWith("PUT"));
    assert.equal(Buffer.from(put.body.content, "base64").toString("utf8"), "print('ñ')");
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.deepEqual(tree.tree.map((t) => t.path), ["b.md"]);
  });

  test("[BUG-20] modo de archivo ejecutable (100755) se preserva al modificar", async () => {
    const calls = installFakeGithub(routes);
    await gh.pushAtomicCommit({
      token: "t", owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "BASE",
      changes: [{ path: "run.sh", status: "modified", content: "#!/bin/sh\necho 2\n", mode: "100755" }]
    });
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.equal(tree.tree[0].mode, "100755");
  });

  test("[BUG-20] fetchRepoTreeIndex conserva el modo y excluye symlinks (120000)", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "C1", commit: { tree: { sha: "T1" } } } }],
      "GET /repos/o/r/git/trees/T1": () => [200, {
        tree: [
          { type: "blob", path: "run.sh", sha: "s1", size: 10, mode: "100755" },
          { type: "blob", path: "link", sha: "s2", size: 5, mode: "120000" },
          { type: "blob", path: "a.txt", sha: "s3", size: 5, mode: "100644" }
        ]
      }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: "t", owner: "o", repo: "r", branch: "main" });
    assert.deepEqual(idx.entries.map((e) => `${e.path}:${e.mode}`), ["run.sh:100755", "a.txt:100644"]);
  });
});

describe("Token de GitHub en almacenamiento", () => {
  test("guardar respeta el modo de almacenamiento y limpiar borra token y caché de repos", () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("ide.ai.storageMode", "session");
    gh.saveGithubToken("  ghp_abc  ");
    assert.equal(sessionStorage.getItem("ide.github.pat"), "ghp_abc");
    assert.equal(localStorage.getItem("ide.github.pat"), null);
    sessionStorage.setItem("ide.github.reposCache", "[]");
    gh.clearGithubToken();
    assert.equal(gh.getGithubToken(), "");
    assert.equal(sessionStorage.getItem("ide.github.reposCache"), null);
    localStorage.clear();
  });
  test("caché de repos corrupta no rompe", () => {
    localStorage.setItem("ide.github.reposCache", "{no json");
    assert.deepEqual(gh.getCachedUserRepositories(), []);
    localStorage.clear();
  });
});
