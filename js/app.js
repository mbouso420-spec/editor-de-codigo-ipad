import { hydrateIcons, icon } from "./ui/icons.js";
import { initLayoutController } from "./ui/layout.js";
import { initSymbolBar } from "./ui/symbolBar.js";
import { initExplorerController } from "./ui/explorerController.js";
import { initDiffModal } from "./ui/diffModal.js";
import { initLivePreviewModal } from "./ui/livePreviewModal.js";
import { initQuickOpenModal } from "./ui/quickOpenModal.js";
import { createEditorManager } from "./editor/editorManager.js";
import { initChatController } from "./ai/chatController.js";
import { initGithubController } from "./github/githubController.js";
import {
  downloadBatchBlobs,
  fetchRepoTreeIndex,
  fetchSingleRepoBlob,
  getGithubToken
} from "./github/githubService.js";
import {
  cacheSingleGithubFileContent,
  createLocalProject,
  deleteProject,
  deleteProjectEntry,
  ensureInitialWorkspace,
  getProject,
  getProjectEntries,
  getSavedActiveProjectId,
  hydrateLazyGithubProject,
  inferFileMeta,
  listProjects,
  markProjectOfflineCached,
  renameProjectEntry,
  requestPersistentStorage,
  saveProjectChatHistory,
  saveProjectState,
  setSavedActiveProjectId,
  updateFileContent,
  upsertEntry
} from "./storage/workspaceDb.js";

async function initApp() {
  hydrateIcons(document);
  registerPwaServiceWorker();
  void requestPersistentStorage();

  const layout = initLayoutController();
  const diffModal = initDiffModal();

  const tabStripEl = document.getElementById("editor-tabs");
  const editorMountEl = document.getElementById("editor-mount");
  const emptyStateEl = document.getElementById("editor-empty-state");
  const emptyQuickListEl = document.getElementById("editor-empty-quicklist");
  const contextStatusEl = document.getElementById("chat-context-status");
  const contextFileEl = document.getElementById("chat-context-filename");

  const btnUndo = document.getElementById("btn-editor-undo");
  const btnRedo = document.getElementById("btn-editor-redo");
  const btnSearch = document.getElementById("btn-editor-search");
  const btnWrap = document.getElementById("btn-editor-wrap");
  const btnFontDown = document.getElementById("btn-font-down");
  const btnFontUp = document.getElementById("btn-font-up");
  const btnExportFile = document.getElementById("btn-export-file");
  const zoomReadoutEl = document.getElementById("editor-zoom-readout");

  const statusFilePathEl = document.getElementById("status-file-path");
  const statusFileLangEl = document.getElementById("status-file-lang");
  const statusCursorPosEl = document.getElementById("status-cursor-pos");
  const statusNetworkEl = document.getElementById("status-network-state");

  let projects = await ensureInitialWorkspace();
  let activeProject =
    projects.find((p) => p.id === getSavedActiveProjectId()) || projects[0];
  setSavedActiveProjectId(activeProject.id);

  /** @type {Array<any>} */
  let entries = [];
  /** @type {Array<any>} */
  let filesOnly = [];
  let openTabIds = [];
  let activeFileId = null;
  let activeSelection = { text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 };
  let chat = null;

  /** @type {Map<string, number>} */
  const saveTimers = new Map();

  const editor = await createEditorManager({
    mountEl: editorMountEl,
    onDocChange(filePath, newContent) {
      const target = filesOnly.find((f) => f.id === filePath);
      if (!target) {
        return;
      }
      const wasDirty = isFileDirtyForProject(target);
      target.content = newContent;
      const nowDirty = isFileDirtyForProject(target);

      if (wasDirty !== nowDirty) {
        renderTabs();
      }

      scheduleAutosave(activeProject.id, filePath, newContent);
    },
    onSelectionChange(selection) {
      activeSelection = selection;
      updateAssistantContextLabel();
      updateStatusBar();
      chat?.notifySelectionChanged();
    }
  });

  initQuickOpenModal({
    getFiles: () => filesOnly,
    onSelectFile(path) {
      void openOrFocusFile(path);
    }
  });

  const symbolBar = initSymbolBar({
    onInsert(text, cursorBack) {
      if (!activeFileId) return;
      editor.insertAtCursor(text, cursorBack);
    }
  });

  const explorer = initExplorerController({
    onSelectFile(path) {
      openOrFocusFile(path);
    },
    async onCreateEntry(path, isFolder) {
      await flushPendingSaves();
      await upsertEntry(activeProject.id, path, {
        isFolder,
        content: isFolder ? "" : defaultStarterTemplate(path),
        allowOverwrite: false
      });
      await reloadProjectEntries();
      if (!isFolder) {
        await openOrFocusFile(path);
      } else {
        renderWorkspaceView();
      }
      await github.refreshTopbarBadge();
    },
    async onRenameEntry(oldPath, newPath, isFolder) {
      await flushPendingSaves();
      const affectedUnloaded = filesOnly.filter(
        (f) =>
          f.contentLoaded === false &&
          (f.id === oldPath || (isFolder && f.id.startsWith(`${oldPath}/`)))
      );
      if (affectedUnloaded.length > 0) {
        await ensureFilesLoaded(affectedUnloaded);
      }

      await renameProjectEntry(activeProject.id, oldPath, newPath, isFolder);

      // Actualizar pestañas abiertas afectadas por el renombrado
      openTabIds = openTabIds.map((id) => {
        if (id === oldPath) return newPath;
        if (isFolder && id.startsWith(`${oldPath}/`)) {
          return `${newPath}${id.slice(oldPath.length)}`;
        }
        return id;
      });
      if (activeFileId === oldPath) {
        activeFileId = newPath;
      } else if (isFolder && activeFileId && activeFileId.startsWith(`${oldPath}/`)) {
        activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
      }
      editor.renameFileStates(oldPath, newPath, isFolder);

      await persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onDeleteEntry(path, isFolder) {
      await flushPendingSaves();
      await deleteProjectEntry(activeProject.id, path, isFolder);

      const removedTabs = openTabIds.filter(
        (id) => id === path || (isFolder && id.startsWith(`${path}/`))
      );
      for (const rem of removedTabs) {
        editor.dropFileState(rem);
      }

      openTabIds = openTabIds.filter(
        (id) => id !== path && !(isFolder && id.startsWith(`${path}/`))
      );
      if (!openTabIds.includes(activeFileId)) {
        activeFileId = openTabIds[0] || null;
      }

      await persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onSwitchProject(selectedValue) {
      await flushPendingSaves();
      if (selectedValue.startsWith("ghlive::")) {
        const parts = selectedValue.split("::");
        const fullName = parts[1] || "";
        const defaultBranch = parts[2] || "main";
        const [owner, repo] = fullName.split("/");
        if (!owner || !repo) return;

        explorer.setAutosaveStatus(`Abriendo ${fullName}…`);
        try {
          const index = await fetchRepoTreeIndex({
            token: getGithubToken(),
            owner,
            repo,
            branch: defaultBranch
          });
          const createdProj = await hydrateLazyGithubProject({
            owner,
            repo,
            branch: index.branch || defaultBranch,
            commitSha: index.commitSha,
            entries: index.entries
          });
          projects = await listProjects();
          await switchProject(createdProj.id, true);
          explorer.setAutosaveStatus(
            `Árbol de ${repo} listo (${index.entries.length} archivos bajo demanda)`
          );
        } catch (error) {
          explorer.renderProjects(projects, activeProject.id);
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo conectar con GitHub"
          );
        }
        return;
      }

      await switchProject(selectedValue);
    },
    async onCreateProject(name) {
      await flushPendingSaves();
      const created = await createLocalProject(name);
      projects = await listProjects();
      await switchProject(created.id);
    },
    async onDeleteCurrentProject() {
      if (projects.length <= 1) return;
      await flushPendingSaves();
      const removedId = activeProject.id;
      await deleteProject(removedId);
      projects = await listProjects();
      await switchProject(projects[0].id);
    },
    async onImportFiles(importedList) {
      await flushPendingSaves();
      let lastPath = null;
      let importedCount = 0;
      try {
        for (const item of importedList) {
          await upsertEntry(activeProject.id, item.path, {
            isFolder: false,
            content: item.content
          });
          editor.dropFileState(item.path);
          lastPath = item.path;
          importedCount += 1;
        }
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo importar el archivo"
        );
      }
      await reloadProjectEntries();
      if (lastPath) {
        await openOrFocusFile(lastPath);
        if (importedCount > 0) {
          explorer.setAutosaveStatus(
            importedCount === 1 ? "Archivo importado" : `${importedCount} archivos importados`
          );
        }
      } else {
        renderWorkspaceView();
      }
      await github.refreshTopbarBadge();
    },
    async onDownloadActiveFile() {
      const current = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
      if (!current) return;
      try {
        await ensureFileContentLoaded(current);
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo descargar el archivo desde GitHub"
        );
        return;
      }
      const filename = current.path.split("/").pop() || "archivo.txt";
      const blob = new Blob([current.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    async onSaveRepoOffline() {
      if (activeProject.kind !== "github" || !activeProject.github) return;
      await flushPendingSaves();

      const pending = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (pending.length === 0) {
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline completa en el iPad");
        return;
      }

      explorer.setOfflineRepoState({
        visible: true,
        isOfflineReady: false,
        pendingCount: pending.length,
        busy: true
      });
      explorer.setAutosaveStatus(`Guardando copia offline (0/${pending.length})…`);

      try {
        await ensureFilesLoaded(pending, (done, total) => {
          explorer.setAutosaveStatus(`Guardando copia offline (${done}/${total})…`);
        });
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline guardada en el iPad");
      } catch (error) {
        syncOfflineButtonState();
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo completar la copia offline"
        );
      }
    }
  });

  const PREVIEWABLE_LANGS = new Set(["html", "js", "css", "python", "markdown"]);

  initLivePreviewModal({
    getWorkspaceSnapshot() {
      return {
        files: filesOnly,
        activeFileId
      };
    },
    async onBeforePreview() {
      await flushPendingSaves();
      if (activeProject.kind !== "github" || !activeFileId) return;
      const activeFile = filesOnly.find((f) => f.id === activeFileId);
      if (!activeFile || !PREVIEWABLE_LANGS.has(activeFile.lang)) return;

      if (activeFile.lang === "markdown") {
        if (activeFile.contentLoaded === false && activeFile.blobSha) {
          try {
            await ensureFileContentLoaded(activeFile);
          } catch {
            // Se muestra con el estado actual en memoria
          }
        }
        return;
      }

      const lastSlash = activeFile.path.lastIndexOf("/");
      const folderPrefix = lastSlash === -1 ? "" : `${activeFile.path.slice(0, lastSlash + 1)}`;

      const needed = filesOnly.filter((f) => {
        if (f.contentLoaded !== false || !f.blobSha) return false;
        if (folderPrefix && !f.path.startsWith(folderPrefix)) return false;
        if (activeFile.lang === "python") {
          return f.lang === "python";
        }
        return (
          f.lang === "html" ||
          f.lang === "js" ||
          f.lang === "css" ||
          f.path.endsWith(".json")
        );
      });

      if (needed.length > 0) {
        explorer.setAutosaveStatus(`Cargando ${needed.length} archivo(s) para la vista previa…`);
        try {
          await ensureFilesLoaded(needed);
          explorer.setAutosaveStatus("Vista previa lista");
        } catch {
          // Si falla la red, abre con los archivos ya disponibles en memoria
        }
      }
    }
  });

  function inferFallbackFilename(rawLang) {
    const clean = String(rawLang || "").trim().toLowerCase();
    switch (clean) {
      case "py":
      case "python":
        return "main.py";
      case "cpp":
      case "c++":
        return "main.cpp";
      case "c":
        return "main.c";
      case "html":
        return "index.html";
      case "css":
        return "styles.css";
      case "js":
      case "javascript":
        return "app.js";
      case "sql":
        return "consulta.sql";
      case "md":
      case "markdown":
        return "README.md";
      case "json":
        return "datos.json";
      default:
        return "archivo.txt";
    }
  }

  async function ensureAnOpenFile(preferredLang = "") {
    if (activeFileId) return;
    if (filesOnly.length > 0) {
      await openOrFocusFile(filesOnly[0].id);
      return;
    }
    const fallbackPath = inferFallbackFilename(preferredLang);
    await upsertEntry(activeProject.id, fallbackPath, {
      isFolder: false,
      content: "",
      allowOverwrite: false
    });
    await reloadProjectEntries();
    await openOrFocusFile(fallbackPath);
    await github.refreshTopbarBadge();
  }

  chat = initChatController({
    getContextSnapshot() {
      const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) ?? null : null;
      const otherOpenFiles = openTabIds
        .filter((id) => id !== activeFileId)
        .map((id) => filesOnly.find((f) => f.id === id))
        .filter((f) => Boolean(f) && f.contentLoaded !== false);

      return {
        activeFile,
        selection: activeSelection,
        otherOpenFiles
      };
    },
    async onInsertAtCursor(code, lang) {
      await ensureAnOpenFile(lang);
      editor.insertAtCursor(code, 0);
      layout.closeRightOnCompactAction();
    },
    async onReplaceSelection(code) {
      if (!activeSelection.lineCount) {
        return false;
      }
      await ensureAnOpenFile();
      editor.replaceSelection(code);
      layout.closeRightOnCompactAction();
      return true;
    },
    async onApplyWholeFile(code, lang) {
      await ensureAnOpenFile(lang);
      const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
      if (!activeFile) return;
      diffModal.openConfirmApplyDiff({
        fileName: activeFile.shortName,
        oldCode: activeFile.content,
        newCode: code,
        onConfirm() {
          editor.replaceEntireDocument(code);
          layout.closeRightOnCompactAction();
        }
      });
    },
    onConversationChange(history) {
      activeProject.chatHistory = history;
      void saveProjectChatHistory(activeProject.id, history);
    },
    onKeysImported() {
      void github.syncExplorerReposInBackground();
    }
  });

  const github = initGithubController({
    getActiveProject: () => activeProject,
    onFlushPendingSaves: flushPendingSaves,
    onOpenDiff({ title, oldCode, newCode }) {
      diffModal.openReadOnlyDiff({ title, oldCode, newCode });
    },
    onReposListChanged(remoteRepos) {
      explorer.renderProjects(projects, activeProject.id, remoteRepos);
    },
    async onProjectClonedOrSynced(projectId) {
      await flushPendingSaves();
      projects = await listProjects();
      await switchProject(projectId, true);
    }
  });

  // Atajo universal Cmd+S / Ctrl+S para forzar volcado inmediato a IndexedDB sin diálogo del navegador
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void (async () => {
        await flushPendingSaves();
        explorer.setAutosaveStatus("Guardado en IndexedDB");
      })();
    }
  });

  // Autoguardado inmediato si Safari en iPad suspende la app o cambia en Stage Manager
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingSaves();
    }
  });
  window.addEventListener("pagehide", () => {
    flushPendingSaves();
  });

  syncToolbarState();
  preventFocusSteal([btnUndo, btnRedo, btnFontDown, btnFontUp]);

  btnUndo?.addEventListener("click", () => editor.triggerUndo());
  btnRedo?.addEventListener("click", () => editor.triggerRedo());
  btnSearch?.addEventListener("click", () => editor.triggerSearch());
  btnWrap?.addEventListener("click", () => {
    const enabled = editor.toggleWordWrap();
    btnWrap.setAttribute("aria-pressed", String(enabled));
  });
  btnFontDown?.addEventListener("click", () => {
    const size = editor.stepFontSize(-1);
    if (zoomReadoutEl) zoomReadoutEl.textContent = `${size}px`;
  });
  btnFontUp?.addEventListener("click", () => {
    const size = editor.stepFontSize(1);
    if (zoomReadoutEl) zoomReadoutEl.textContent = `${size}px`;
  });

  function scheduleAutosave(projectId, filePath, content) {
    explorer.setAutosaveStatus("Guardando…");
    const timerKey = `${projectId}::${filePath}`;
    if (saveTimers.has(timerKey)) {
      window.clearTimeout(saveTimers.get(timerKey));
    }

    const timerId = window.setTimeout(async () => {
      saveTimers.delete(timerKey);
      await updateFileContent(projectId, filePath, content);
      explorer.setAutosaveStatus("Autoguardado en IndexedDB");
      await github.refreshTopbarBadge();
    }, 240);

    saveTimers.set(timerKey, timerId);
  }

  async function flushPendingSaves() {
    if (saveTimers.size === 0) return;
    for (const [timerKey, timerId] of saveTimers.entries()) {
      window.clearTimeout(timerId);
      saveTimers.delete(timerKey);
      const sep = timerKey.indexOf("::");
      const projId = timerKey.slice(0, sep);
      const path = timerKey.slice(sep + 2);
      const fileObj = filesOnly.find((f) => f.id === path);
      if (fileObj && projId === activeProject.id) {
        await updateFileContent(projId, path, fileObj.content);
      }
    }
    explorer.setAutosaveStatus("Autoguardado en IndexedDB");
  }

  async function switchProject(projectId, _forceClearCache = false) {
    const nextProj = await getProject(projectId);
    if (!nextProj) return;

    for (const f of filesOnly) {
      editor.dropFileState(f.id);
    }

    activeProject = nextProj;
    setSavedActiveProjectId(activeProject.id);
    projects = await listProjects();

    await reloadProjectEntries();

    const validPaths = new Set(filesOnly.map((f) => f.id));
    openTabIds = (activeProject.openTabIds || []).filter((id) => validPaths.has(id));
    const shouldAutoOpenFirst =
      openTabIds.length === 0 &&
      filesOnly.length > 0 &&
      (activeProject.kind !== "github" || Boolean(activeProject.offlineCached));
    if (shouldAutoOpenFirst) {
      openTabIds = [filesOnly[0].id];
    }
    activeFileId =
      activeProject.activeFileId && openTabIds.includes(activeProject.activeFileId)
        ? activeProject.activeFileId
        : openTabIds[0] || null;

    if (activeFileId) {
      const activeTarget = filesOnly.find((f) => f.id === activeFileId);
      if (activeTarget && activeTarget.contentLoaded === false) {
        try {
          await ensureFileContentLoaded(activeTarget);
        } catch {
          openTabIds = openTabIds.filter((id) => id !== activeFileId);
          activeFileId = openTabIds[0] || null;
        }
      }
    }

    explorer.renderProjects(projects, activeProject.id);
    chat.setConversation(activeProject.chatHistory || []);
    renderWorkspaceView();
    await github.refreshTopbarBadge();
  }

  async function reloadProjectEntries() {
    entries = await getProjectEntries(activeProject.id);
    filesOnly = entries
      .filter((e) => !e.isFolder)
      .map((e) => {
        const meta = inferFileMeta(e.path);
        const shortName = e.path.split("/").pop() || e.path;
        return {
          id: e.path,
          path: e.path,
          name: e.path,
          shortName,
          lang: meta.lang,
          badge: meta.badge,
          icon: meta.icon,
          content: e.content,
          baseContent: e.baseContent,
          blobSha: e.blobSha || null,
          contentLoaded: e.contentLoaded !== false,
          trackedInGithub: Boolean(e.trackedInGithub),
          forceModified: Boolean(e.forceModified)
        };
      });
  }

  function syncOfflineButtonState() {
    if (!activeProject || activeProject.kind !== "github") {
      explorer.setOfflineRepoState({ visible: false });
      return;
    }
    const pendingCount = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha).length;
    explorer.setOfflineRepoState({
      visible: true,
      isOfflineReady: pendingCount === 0,
      pendingCount,
      busy: false
    });
  }

  async function ensureFileContentLoaded(fileObj) {
    if (
      !fileObj ||
      fileObj.contentLoaded !== false ||
      activeProject.kind !== "github" ||
      !activeProject.github ||
      !fileObj.blobSha
    ) {
      return;
    }

    const content = await fetchSingleRepoBlob({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      blobSha: fileObj.blobSha
    });

    await cacheSingleGithubFileContent(activeProject.id, fileObj.path, content, fileObj.blobSha);
    fileObj.content = content;
    fileObj.baseContent = content;
    fileObj.contentLoaded = true;
    editor.dropFileState(fileObj.id);

    if (filesOnly.length > 0 && filesOnly.every((f) => f.contentLoaded !== false)) {
      activeProject.offlineCached = true;
      await markProjectOfflineCached(activeProject.id, true);
      projects = await listProjects();
      explorer.renderProjects(projects, activeProject.id);
    }
    syncOfflineButtonState();
  }

  async function ensureFilesLoaded(fileList, onProgress) {
    const unloaded = fileList.filter((f) => f && f.contentLoaded === false && f.blobSha);
    if (unloaded.length === 0 || activeProject.kind !== "github" || !activeProject.github) {
      return;
    }

    const loadedItems = await downloadBatchBlobs({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      items: unloaded.map((f) => ({ path: f.path, blobSha: f.blobSha })),
      onProgress
    });

    const byPath = new Map(loadedItems.map((item) => [item.path, item]));
    for (const fileObj of unloaded) {
      const hit = byPath.get(fileObj.path);
      if (!hit) continue;
      await cacheSingleGithubFileContent(
        activeProject.id,
        fileObj.path,
        hit.content,
        hit.blobSha || fileObj.blobSha
      );
      fileObj.content = hit.content;
      fileObj.baseContent = hit.content;
      fileObj.contentLoaded = true;
      editor.dropFileState(fileObj.id);
    }

    if (filesOnly.length > 0 && filesOnly.every((f) => f.contentLoaded !== false)) {
      activeProject.offlineCached = true;
      await markProjectOfflineCached(activeProject.id, true);
      projects = await listProjects();
      explorer.renderProjects(projects, activeProject.id);
    }
    syncOfflineButtonState();
  }

  async function persistTabsState() {
    activeProject.openTabIds = [...openTabIds];
    activeProject.activeFileId = activeFileId;
    await saveProjectState(activeProject);
  }

  async function openOrFocusFile(filePath) {
    const target = filesOnly.find((f) => f.id === filePath);
    if (!target) return;

    if (target.contentLoaded === false) {
      explorer.setAutosaveStatus(`Abriendo ${target.shortName}…`);
      try {
        await ensureFileContentLoaded(target);
        explorer.setAutosaveStatus("Archivo cargado desde GitHub");
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "Sin conexión para abrir este archivo de GitHub"
        );
        return;
      }
    }

    if (!openTabIds.includes(target.id)) {
      openTabIds.push(target.id);
    }
    activeFileId = target.id;
    await persistTabsState();
    renderWorkspaceView();
    layout.closeLeftOnCompactSelect();
  }

  async function closeTab(filePath) {
    const idx = openTabIds.indexOf(filePath);
    if (idx === -1) return;

    openTabIds.splice(idx, 1);
    if (activeFileId === filePath) {
      activeFileId = openTabIds.length > 0 ? openTabIds[Math.min(idx, openTabIds.length - 1)] : null;
    }
    await persistTabsState();
    renderWorkspaceView();
  }

  function renderWorkspaceView() {
    explorer.renderProjects(projects, activeProject.id);
    explorer.renderTree(entries, activeFileId);
    syncOfflineButtonState();
    renderTabs();

    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;

    if (activeFile) {
      if (emptyStateEl) emptyStateEl.hidden = true;
      if (editorMountEl) editorMountEl.hidden = false;
      editor.openFile(activeFile);
      symbolBar.setLanguage(activeFile.lang);
      setEditorToolbarDisabled(false);
    } else {
      editor.clearActiveFile();
      if (editorMountEl) editorMountEl.hidden = true;
      if (emptyStateEl) emptyStateEl.hidden = false;
      renderEmptyQuickList();
      setEditorToolbarDisabled(true);
    }

    updateAssistantContextLabel();
    updateStatusBar();
    chat.notifyWorkspaceChanged();
  }

  function renderTabs() {
    if (!tabStripEl) return;
    tabStripEl.innerHTML = "";

    for (const tabId of openTabIds) {
      const file = filesOnly.find((f) => f.id === tabId);
      if (!file) continue;

      const isActive = file.id === activeFileId;
      const dirty = isFileDirtyForProject(file);

      const wrapper = document.createElement("div");
      wrapper.className = isActive ? "editor-tab-item is-active" : "editor-tab-item";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.role = "tab";
      selectBtn.className = "editor-tab-trigger";
      selectBtn.title = file.path;
      selectBtn.setAttribute("aria-selected", String(isActive));
      selectBtn.innerHTML = `
        ${icon(file.icon)}
        <span>${escapeHtml(file.shortName)}</span>
        ${dirty ? '<span class="editor-tab-dirty" title="Modificado frente al repositorio" aria-label="Modificado"></span>' : ""}
      `;
      selectBtn.addEventListener("click", () => openOrFocusFile(file.id));

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "editor-tab-close";
      closeBtn.setAttribute("aria-label", `Cerrar pestaña ${file.shortName}`);
      closeBtn.innerHTML = icon("x");
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(file.id);
      });

      wrapper.append(selectBtn, closeBtn);
      tabStripEl.appendChild(wrapper);
    }
  }

  function renderEmptyQuickList() {
    if (!emptyQuickListEl) return;
    emptyQuickListEl.innerHTML = "";
    for (const file of filesOnly.slice(0, 6)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.innerHTML = `${icon(file.icon)}<span>${escapeHtml(file.shortName)}</span>`;
      btn.addEventListener("click", () => openOrFocusFile(file.id));
      emptyQuickListEl.appendChild(btn);
    }
  }

  function isFileDirtyForProject(file) {
    if (file.contentLoaded === false) {
      return false;
    }
    if (activeProject.kind === "github") {
      return (
        Boolean(file.forceModified) ||
        !file.trackedInGithub ||
        file.content !== file.baseContent
      );
    }
    return false;
  }

  function syncToolbarState() {
    if (btnWrap) {
      btnWrap.setAttribute("aria-pressed", String(editor.isWordWrapEnabled()));
    }
    if (zoomReadoutEl) {
      zoomReadoutEl.textContent = `${editor.getFontSize()}px`;
    }
  }

  function setEditorToolbarDisabled(disabled) {
    for (const el of [btnUndo, btnRedo, btnSearch, btnExportFile]) {
      if (el) el.disabled = disabled;
    }
  }

  function updateNetworkIndicator() {
    if (!statusNetworkEl) return;
    const isOnline = navigator.onLine !== false;
    statusNetworkEl.textContent = isOnline ? "En línea" : "Sin conexión";
    statusNetworkEl.classList.toggle("is-offline", !isOnline);
  }

  function updateStatusBar() {
    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!activeFile) {
      if (statusFilePathEl) statusFilePathEl.textContent = "Sin archivo abierto";
      if (statusFileLangEl) statusFileLangEl.textContent = "—";
      if (statusCursorPosEl) statusCursorPosEl.textContent = "—";
    } else {
      if (statusFilePathEl) statusFilePathEl.textContent = activeFile.path;
      if (statusFileLangEl) statusFileLangEl.textContent = activeFile.badge;
      const line = activeSelection.cursorLine || 1;
      const col = activeSelection.cursorCol || 1;
      const selSuffix =
        activeSelection.lineCount > 0 ? ` (${activeSelection.lineCount} sel.)` : "";
      if (statusCursorPosEl) {
        statusCursorPosEl.textContent = `Línea ${line}, Col ${col}${selSuffix}`;
      }
    }
    updateNetworkIndicator();
  }

  window.addEventListener("online", updateNetworkIndicator);
  window.addEventListener("offline", updateNetworkIndicator);

  function updateAssistantContextLabel() {
    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!activeFile) {
      if (contextStatusEl) contextStatusEl.textContent = "Sin archivo activo";
      if (contextFileEl) contextFileEl.textContent = "Ninguno";
      return;
    }

    if (activeSelection.lineCount > 0) {
      const label =
        activeSelection.lineCount === 1
          ? "1 línea seleccionada"
          : `${activeSelection.lineCount} líneas seleccionadas`;
      if (contextStatusEl) contextStatusEl.textContent = label;
    } else {
      if (contextStatusEl) contextStatusEl.textContent = "Leyendo archivo activo";
    }

    if (contextFileEl) {
      contextFileEl.textContent = activeFile.shortName;
    }
  }

  await switchProject(activeProject.id);
  void github.syncExplorerReposInBackground();
}

function defaultStarterTemplate(path) {
  const meta = inferFileMeta(path);
  switch (meta.lang) {
    case "cpp":
      return `#include <iostream>\n\nint main() {\n    return 0;\n}\n`;
    case "c":
      return `#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n`;
    case "html":
      return `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <title>Documento</title>\n</head>\n<body>\n\n</body>\n</html>\n`;
    case "python":
      return `def principal():\n    print("Hola desde Python en Studio IDE")\n\nif __name__ == "__main__":\n    principal()\n`;
    case "markdown":
      return `# Documento\n\n`;
    case "sql":
      return `SELECT 1;\n`;
    default:
      return "";
  }
}

function preventFocusSteal(buttons) {
  for (const btn of buttons) {
    btn?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
  }
}

function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const isLocalDev =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  if (isLocalDev) {
    // En servidor local de PC desactivamos cualquier Service Worker viejo para ver cambios al instante
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) {
        reg.unregister();
      }
    });
    if ("caches" in window) {
      caches.keys().then((keys) => {
        for (const k of keys) {
          if (k.startsWith("studio-ide-shell-")) {
            caches.delete(k);
          }
        }
      });
    }
    return;
  }

  if (window.location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .then((reg) => {
          reg.update().catch(() => {});
        })
        .catch(() => {
          // Silencioso en entornos sin soporte de SW
        });
    });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", initApp);
