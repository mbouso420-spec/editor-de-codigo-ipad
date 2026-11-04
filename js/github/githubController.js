import { icon } from "../ui/icons.js";
import {
  clearGithubToken,
  downloadRepoFiles,
  fetchGithubUser,
  fetchRepositoryBranches,
  fetchUserRepositories,
  getGithubToken,
  pushAtomicCommit,
  saveGithubToken
} from "./githubService.js";
import {
  getPendingGithubChanges,
  hydrateGithubProject,
  markProjectSynced
} from "../storage/workspaceDb.js";

/**
 * Controlador del flujo de conexión con GitHub (PAT local + Octokit),
 * descarga completa de repositorios a IndexedDB para edición offline en iPad,
 * previsualización de Diff por archivo y Commit + Push atómico.
 */
export function initGithubController({
  getActiveProject,
  onFlushPendingSaves,
  onProjectClonedOrSynced,
  onOpenDiff
}) {
  const openDialogBtn = document.getElementById("btn-open-github");
  const topbarRepoLabel = document.getElementById("topbar-repo-label");
  const dialog = document.getElementById("github-dialog");
  const closeDialogBtn = document.getElementById("btn-close-github");

  const tokenInput = document.getElementById("gh-token-input");
  const connectBtn = document.getElementById("btn-gh-connect");
  const clearTokenBtn = document.getElementById("btn-gh-clear-token");
  const userStatusEl = document.getElementById("gh-user-status");
  const authMsgEl = document.getElementById("gh-auth-msg");

  const repoSelect = document.getElementById("gh-repo-select");
  const manualRepoInput = document.getElementById("gh-manual-repo");
  const branchSelect = document.getElementById("gh-branch-select");
  const cloneBtn = document.getElementById("btn-gh-clone");
  const cloneStatusEl = document.getElementById("gh-clone-status");

  const syncSection = document.getElementById("gh-sync-section");
  const syncRepoTitle = document.getElementById("gh-sync-repo-title");
  const pullBtn = document.getElementById("btn-gh-pull");
  const changesListEl = document.getElementById("gh-changes-list");
  const commitMsgInput = document.getElementById("gh-commit-msg");
  const pushBtn = document.getElementById("btn-gh-push");
  const pushStatusEl = document.getElementById("gh-push-status");

  let reposCache = [];
  let pendingPullConfirm = false;
  let pullConfirmTimer = 0;

  function resetPullConfirm() {
    pendingPullConfirm = false;
    window.clearTimeout(pullConfirmTimer);
    if (pullBtn) {
      pullBtn.className = "btn btn-ghost btn-sm";
      pullBtn.innerHTML = `${icon("refreshCw")}<span>Actualizar remoto</span>`;
    }
  }

  openDialogBtn?.addEventListener("click", async () => {
    if (!dialog) return;
    resetPullConfirm();
    await onFlushPendingSaves?.();
    const storedToken = getGithubToken();
    if (tokenInput) {
      tokenInput.value = storedToken;
    }
    await refreshSyncPanel();
    dialog.showModal();
    if (storedToken && reposCache.length === 0) {
      await connectAndLoadRepos(storedToken);
    }
  });

  closeDialogBtn?.addEventListener("click", () => {
    resetPullConfirm();
    dialog?.close();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      resetPullConfirm();
      dialog.close();
    }
  });

  connectBtn?.addEventListener("click", async () => {
    const token = (tokenInput?.value || "").trim();
    if (!token) {
      setStatus(authMsgEl, "Pegá un Personal Access Token (PAT) de GitHub.", "error");
      return;
    }
    saveGithubToken(token);
    await connectAndLoadRepos(token);
  });

  clearTokenBtn?.addEventListener("click", () => {
    clearGithubToken();
    reposCache = [];
    if (tokenInput) tokenInput.value = "";
    if (userStatusEl) userStatusEl.textContent = "Sin sesión";
    if (repoSelect) repoSelect.innerHTML = '<option value="">Conectá tu token para listar repositorios</option>';
    setStatus(authMsgEl, "Token eliminado de este navegador.", "neutral");
  });

  repoSelect?.addEventListener("change", async () => {
    const fullName = repoSelect.value;
    if (manualRepoInput && fullName) {
      manualRepoInput.value = fullName;
    }
    if (fullName) {
      await loadBranchesForRepo(fullName);
    }
  });

  manualRepoInput?.addEventListener("change", async () => {
    const fullName = manualRepoInput.value.trim();
    if (fullName.includes("/")) {
      await loadBranchesForRepo(fullName);
    }
  });

  cloneBtn?.addEventListener("click", async () => {
    await onFlushPendingSaves?.();
    const token = getGithubToken();
    const targetFullName = (manualRepoInput?.value || repoSelect?.value || "").trim();
    const [owner, repo] = targetFullName.split("/");
    const branch = (branchSelect?.value || "main").trim();

    if (!owner || !repo) {
      setStatus(cloneStatusEl, "Elegí un repositorio o escribí usuario/repositorio.", "error");
      return;
    }

    cloneBtn.disabled = true;
    setStatus(cloneStatusEl, `Conectando con ${owner}/${repo} (${branch})…`, "neutral");

    try {
      const { commitSha, files } = await downloadRepoFiles({
        token,
        owner,
        repo,
        branch,
        onProgress(done, total) {
          setStatus(cloneStatusEl, `Descargando a IndexedDB: ${done} de ${total} archivos…`, "neutral");
        }
      });

      const project = await hydrateGithubProject({
        owner,
        repo,
        branch,
        commitSha,
        files
      });

      setStatus(cloneStatusEl, `Repositorio listo (${files.length} archivos guardados para editar en el iPad).`, "ok");
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
    } catch (error) {
      setStatus(cloneStatusEl, error instanceof Error ? error.message : "No se pudo descargar el repositorio.", "error");
    } finally {
      cloneBtn.disabled = false;
    }
  });

  pullBtn?.addEventListener("click", async () => {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

    await onFlushPendingSaves?.();
    const pendingChanges = await getPendingGithubChanges(project.id);

    if (pendingChanges.length > 0 && !pendingPullConfirm) {
      pendingPullConfirm = true;
      pullBtn.className = "tree-confirm-delete";
      pullBtn.textContent = "Confirmar descarte";
      setStatus(
        pushStatusEl,
        `Tenés ${pendingChanges.length} archivo(s) locales sin subir. Tocá Confirmar descarte si querés sobrescribirlos con la versión remota.`,
        "error"
      );
      pullConfirmTimer = window.setTimeout(() => {
        resetPullConfirm();
      }, 4500);
      return;
    }

    resetPullConfirm();

    const token = getGithubToken();
    const { owner, repo, branch } = project.github;
    pullBtn.disabled = true;
    setStatus(pushStatusEl, `Actualizando ${owner}/${repo} (${branch}) desde GitHub…`, "neutral");

    try {
      const { commitSha, files } = await downloadRepoFiles({
        token,
        owner,
        repo,
        branch
      });
      const updated = await hydrateGithubProject({ owner, repo, branch, commitSha, files });
      await onProjectClonedOrSynced(updated.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, "Archivos sincronizados con la última versión remota.", "ok");
    } catch (error) {
      setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al actualizar.", "error");
    } finally {
      pullBtn.disabled = false;
    }
  });

  pushBtn?.addEventListener("click", async () => {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

    await onFlushPendingSaves?.();

    const token = getGithubToken();
    if (!token) {
      setStatus(pushStatusEl, "Necesitás conectar tu Personal Access Token arriba para hacer push.", "error");
      return;
    }

    const message = (commitMsgInput?.value || "").trim();
    if (!message) {
      commitMsgInput?.focus();
      setStatus(pushStatusEl, "Escribí un mensaje descriptivo para el commit.", "error");
      return;
    }

    const changes = await getPendingGithubChanges(project.id);
    if (changes.length === 0) {
      setStatus(pushStatusEl, "No hay cambios pendientes frente al repositorio.", "neutral");
      return;
    }

    pushBtn.disabled = true;
    setStatus(pushStatusEl, `Enviando commit con ${changes.length} archivo(s) a ${project.github.branch}…`, "neutral");

    try {
      const { commitSha } = await pushAtomicCommit({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branch: project.github.branch,
        message,
        changes
      });

      await markProjectSynced(project.id, commitSha);
      if (commitMsgInput) commitMsgInput.value = "";
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, `Commit publicado con éxito (${commitSha.slice(0, 7)}).`, "ok");
    } catch (error) {
      setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al publicar commit.", "error");
    } finally {
      pushBtn.disabled = false;
    }
  });

  async function connectAndLoadRepos(token) {
    connectBtn.disabled = true;
    setStatus(authMsgEl, "Verificando cuenta y repositorios en GitHub…", "neutral");
    try {
      const [user, repos] = await Promise.all([
        fetchGithubUser(token),
        fetchUserRepositories(token)
      ]);
      reposCache = Array.isArray(repos) ? repos : [];

      if (userStatusEl) {
        userStatusEl.textContent = `@${user.login}`;
      }
      setStatus(authMsgEl, `Conectado como @${user.login} (${reposCache.length} repositorios disponibles).`, "ok");

      if (repoSelect) {
        repoSelect.innerHTML = "";
        for (const r of reposCache) {
          const opt = document.createElement("option");
          opt.value = r.full_name;
          opt.textContent = `${r.full_name}${r.private ? " (privado)" : ""}`;
          repoSelect.appendChild(opt);
        }
      }

      if (reposCache.length > 0) {
        if (manualRepoInput) manualRepoInput.value = reposCache[0].full_name;
        await loadBranchesForRepo(reposCache[0].full_name, reposCache[0].default_branch);
      }
    } catch (error) {
      setStatus(authMsgEl, error instanceof Error ? error.message : "Token inválido o sin permisos.", "error");
    } finally {
      connectBtn.disabled = false;
    }
  }

  async function loadBranchesForRepo(fullName, preferredBranch) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo || !branchSelect) return;

    const token = getGithubToken();
    try {
      const branches = await fetchRepositoryBranches(token, owner, repo);
      branchSelect.innerHTML = "";
      for (const b of branches) {
        const opt = document.createElement("option");
        opt.value = b.name;
        opt.textContent = b.name;
        branchSelect.appendChild(opt);
      }
      if (preferredBranch && branches.some((b) => b.name === preferredBranch)) {
        branchSelect.value = preferredBranch;
      }
    } catch {
      branchSelect.innerHTML = '<option value="main">main</option><option value="master">master</option>';
    }
  }

  async function refreshSyncPanel() {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) {
      if (syncSection) syncSection.hidden = true;
      await refreshTopbarBadge();
      return;
    }

    if (syncSection) syncSection.hidden = false;
    if (syncRepoTitle) {
      syncRepoTitle.textContent = `${project.github.owner}/${project.github.repo} (${project.github.branch})`;
    }

    const changes = await getPendingGithubChanges(project.id);
    if (changesListEl) {
      changesListEl.innerHTML = "";
      if (changes.length === 0) {
        const emptyLi = document.createElement("li");
        emptyLi.className = "gh-change-item";
        emptyLi.textContent = "Todo al día con el último commit descargado.";
        changesListEl.appendChild(emptyLi);
      } else {
        const statusMap = {
          added: { label: "Nuevo", cls: "is-added" },
          modified: { label: "Editado", cls: "is-modified" },
          deleted: { label: "Borrado", cls: "is-deleted" }
        };
        for (const ch of changes) {
          const li = document.createElement("li");
          li.className = "gh-change-item";
          const st = statusMap[ch.status] || statusMap.modified;

          const pathSpan = document.createElement("span");
          pathSpan.className = "code-font gh-change-path";
          pathSpan.textContent = ch.path;

          const rightWrap = document.createElement("div");
          rightWrap.className = "gh-change-actions";

          const diffBtn = document.createElement("button");
          diffBtn.type = "button";
          diffBtn.className = "btn btn-ghost btn-sm";
          diffBtn.innerHTML = `${icon("gitCompare")}<span>Diff</span>`;
          diffBtn.addEventListener("click", () => {
            onOpenDiff?.({
              title: `Cambios en ${ch.path}`,
              oldCode: ch.baseContent || "",
              newCode: ch.status === "deleted" ? "" : ch.content || ""
            });
          });

          const tagSpan = document.createElement("span");
          tagSpan.className = `gh-change-tag ${st.cls}`;
          tagSpan.textContent = st.label;

          rightWrap.append(diffBtn, tagSpan);
          li.append(pathSpan, rightWrap);
          changesListEl.appendChild(li);
        }
      }
    }

    if (pushBtn) {
      pushBtn.disabled = changes.length === 0;
    }

    await refreshTopbarBadge(changes.length);
  }

  async function refreshTopbarBadge(precomputedCount) {
    if (!topbarRepoLabel) return;
    const project = getActiveProject();
    if (!project || project.kind !== "github") {
      topbarRepoLabel.textContent = "Repositorio";
      return;
    }
    const count =
      typeof precomputedCount === "number"
        ? precomputedCount
        : (await getPendingGithubChanges(project.id)).length;

    topbarRepoLabel.textContent = count > 0 ? `Commit (${count})` : "Repositorio";
  }

  return {
    refreshTopbarBadge
  };
}

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  if (kind === "ok") el.classList.add("is-ok");
}
