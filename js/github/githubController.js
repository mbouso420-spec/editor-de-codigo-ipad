import { icon } from "../ui/icons.js";
import {
  clearGithubToken,
  compareRemoteCommits,
  createRepoBranch,
  downloadRepoFiles,
  fetchGithubUser,
  fetchRepoTreeIndex,
  fetchRepositoryBranches,
  fetchSingleRepoBlob,
  fetchUserRepositories,
  getCachedUserRepositories,
  getGithubToken,
  pushAtomicCommit,
  RemoteAheadError,
  saveGithubToken,
  verifyGithubToken
} from "./githubService.js";
import {
  getPendingGithubChanges,
  getProjectEntries,
  hydrateGithubProject,
  hydrateLazyGithubProject,
  makeGithubProjectId,
  markProjectSynced,
  saveProjectState
} from "../storage/workspaceDb.js";

/**
 * Controlador del flujo de conexión con GitHub (PAT local + Octokit),
 * apertura instantánea bajo demanda sin descargar todo, copia offline opcional para iPad,
 * previsualización de Diff por archivo y Commit + Push atómico.
 */
export function initGithubController({
  getActiveProject,
  onFlushPendingSaves,
  onProjectClonedOrSynced,
  onReposListChanged,
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
  const openLiveBtn = document.getElementById("btn-gh-open-live");
  const cloneBtn = document.getElementById("btn-gh-clone");
  const cloneStatusEl = document.getElementById("gh-clone-status");

  const syncSection = document.getElementById("gh-sync-section");
  const syncRepoTitle = document.getElementById("gh-sync-repo-title");
  const syncBranchSelect = document.getElementById("gh-sync-branch-select");
  const btnNewBranch = document.getElementById("btn-gh-new-branch");
  const newBranchBox = document.getElementById("gh-new-branch-box");
  const newBranchInput = document.getElementById("gh-new-branch-input");
  const btnCreateBranch = document.getElementById("btn-gh-create-branch");
  const btnCancelBranch = document.getElementById("btn-gh-cancel-branch");
  const branchStatusEl = document.getElementById("gh-branch-status");
  const pullBtn = document.getElementById("btn-gh-pull");
  const changesListEl = document.getElementById("gh-changes-list");
  const commitMsgInput = document.getElementById("gh-commit-msg");
  const pushBtn = document.getElementById("btn-gh-push");
  const pushStatusEl = document.getElementById("gh-push-status");

  const conflictBox = document.getElementById("gh-conflict-box");
  const conflictMsg = document.getElementById("gh-conflict-msg");
  const conflictList = document.getElementById("gh-conflict-list");
  const conflictViewBtn = document.getElementById("btn-gh-conflict-view");
  const conflictForceBtn = document.getElementById("btn-gh-conflict-force");

  const tokenWarning = document.getElementById("explorer-token-warning");
  const tokenWarningText = document.getElementById("explorer-token-warning-text");
  const tokenReconnectBtn = document.getElementById("btn-token-reconnect");

  const INVALID_TOKEN_MSG =
    "Token inválido o vencido. Revisá que lo hayas copiado completo o generá uno nuevo en GitHub.";

  function showTokenWarning(message) {
    if (tokenWarningText) tokenWarningText.textContent = message;
    if (tokenWarning) tokenWarning.hidden = false;
  }

  function hideTokenWarning() {
    if (tokenWarning) tokenWarning.hidden = true;
  }

  tokenReconnectBtn?.addEventListener("click", () => {
    openDialogBtn?.click();
    window.setTimeout(() => {
      tokenInput?.focus();
      tokenInput?.select();
    }, 50);
  });

  let reposCache = [];
  let pendingPullConfirm = false;
  let pullConfirmTimer = 0;
  /** @type {"live" | "clone" | null} */
  let pendingOpenConfirmKind = null;
  let openConfirmTimer = 0;
  let activeConflict = null;

  function resetPullConfirm() {
    pendingPullConfirm = false;
    window.clearTimeout(pullConfirmTimer);
    if (pullBtn) {
      pullBtn.className = "btn btn-ghost btn-sm";
      pullBtn.innerHTML = `${icon("refreshCw")}<span>Actualizar remoto</span>`;
    }
  }

  function resetOpenConfirm() {
    pendingOpenConfirmKind = null;
    window.clearTimeout(openConfirmTimer);
    if (openLiveBtn) {
      openLiveBtn.className = "btn";
      openLiveBtn.innerHTML = `${icon("folderOpen")}<span>Abrir sin descargar</span>`;
    }
    if (cloneBtn) {
      cloneBtn.className = "btn";
      cloneBtn.innerHTML = `${icon("cloudDownload")}<span>Guardar copia offline</span>`;
    }
  }

  function hideConflictBox() {
    activeConflict = null;
    if (conflictBox) conflictBox.hidden = true;
    if (conflictList) {
      conflictList.hidden = true;
      conflictList.innerHTML = "";
    }
  }

  openDialogBtn?.addEventListener("click", async () => {
    if (!dialog) return;
    resetPullConfirm();
    resetOpenConfirm();
    hideConflictBox();
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
    resetOpenConfirm();
    hideConflictBox();
    dialog?.close();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      resetPullConfirm();
      resetOpenConfirm();
      hideConflictBox();
      dialog.close();
    }
  });

  connectBtn?.addEventListener("click", async () => {
    const token = (tokenInput?.value || "").trim();
    if (!token) {
      setStatus(authMsgEl, "Pegá un Personal Access Token (PAT) de GitHub.", "error");
      return;
    }

    // Se verifica ANTES de guardar: un token inválido no debe quedar guardado.
    connectBtn.disabled = true;
    setStatus(authMsgEl, "Verificando el token con GitHub…", "neutral");
    const check = await verifyGithubToken(token);
    connectBtn.disabled = false;

    if (check.status === "invalid") {
      setStatus(authMsgEl, check.message, "error");
      return;
    }

    saveGithubToken(token);
    hideTokenWarning();

    if (check.status !== "valid") {
      // Sin internet o GitHub sin responder: se guarda para usarlo cuando vuelva la conexión.
      setStatus(authMsgEl, `${check.message} El token quedó guardado.`, "error");
      return;
    }
    await connectAndLoadRepos(token);
  });

  clearTokenBtn?.addEventListener("click", () => {
    clearGithubToken();
    hideTokenWarning();
    reposCache = [];
    onReposListChanged?.([]);
    if (tokenInput) tokenInput.value = "";
    if (userStatusEl) userStatusEl.textContent = "Sin sesión";
    if (repoSelect) repoSelect.innerHTML = '<option value="">Conectá tu token para listar repositorios</option>';
    setStatus(authMsgEl, "Token eliminado de este navegador.", "neutral");
  });

  repoSelect?.addEventListener("change", async () => {
    resetOpenConfirm();
    const fullName = repoSelect.value;
    if (manualRepoInput && fullName) {
      manualRepoInput.value = fullName;
    }
    if (fullName) {
      await loadBranchesForRepo(fullName);
    }
  });

  manualRepoInput?.addEventListener("change", async () => {
    resetOpenConfirm();
    const fullName = manualRepoInput.value.trim();
    if (fullName.includes("/")) {
      await loadBranchesForRepo(fullName);
    }
  });

  branchSelect?.addEventListener("change", () => {
    resetOpenConfirm();
  });

  async function guardOverwritePendingChanges(owner, repo, branch, kind, triggerBtn) {
    const targetId = makeGithubProjectId(owner, repo, branch);
    const pendingChanges = await getPendingGithubChanges(targetId);
    if (pendingChanges.length > 0 && pendingOpenConfirmKind !== kind) {
      resetOpenConfirm();
      pendingOpenConfirmKind = kind;
      if (triggerBtn) {
        triggerBtn.className = "tree-confirm-delete";
        triggerBtn.textContent = "Confirmar descarte";
      }
      setStatus(
        cloneStatusEl,
        `Tenés ${pendingChanges.length} archivo(s) locales sin commitear en ${owner}/${repo} (${branch}). Tocá Confirmar descarte si querés sobrescribirlos.`,
        "error"
      );
      openConfirmTimer = window.setTimeout(() => {
        resetOpenConfirm();
      }, 4500);
      return false;
    }
    resetOpenConfirm();
    return true;
  }

  openLiveBtn?.addEventListener("click", async () => {
    await onFlushPendingSaves?.();
    const token = getGithubToken();
    const targetFullName = (manualRepoInput?.value || repoSelect?.value || "").trim();
    const [owner, repo] = targetFullName.split("/");
    const branch = (branchSelect?.value || "main").trim();

    if (!owner || !repo) {
      setStatus(cloneStatusEl, "Elegí un repositorio o escribí usuario/repositorio.", "error");
      return;
    }

    const canProceed = await guardOverwritePendingChanges(owner, repo, branch, "live", openLiveBtn);
    if (!canProceed) return;

    openLiveBtn.disabled = true;
    setStatus(cloneStatusEl, `Cargando árbol de ${owner}/${repo} (${branch})…`, "neutral");

    try {
      const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
      const project = await hydrateLazyGithubProject({
        owner,
        repo,
        branch: index.branch || branch,
        commitSha: index.commitSha,
        entries: index.entries
      });

      setStatus(
        cloneStatusEl,
        `Árbol cargado al instante (${index.entries.length} archivos en el Explorador, sin descargar todo).`,
        "ok"
      );
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
      dialog?.close();
    } catch (error) {
      setStatus(cloneStatusEl, error instanceof Error ? error.message : "No se pudo abrir el repositorio.", "error");
    } finally {
      openLiveBtn.disabled = false;
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

    const canProceed = await guardOverwritePendingChanges(owner, repo, branch, "clone", cloneBtn);
    if (!canProceed) return;

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
      let updated;
      if (project.offlineCached) {
        const { commitSha, files } = await downloadRepoFiles({ token, owner, repo, branch });
        updated = await hydrateGithubProject({ owner, repo, branch, commitSha, files });
      } else {
        const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
        updated = await hydrateLazyGithubProject({
          owner,
          repo,
          branch: index.branch || branch,
          commitSha: index.commitSha,
          entries: index.entries
        });
      }
      await onProjectClonedOrSynced(updated.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, "Árbol y archivos sincronizados con la última versión remota.", "ok");
    } catch (error) {
      setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al actualizar.", "error");
    } finally {
      pullBtn.disabled = false;
    }
  });

  async function executePush(force = false) {
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
    if (conflictForceBtn) conflictForceBtn.disabled = true;
    setStatus(pushStatusEl, `Enviando commit con ${changes.length} archivo(s) a ${project.github.branch}…`, "neutral");

    try {
      const { commitSha } = await pushAtomicCommit({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branch: project.github.branch,
        message,
        changes,
        expectedBaseSha: project.github.commitSha || null,
        force
      });

      hideConflictBox();
      // Solo se consolida lo que viajó en este commit: lo editado mientras tanto sigue pendiente.
      await markProjectSynced(project.id, commitSha, changes);
      if (commitMsgInput) commitMsgInput.value = "";
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, `Commit publicado con éxito (${commitSha.slice(0, 7)}).`, "ok");
    } catch (error) {
      if (error instanceof RemoteAheadError) {
        showConflictBox(error, project, token);
      } else if (error?.status === 401) {
        setStatus(pushStatusEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado: no se pudo hacer push.");
      } else {
        setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al publicar commit.", "error");
      }
    } finally {
      pushBtn.disabled = false;
      if (conflictForceBtn) conflictForceBtn.disabled = false;
    }
  }

  function showConflictBox(error, project, token) {
    activeConflict = {
      remoteSha: error.remoteSha,
      expectedSha: error.expectedSha,
      project,
      token
    };
    if (conflictBox) conflictBox.hidden = false;
    if (conflictMsg) {
      const baseShort = (error.expectedSha || "inicial").slice(0, 7);
      const remoteShort = (error.remoteSha || "").slice(0, 7);
      conflictMsg.textContent = `Push bloqueado: GitHub avanzó a ${remoteShort} desde tu última versión (${baseShort}). Podés ver qué cambió en remoto antes de decidir o forzar el envío con tu versión local.`;
    }
    setStatus(pushStatusEl, "Hay commits nuevos en GitHub que no tenés localmente.", "error");
  }

  pushBtn?.addEventListener("click", () => executePush(false));

  conflictForceBtn?.addEventListener("click", () => executePush(true));

  conflictViewBtn?.addEventListener("click", async () => {
    if (!activeConflict || !conflictList) return;
    conflictViewBtn.disabled = true;
    try {
      const diffFiles = await compareRemoteCommits({
        token: activeConflict.token,
        owner: activeConflict.project.github.owner,
        repo: activeConflict.project.github.repo,
        base: activeConflict.expectedSha,
        head: activeConflict.remoteSha
      });
      conflictList.innerHTML = "";
      conflictList.hidden = false;
      if (diffFiles.length === 0) {
        const li = document.createElement("li");
        li.className = "gh-change-item";
        li.textContent = "No se detectaron diferencias en archivos de texto.";
        conflictList.appendChild(li);
      } else {
        for (const file of diffFiles) {
          const li = document.createElement("li");
          li.className = "gh-change-item";
          const nameSpan = document.createElement("span");
          nameSpan.className = "code-font gh-change-path";
          nameSpan.textContent = file.path;

          const actionWrap = document.createElement("div");
          actionWrap.className = "gh-change-actions";

          const viewBtn = document.createElement("button");
          viewBtn.type = "button";
          viewBtn.className = "btn btn-ghost btn-sm";
          viewBtn.innerHTML = `${icon("gitCompare")}<span>Diff</span>`;
          viewBtn.addEventListener("click", async () => {
            const allEntries = await getProjectEntries(activeConflict.project.id);
            const localFile = allEntries.find((f) => f.path === file.path);
            let remoteContent = "";
            if (file.blobSha) {
              try {
                remoteContent = await fetchSingleRepoBlob({
                  token: activeConflict.token,
                  owner: activeConflict.project.github.owner,
                  repo: activeConflict.project.github.repo,
                  blobSha: file.blobSha
                });
              } catch {
                remoteContent = "(No se pudo descargar el archivo remoto)";
              }
            }
            let localContent = "(Archivo no existe localmente)";
            if (localFile) {
              if (localFile.contentLoaded !== false && typeof localFile.content === "string") {
                localContent = localFile.content;
              } else if (localFile.blobSha) {
                try {
                  localContent = await fetchSingleRepoBlob({
                    token: activeConflict.token,
                    owner: activeConflict.project.github.owner,
                    repo: activeConflict.project.github.repo,
                    blobSha: localFile.blobSha
                  });
                } catch {
                  localContent = "(No se pudo descargar el archivo local)";
                }
              }
            }
            onOpenDiff?.({
              title: `Remoto (${file.path}) vs Local`,
              oldCode: remoteContent,
              newCode: localContent
            });
          });

          const tag = document.createElement("span");
          tag.className = `gh-change-tag ${file.status === "added" ? "is-added" : file.status === "removed" ? "is-deleted" : "is-modified"}`;
          tag.textContent = file.status;

          actionWrap.append(viewBtn, tag);
          li.append(nameSpan, actionWrap);
          conflictList.appendChild(li);
        }
      }
    } catch (err) {
      setStatus(pushStatusEl, err instanceof Error ? err.message : "No se pudo comparar con GitHub.", "error");
    } finally {
      conflictViewBtn.disabled = false;
    }
  });

  btnNewBranch?.addEventListener("click", () => {
    if (newBranchBox) {
      newBranchBox.hidden = false;
      newBranchInput?.focus();
    }
  });

  btnCancelBranch?.addEventListener("click", () => {
    if (newBranchBox) {
      newBranchBox.hidden = true;
      if (newBranchInput) newBranchInput.value = "";
    }
    if (branchStatusEl) branchStatusEl.hidden = true;
  });

  btnCreateBranch?.addEventListener("click", async () => {
    const project = getActiveProject();
    if (!project || !project.github) return;
    const branchName = String(newBranchInput?.value || "").trim();
    if (!branchName) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = "Escribí un nombre para la nueva rama.";
      }
      return;
    }
    const token = getGithubToken();
    if (!token) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = "Conectá tu token de GitHub antes de crear ramas.";
      }
      return;
    }

    if (btnCreateBranch) btnCreateBranch.disabled = true;
    if (branchStatusEl) {
      branchStatusEl.hidden = false;
      branchStatusEl.textContent = `Creando rama "${branchName}" en GitHub…`;
    }

    try {
      await createRepoBranch({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branchName,
        fromSha: project.github.commitSha || project.github.baseCommitSha
      });
      project.github.branch = branchName;
      await saveProjectState(project);
      if (newBranchBox) {
        newBranchBox.hidden = true;
        if (newBranchInput) newBranchInput.value = "";
      }
      if (branchStatusEl) {
        branchStatusEl.textContent = `Rama "${branchName}" creada y activa.`;
      }
      await refreshSyncPanel();
    } catch (err) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = err instanceof Error ? err.message : "Error al crear la rama";
      }
    } finally {
      if (btnCreateBranch) btnCreateBranch.disabled = false;
    }
  });

  syncBranchSelect?.addEventListener("change", async () => {
    const project = getActiveProject();
    if (!project || !project.github) return;
    const chosen = syncBranchSelect.value;
    if (!chosen || chosen === project.github.branch) return;

    project.github.branch = chosen;
    await saveProjectState(project);
    await refreshSyncPanel();
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
      onReposListChanged?.(reposCache);

      if (userStatusEl) {
        userStatusEl.textContent = `@${user.login}`;
      }
      const repoCount = reposCache.length;
      setStatus(
        authMsgEl,
        `Conectado como @${user.login} (${repoCount} ${repoCount === 1 ? "repositorio disponible" : "repositorios disponibles"}).`,
        "ok"
      );

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
      if (error?.status === 401) {
        setStatus(authMsgEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado. Conectá uno nuevo para ver tus repos y hacer push.");
      } else {
        setStatus(authMsgEl, error instanceof Error ? error.message : "Token inválido o sin permisos.", "error");
      }
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

    if (syncBranchSelect) {
      const token = getGithubToken();
      if (token && project.github.owner && project.github.repo) {
        fetchRepositoryBranches(token, project.github.owner, project.github.repo)
          .then((branches) => {
            if (!Array.isArray(branches) || branches.length === 0) return;
            syncBranchSelect.innerHTML = "";
            for (const b of branches) {
              const opt = document.createElement("option");
              opt.value = b.name;
              opt.textContent = b.name;
              if (b.name === project.github.branch) {
                opt.selected = true;
              }
              syncBranchSelect.appendChild(opt);
            }
          })
          .catch(() => {
            syncBranchSelect.innerHTML = `<option value="${project.github.branch}" selected>${project.github.branch}</option>`;
          });
      } else {
        syncBranchSelect.innerHTML = `<option value="${project.github.branch}" selected>${project.github.branch}</option>`;
      }
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

  async function syncExplorerReposInBackground() {
    const token = getGithubToken();
    if (!token) {
      onReposListChanged?.([]);
      return;
    }

    const cached = getCachedUserRepositories();
    if (cached.length > 0) {
      reposCache = cached;
      onReposListChanged?.(cached);
    }

    try {
      const liveRepos = await fetchUserRepositories(token);
      if (Array.isArray(liveRepos)) {
        reposCache = liveRepos;
        onReposListChanged?.(liveRepos);
      }
      hideTokenWarning();
    } catch (error) {
      if (error?.status === 401) {
        // El token guardado dejó de funcionar: avisar ahora y no recién al intentar el push.
        showTokenWarning("Tu token de GitHub venció o fue revocado. Conectá uno nuevo para ver tus repos y hacer push.");
      }
      // Sin conexión: silencioso, se mantienen los repositorios cacheados localmente
    }
  }

  return {
    refreshTopbarBadge,
    syncExplorerReposInBackground
  };
}

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  if (kind === "ok") el.classList.add("is-ok");
}
