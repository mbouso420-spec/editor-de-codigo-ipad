import { rng } from "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const db = await import("../js/storage/workspaceDb.js");
const {
  normalizePath,
  validateUserPath,
  inferFileMeta,
  upsertEntry,
  updateFileContent,
  renameProjectEntry,
  deleteProjectEntry,
  getProjectEntries,
  getAllRawProjectEntries,
  getPendingGithubChanges,
  hydrateLazyGithubProject,
  hydrateGithubProject,
  markProjectSynced,
  cacheSingleGithubFileContent,
  createLocalProject,
  deleteProject,
  ensureInitialWorkspace,
  listProjects,
  makeGithubProjectId
} = db;

let pidSeq = 0;
const freshId = (p = "t") => `${p}-${Date.now().toString(36)}-${(pidSeq += 1)}`;

async function filesMap(projectId) {
  const list = await getProjectEntries(projectId);
  return new Map(list.filter((e) => !e.isFolder).map((e) => [e.path, e.content]));
}

describe("normalizePath (particiones de equivalencia + límites)", () => {
  const cases = [
    ["", ""],
    ["   ", ""],
    [null, ""],
    [undefined, ""],
    ["a", "a"],
    ["/a/b/", "a/b"],
    ["a//b", "a/b"],
    ["\\a\\b", "a/b"],
    ["./a/../b", "b"],
    ["../../x", "x"],
    ["a/./b/.", "a/b"],
    [" a / b ", "a/b"],
    ["ñandú/文件.py", "ñandú/文件.py"],
    ["a/b/../../..", ""]
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizePath(input), expected);
    });
  }

  test("propiedad: idempotente y nunca contiene '..', '.', '//' ni barras en extremos (fuzz 2000)", () => {
    const r = rng(42);
    const alphabet = ["a", "b", "/", "\\", ".", "..", " ", "ñ", "x.y"];
    for (let i = 0; i < 2000; i += 1) {
      let s = "";
      const len = Math.floor(r() * 12);
      for (let k = 0; k < len; k += 1) s += alphabet[Math.floor(r() * alphabet.length)];
      const out = normalizePath(s);
      assert.equal(normalizePath(out), out, `no idempotente para ${JSON.stringify(s)}`);
      assert.ok(!out.startsWith("/") && !out.endsWith("/"), JSON.stringify(s));
      assert.ok(!out.includes("//"), JSON.stringify(s));
      for (const seg of out.split("/").filter(Boolean)) {
        assert.ok(seg !== "." && seg !== "..", `segmento relativo en ${JSON.stringify(out)}`);
      }
    }
  });
});

describe("validateUserPath (validación de entradas)", () => {
  const rejects = ["", "   ", "a//b", "../x", "a/./b", "a/../b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\u0001b", `${"x".repeat(256)}.js`];
  for (const bad of rejects) {
    test(`rechaza ${JSON.stringify(bad.length > 30 ? `${bad.slice(0, 20)}…(${bad.length})` : bad)}`, () => {
      assert.throws(() => validateUserPath(bad));
    });
  }
  const accepts = [
    ["main.py", "main.py"],
    ["src/utils/math.cpp", "src/utils/math.cpp"],
    ["  espacio inicial.txt ", "espacio inicial.txt"],
    ["carpeta con espacios/archivo ñ.md", "carpeta con espacios/archivo ñ.md"],
    ["emoji😀.js", "emoji😀.js"],
    [`${"x".repeat(255)}`, "x".repeat(255)],
    ["/raiz.js", "raiz.js"]
  ];
  for (const [ok, expected] of accepts) {
    test(`acepta ${JSON.stringify(ok.length > 30 ? `${ok.slice(0, 20)}…(${ok.length})` : ok)}`, () => {
      assert.equal(validateUserPath(ok), expected);
    });
  }
});

describe("inferFileMeta (tabla de decisión por extensión)", () => {
  const table = [
    ["a.cpp", "cpp"], ["a.HPP", "cpp"], ["a.c", "c"], ["a.h", "c"], ["a.html", "html"], ["a.htm", "html"],
    ["a.css", "css"], ["a.sql", "sql"], ["a.py", "python"], ["a.pyw", "python"], ["README.md", "markdown"],
    ["a.js", "js"], ["a.mjs", "js"], ["a.tsx", "js"], ["a.json", "json"], ["Makefile", "text"], [".gitignore", "text"],
    ["dir.v2/archivo", "text"], ["", "text"]
  ];
  for (const [p, lang] of table) {
    test(`${JSON.stringify(p)} -> ${lang}`, () => assert.equal(inferFileMeta(p).lang, lang));
  }
  test("extensión desconocida larga genera badge de máx. 4 caracteres", () => {
    assert.equal(inferFileMeta("x.typescript").badge, "TYPE");
  });
});

describe("CRUD de entradas en IndexedDB", () => {
  test("crear archivo anidado crea carpetas padre implícitas", async () => {
    const pid = freshId();
    await upsertEntry(pid, "a/b/c.txt", { content: "hola" });
    const all = await getProjectEntries(pid);
    const paths = all.map((e) => `${e.path}:${e.isFolder ? "D" : "F"}`).sort();
    assert.deepEqual(paths, ["a/b/c.txt:F", "a/b:D", "a:D"]);
  });

  test("no permite crear archivo con el mismo nombre que una carpeta ni dentro de un archivo", async () => {
    const pid = freshId();
    await upsertEntry(pid, "x/y.txt", { content: "1" });
    await assert.rejects(upsertEntry(pid, "x", { content: "" }));
    await assert.rejects(upsertEntry(pid, "x/y.txt/z.txt", { content: "" }));
  });

  test("allowOverwrite=false rechaza duplicados", async () => {
    const pid = freshId();
    await upsertEntry(pid, "a.txt", { content: "1", allowOverwrite: false });
    await assert.rejects(upsertEntry(pid, "a.txt", { content: "2", allowOverwrite: false }), /Ya existe/);
  });

  test("ruta vacía o solo '..' se rechaza", async () => {
    await assert.rejects(upsertEntry(freshId(), "..", { content: "" }));
    await assert.rejects(upsertEntry(freshId(), "", { content: "" }));
  });

  test("contenido Unicode, vacío y grande (1 MB) se conserva íntegro", async () => {
    const pid = freshId();
    const big = "línea ñ 😀 \u0000 \r\n".repeat(65536);
    await upsertEntry(pid, "u.txt", { content: "ñandú 文件 😀" });
    await upsertEntry(pid, "e.txt", { content: "" });
    await upsertEntry(pid, "g.txt", { content: big });
    const m = await filesMap(pid);
    assert.equal(m.get("u.txt"), "ñandú 文件 😀");
    assert.equal(m.get("e.txt"), "");
    assert.equal(m.get("g.txt"), big);
  });

  test("renombrar carpeta mueve hijos y no deja restos", async () => {
    const pid = freshId();
    await upsertEntry(pid, "src/a.js", { content: "A" });
    await upsertEntry(pid, "src/sub/b.js", { content: "B" });
    await renameProjectEntry(pid, "src", "lib", true);
    const m = await filesMap(pid);
    assert.deepEqual([...m.keys()].sort(), ["lib/a.js", "lib/sub/b.js"]);
    assert.equal(m.get("lib/sub/b.js"), "B");
  });

  test("no se puede mover una carpeta dentro de sí misma", async () => {
    const pid = freshId();
    await upsertEntry(pid, "src/a.js", { content: "A" });
    await assert.rejects(renameProjectEntry(pid, "src", "src/inner", true), /dentro de sí misma/);
  });

  test("renombrar sobre un destino existente falla sin perder datos", async () => {
    const pid = freshId();
    await upsertEntry(pid, "a.txt", { content: "A" });
    await upsertEntry(pid, "b.txt", { content: "B" });
    await assert.rejects(renameProjectEntry(pid, "a.txt", "b.txt", false));
    const m = await filesMap(pid);
    assert.equal(m.get("a.txt"), "A");
    assert.equal(m.get("b.txt"), "B");
  });

  test("carpeta con prefijo similar ('src' vs 'src2') no se ve afectada al borrar/renombrar", async () => {
    const pid = freshId();
    await upsertEntry(pid, "src/a.js", { content: "A" });
    await upsertEntry(pid, "src2/b.js", { content: "B" });
    await deleteProjectEntry(pid, "src", true);
    const m = await filesMap(pid);
    assert.deepEqual([...m.keys()], ["src2/b.js"]);
  });

  test("updateFileContent sobre ruta inexistente la crea", async () => {
    const pid = freshId();
    await updateFileContent(pid, "nuevo/x.py", "print(1)");
    const m = await filesMap(pid);
    assert.equal(m.get("nuevo/x.py"), "print(1)");
  });

  test("proyecto local: crear, listar y borrar elimina todos sus archivos", async () => {
    const p = await createLocalProject("Mi Proyecto ñ!");
    assert.match(p.id, /^mi-proyecto-/);
    assert.ok((await getAllRawProjectEntries(p.id)).length > 0);
    await deleteProject(p.id);
    assert.equal((await getAllRawProjectEntries(p.id)).length, 0);
    assert.ok(!(await listProjects()).some((x) => x.id === p.id));
  });

  test("ensureInitialWorkspace es idempotente (no duplica semilla)", async () => {
    const a = await ensureInitialWorkspace();
    const b = await ensureInitialWorkspace();
    assert.equal(a.length > 0, true);
    assert.equal(b.length, (await listProjects()).length);
    const seed = await getProjectEntries("espacio-local");
    const n1 = seed.length;
    await ensureInitialWorkspace();
    assert.equal((await getProjectEntries("espacio-local")).length, n1);
  });
});

describe("Fuzz basado en modelo: secuencias aleatorias de operaciones vs. modelo de referencia", () => {
  test("300 operaciones aleatorias x 5 semillas mantienen la misma vista que un Map de referencia", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const pid = freshId(`fz${seed}`);
      /** @type {Map<string,string>} */
      const model = new Map();
      /** Carpetas existentes (las carpetas vacías persisten, igual que en el Explorador). */
      const folders = new Set();
      const pick = (arr) => arr[Math.floor(r() * arr.length)];
      const names = ["a", "b", "c", "d"];
      const randPath = () => {
        const depth = 1 + Math.floor(r() * 3);
        const parts = [];
        for (let i = 0; i < depth; i += 1) parts.push(pick(names));
        return parts.join("/");
      };
      const addAncestors = (p) => {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
      };
      const isFolderInModel = (p) => folders.has(p);
      const blockedByFileAncestor = (p) => {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i += 1) {
          if (model.has(parts.slice(0, i).join("/"))) return true;
        }
        return false;
      };

      for (let step = 0; step < 300; step += 1) {
        const op = r();
        const p = randPath();
        if (op < 0.45) {
          const content = `c${step}`;
          const shouldFail = isFolderInModel(p) || blockedByFileAncestor(p);
          let failed = false;
          try {
            await upsertEntry(pid, p, { content });
          } catch {
            failed = true;
          }
          assert.equal(failed, shouldFail, `seed ${seed} step ${step} upsert ${p}`);
          if (!failed) {
            model.set(p, content);
            addAncestors(p);
          }
        } else if (op < 0.65) {
          if (model.has(p)) {
            await deleteProjectEntry(pid, p, false);
            model.delete(p);
          } else if (isFolderInModel(p)) {
            await deleteProjectEntry(pid, p, true);
            for (const k of [...model.keys()]) if (k.startsWith(`${p}/`)) model.delete(k);
            for (const f of [...folders]) if (f === p || f.startsWith(`${p}/`)) folders.delete(f);
          }
        } else if (op < 0.8) {
          if (model.has(p)) {
            await updateFileContent(pid, p, `u${step}`);
            model.set(p, `u${step}`);
          }
        } else {
          const to = randPath();
          const isFile = model.has(p);
          const isFolder = !isFile && isFolderInModel(p);
          if (!isFile && !isFolder) continue;
          let failed = false;
          try {
            await renameProjectEntry(pid, p, to, isFolder);
          } catch {
            failed = true;
          }
          if (!failed && p !== to) {
            if (isFile) {
              const c = model.get(p);
              model.delete(p);
              model.set(to, c);
            } else {
              for (const k of [...model.keys()]) {
                if (k.startsWith(`${p}/`)) {
                  const c = model.get(k);
                  model.delete(k);
                  model.set(`${to}${k.slice(p.length)}`, c);
                }
              }
              for (const f of [...folders]) {
                if (f === p || f.startsWith(`${p}/`)) {
                  folders.delete(f);
                  folders.add(`${to}${f.slice(p.length)}`);
                }
              }
            }
            addAncestors(to);
          }
        }
        const actual = await filesMap(pid);
        assert.deepEqual(
          [...actual.entries()].sort(),
          [...model.entries()].sort(),
          `divergencia de archivos seed ${seed} paso ${step}`
        );
        const actualFolders = (await getProjectEntries(pid)).filter((e) => e.isFolder).map((e) => e.path).sort();
        assert.deepEqual(actualFolders, [...folders].sort(), `divergencia de carpetas seed ${seed} paso ${step}`);
      }
    }
  });
});

describe("Cálculo de cambios pendientes frente a GitHub", () => {
  async function ghProject(files) {
    const owner = "o";
    const repo = freshId("r");
    const project = await hydrateGithubProject({
      owner,
      repo,
      branch: "main",
      commitSha: "c0",
      files: files.map(([path, content]) => ({ path, content, blobSha: `sha-${path}` }))
    });
    return project.id;
  }

  test("repositorio recién clonado no tiene cambios", async () => {
    const pid = await ghProject([["a.txt", "A"], ["d/b.txt", "B"]]);
    assert.deepEqual(await getPendingGithubChanges(pid), []);
  });

  test("detecta agregado, modificado y borrado", async () => {
    const pid = await ghProject([["a.txt", "A"], ["b.txt", "B"]]);
    await updateFileContent(pid, "a.txt", "A2");
    await deleteProjectEntry(pid, "b.txt", false);
    await upsertEntry(pid, "c.txt", { content: "C" });
    const ch = await getPendingGithubChanges(pid);
    assert.deepEqual(
      ch.map((c) => `${c.status}:${c.path}`),
      ["modified:a.txt", "deleted:b.txt", "added:c.txt"]
    );
  });

  test("editar y volver al contenido original elimina el cambio", async () => {
    const pid = await ghProject([["a.txt", "A"]]);
    await updateFileContent(pid, "a.txt", "X");
    await updateFileContent(pid, "a.txt", "A");
    assert.deepEqual(await getPendingGithubChanges(pid), []);
  });

  test("renombrar ida y vuelta un archivo trackeado no deja cambios", async () => {
    const pid = await ghProject([["a.txt", "A"]]);
    await renameProjectEntry(pid, "a.txt", "b.txt", false);
    assert.deepEqual(
      (await getPendingGithubChanges(pid)).map((c) => `${c.status}:${c.path}`),
      ["deleted:a.txt", "added:b.txt"]
    );
    await renameProjectEntry(pid, "b.txt", "a.txt", false);
    assert.deepEqual(await getPendingGithubChanges(pid), []);
  });

  test("borrar y recrear un archivo trackeado sin cargar lo marca como modificado (no se pierde)", async () => {
    const project = await hydrateLazyGithubProject({
      owner: "o",
      repo: freshId("lazy"),
      branch: "main",
      commitSha: "c0",
      entries: [{ path: "big.txt", blobSha: "s1" }]
    });
    await deleteProjectEntry(project.id, "big.txt", false);
    await upsertEntry(project.id, "big.txt", { content: "nuevo" });
    const ch = await getPendingGithubChanges(project.id);
    assert.equal(ch.length, 1);
    assert.equal(ch[0].content, "nuevo");
  });

  test("archivos sin descargar (lazy) no aparecen como cambios", async () => {
    const project = await hydrateLazyGithubProject({
      owner: "o",
      repo: freshId("lazy"),
      branch: "main",
      commitSha: "c0",
      entries: [{ path: "x.js", blobSha: "s1" }, { path: "y/z.js", blobSha: "s2" }]
    });
    assert.deepEqual(await getPendingGithubChanges(project.id), []);
    await cacheSingleGithubFileContent(project.id, "x.js", "contenido", "s1");
    assert.deepEqual(await getPendingGithubChanges(project.id), []);
  });

  test("[BUG-19] una descarga en vuelo no pisa un archivo que ya tiene contenido local", async () => {
    const project = await hydrateLazyGithubProject({ owner: "o", repo: freshId("lazy"), branch: "main", commitSha: "c0", entries: [{ path: "x.js", blobSha: "s1" }] });
    // Mientras baja x.js, el usuario lo borra y lo recrea con su propio contenido:
    await deleteProjectEntry(project.id, "x.js", false);
    await upsertEntry(project.id, "x.js", { content: "MIO" });
    await cacheSingleGithubFileContent(project.id, "x.js", "REMOTO", "s1");
    const m = await filesMap(project.id);
    assert.equal(m.get("x.js"), "MIO");
  });

  test("re-hidratar lazy reutiliza archivos descargados con mismo SHA y descarta los cambiados", async () => {
    const repo = freshId("lazy");
    const p = await hydrateLazyGithubProject({ owner: "o", repo, branch: "main", commitSha: "c0", entries: [{ path: "a", blobSha: "s1" }, { path: "b", blobSha: "s2" }] });
    await cacheSingleGithubFileContent(p.id, "a", "AA", "s1");
    await cacheSingleGithubFileContent(p.id, "b", "BB", "s2");
    await hydrateLazyGithubProject({ owner: "o", repo, branch: "main", commitSha: "c1", entries: [{ path: "a", blobSha: "s1" }, { path: "b", blobSha: "s9" }] });
    const raw = await getAllRawProjectEntries(p.id);
    const a = raw.find((e) => e.path === "a");
    const b = raw.find((e) => e.path === "b");
    assert.equal(a.contentLoaded, true);
    assert.equal(a.content, "AA");
    assert.equal(b.contentLoaded, false);
  });

  test("markProjectSynced deja todo al día tras un push sin ediciones concurrentes", async () => {
    const pid = await ghProject([["a.txt", "A"], ["b.txt", "B"]]);
    await updateFileContent(pid, "a.txt", "A2");
    await deleteProjectEntry(pid, "b.txt", false);
    await upsertEntry(pid, "c.txt", { content: "C" });
    const pushed = await getPendingGithubChanges(pid);
    await markProjectSynced(pid, "c1", pushed);
    assert.deepEqual(await getPendingGithubChanges(pid), []);
  });

  test("[BUG-16] ediciones hechas DURANTE el push no deben marcarse como sincronizadas", async () => {
    const pid = await ghProject([["a.txt", "A"]]);
    await updateFileContent(pid, "a.txt", "A2");
    const pushedSnapshot = await getPendingGithubChanges(pid); // lo que viaja en el commit
    // Mientras la red responde, el autoguardado escribe una nueva edición:
    await updateFileContent(pid, "a.txt", "A3");
    await upsertEntry(pid, "nuevo.txt", { content: "N" });
    await markProjectSynced(pid, "c1", pushedSnapshot);
    const ch = await getPendingGithubChanges(pid);
    assert.deepEqual(
      ch.map((c) => `${c.status}:${c.path}:${c.content}:${c.baseContent}`),
      ["modified:a.txt:A3:A2", "added:nuevo.txt:N:"]
    );
  });

  test("[BUG-16] borrado hecho DURANTE el push sigue pendiente", async () => {
    const pid = await ghProject([["a.txt", "A"], ["b.txt", "B"]]);
    await updateFileContent(pid, "a.txt", "A2");
    const pushedSnapshot = await getPendingGithubChanges(pid);
    await deleteProjectEntry(pid, "b.txt", false);
    await markProjectSynced(pid, "c1", pushedSnapshot);
    assert.deepEqual(
      (await getPendingGithubChanges(pid)).map((c) => `${c.status}:${c.path}`),
      ["deleted:b.txt"]
    );
  });

  test("[BUG-16b] archivo NUEVO borrado o renombrado durante su push queda como borrado pendiente", async () => {
    const pid = await ghProject([["a.txt", "A"]]);
    await upsertEntry(pid, "nuevo.txt", { content: "N" });
    await upsertEntry(pid, "otro.txt", { content: "O" });
    const pushedSnapshot = await getPendingGithubChanges(pid);
    await deleteProjectEntry(pid, "nuevo.txt", false);
    await renameProjectEntry(pid, "otro.txt", "renombrado.txt", false);
    await markProjectSynced(pid, "c1", pushedSnapshot);
    assert.deepEqual(
      (await getPendingGithubChanges(pid)).map((c) => `${c.status}:${c.path}`),
      ["deleted:nuevo.txt", "deleted:otro.txt", "added:renombrado.txt"]
    );
  });

  test("[BUG-16] archivo borrado durante el push y recreado queda como alta", async () => {
    const pid = await ghProject([["a.txt", "A"], ["b.txt", "B"]]);
    await deleteProjectEntry(pid, "b.txt", false);
    const pushedSnapshot = await getPendingGithubChanges(pid);
    await upsertEntry(pid, "b.txt", { content: "B nuevo" });
    await markProjectSynced(pid, "c1", pushedSnapshot);
    assert.deepEqual(
      (await getPendingGithubChanges(pid)).map((c) => `${c.status}:${c.path}`),
      ["added:b.txt"]
    );
  });

  test("makeGithubProjectId normaliza caracteres", () => {
    assert.equal(makeGithubProjectId("Own.er", "Re po", "feat/x"), "gh-own-er-re-po-feat-x");
  });
});

describe("Rendimiento (Nivel 6)", () => {
  test("[BUG-17] hidratar un repositorio de 3000 archivos en profundidad tarda < 4 s", async () => {
    const entries = [];
    for (let i = 0; i < 3000; i += 1) {
      entries.push({ path: `pkg${i % 30}/sub${i % 7}/file${i}.js`, blobSha: `sha${i}` });
    }
    const t0 = performance.now();
    const p = await hydrateLazyGithubProject({ owner: "o", repo: freshId("perf"), branch: "main", commitSha: "c", entries });
    const ms = performance.now() - t0;
    const files = (await getProjectEntries(p.id)).filter((e) => !e.isFolder);
    assert.equal(files.length, 3000);
    console.log(`    hydrateLazyGithubProject(3000) = ${ms.toFixed(0)} ms`);
    assert.ok(ms < 4000, `tardó ${ms.toFixed(0)} ms`);
  });
});
