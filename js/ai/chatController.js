import { icon } from "../ui/icons.js";
import {
  AI_PROVIDERS,
  clearApiKey,
  exportKeysBundle,
  fetchLiveFreeModels,
  getApiKey,
  getKeyStorageMode,
  getSavedModel,
  getSavedProviderId,
  importKeysBundle,
  saveApiKey,
  saveModel,
  saveProviderId,
  setKeyStorageMode,
  streamAiCompletion
} from "./providers.js";

/**
 * Controlador del Asistente IA estilo Antigravity (depurado 100% para APIs gratuitas):
 * - Google Gemini Gratis (con respaldo automático si un modelo Flash está con alta demanda)
 * - Groq Gratis, GitHub Models Gratis, OpenRouter (:free) y Mistral/Codestral Gratis
 */
export function initChatController({
  getContextSnapshot,
  onInsertAtCursor,
  onReplaceSelection,
  onApplyWholeFile,
  onConversationChange,
  onKeysImported
}) {
  const settingsBtn = document.getElementById("btn-ai-settings");
  const clearChatBtn = document.getElementById("btn-ai-clear-chat");
  const settingsDrawer = document.getElementById("chat-settings-drawer");
  const currentModelLabel = document.getElementById("chat-current-model-label");
  const keyStatusBtn = document.getElementById("chat-key-status-btn");

  const providerSelect = document.getElementById("ai-provider-select");
  const modelSelect = document.getElementById("ai-model-select");
  const customModelInput = document.getElementById("ai-custom-model-input");
  const fetchModelsBtn = document.getElementById("ai-fetch-models-btn");
  const apiKeyInput = document.getElementById("ai-api-key-input");
  const toggleKeyVisBtn = document.getElementById("ai-toggle-key-vis");
  const clearKeyBtn = document.getElementById("ai-clear-key-btn");
  const providerHelpEl = document.getElementById("ai-provider-help");
  const modeLocalBtn = document.getElementById("ai-mode-local");
  const modeSessionBtn = document.getElementById("ai-mode-session");
  const exportKeysBtn = document.getElementById("ai-export-keys-btn");
  const importKeysBtn = document.getElementById("ai-import-keys-btn");
  const importKeysSlot = document.getElementById("ai-import-keys-slot");

  const extraTabsBar = document.getElementById("chat-extra-tabs");
  const streamContainer = document.getElementById("chat-stream");
  const scrollBody = document.getElementById("chat-scroll-body");
  const composerForm = document.getElementById("chat-composer-form");
  const promptInput = document.getElementById("chat-prompt-input");
  const submitBtn = document.getElementById("chat-submit-btn");

  let activeProviderId = getSavedProviderId();
  let activeModelId = getSavedModel(activeProviderId);
  let settingsOpen = false;
  let keyVisible = false;
  let abortController = null;
  let keySyncTimer = 0;
  let currentStreamStatus = "";

  /** @type {Set<string>} */
  const attachedTabIds = new Set();

  /** @type {Array<{ role: "user" | "assistant", content: string }>} */
  let conversation = [];

  populateProviderOptions();
  syncSettingsForm();
  renderConversation();
  void syncLiveModelsSilently(activeProviderId);

  async function syncLiveModelsSilently(providerId) {
    const provider = AI_PROVIDERS[providerId];
    if (!provider || !provider.supportsLiveModels) {
      return;
    }
    const key = getApiKey(providerId);
    if (!key && providerId !== "openrouter") {
      return;
    }
    try {
      const liveModels = await fetchLiveFreeModels(providerId, key);
      if (liveModels.length > 0) {
        provider.models = liveModels;
        if (activeProviderId === providerId) {
          const stillValid = liveModels.some((m) => m.id === activeModelId);
          if (!stillValid) {
            activeModelId = liveModels[0].id;
            saveModel(providerId, activeModelId);
          }
          syncSettingsForm();
        }
      }
    } catch {
      // Silencioso en segundo plano
    }
  }

  function toggleSettings(forceState) {
    settingsOpen = typeof forceState === "boolean" ? forceState : !settingsOpen;
    if (settingsDrawer) {
      settingsDrawer.hidden = !settingsOpen;
    }
    if (settingsBtn) {
      settingsBtn.setAttribute("aria-expanded", String(settingsOpen));
    }
  }

  settingsBtn?.addEventListener("click", () => toggleSettings());
  keyStatusBtn?.addEventListener("click", () => toggleSettings());

  clearChatBtn?.addEventListener("click", () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    conversation = [];
    renderConversation();
    onConversationChange?.([]);
  });

  providerSelect?.addEventListener("change", () => {
    activeProviderId = providerSelect.value;
    saveProviderId(activeProviderId);
    activeModelId = getSavedModel(activeProviderId);
    syncSettingsForm();
    void syncLiveModelsSilently(activeProviderId);
  });

  modelSelect?.addEventListener("change", () => {
    activeModelId = modelSelect.value;
    if (customModelInput) {
      customModelInput.value = activeModelId;
    }
    saveModel(activeProviderId, activeModelId);
    updateModelStrip();
  });

  customModelInput?.addEventListener("input", () => {
    const val = customModelInput.value.trim();
    if (val) {
      activeModelId = val;
      saveModel(activeProviderId, activeModelId);
      updateModelStrip();
    }
  });

  apiKeyInput?.addEventListener("input", () => {
    saveApiKey(activeProviderId, apiKeyInput.value);
    updateModelStrip();
    window.clearTimeout(keySyncTimer);
    if (apiKeyInput.value.trim().length >= 20) {
      const targetProvider = activeProviderId;
      keySyncTimer = window.setTimeout(() => {
        void syncLiveModelsSilently(targetProvider);
      }, 500);
    }
  });

  toggleKeyVisBtn?.addEventListener("click", () => {
    keyVisible = !keyVisible;
    if (apiKeyInput) {
      apiKeyInput.type = keyVisible ? "text" : "password";
    }
    toggleKeyVisBtn.innerHTML = icon(keyVisible ? "eyeOff" : "eye");
  });

  clearKeyBtn?.addEventListener("click", () => {
    clearApiKey(activeProviderId);
    if (apiKeyInput) {
      apiKeyInput.value = "";
    }
    updateModelStrip();
  });

  modeLocalBtn?.addEventListener("click", () => {
    setKeyStorageMode("local");
    syncStorageModeButtons();
  });

  modeSessionBtn?.addEventListener("click", () => {
    setKeyStorageMode("session");
    syncStorageModeButtons();
  });

  exportKeysBtn?.addEventListener("click", async () => {
    const bundle = exportKeysBundle();
    const ok = await copyToClipboardSafe(bundle);
    if (providerHelpEl) {
      providerHelpEl.textContent = ok
        ? "Pack de claves copiado al portapapeles. Podés mandártelo al iPad y tocar Importar pack."
        : "No se pudo acceder al portapapeles automáticamente.";
    }
  });

  importKeysBtn?.addEventListener("click", () => {
    if (!importKeysSlot) return;
    if (!importKeysSlot.hidden) {
      importKeysSlot.hidden = true;
      importKeysSlot.innerHTML = "";
      return;
    }
    importKeysSlot.hidden = false;
    importKeysSlot.innerHTML = "";

    const form = document.createElement("form");
    form.className = "inline-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.placeholder = '{"gemini":"AIza…","groq":"gsk_…"}';
    input.setAttribute("aria-label", "Pegar paquete de claves exportado");

    const okBtn = document.createElement("button");
    okBtn.type = "submit";
    okBtn.className = "tree-icon-btn";
    okBtn.setAttribute("aria-label", "Importar claves");
    okBtn.innerHTML = icon("check");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tree-icon-btn";
    closeBtn.setAttribute("aria-label", "Cancelar");
    closeBtn.innerHTML = icon("x");

    const close = () => {
      importKeysSlot.hidden = true;
      importKeysSlot.innerHTML = "";
    };

    closeBtn.addEventListener("click", close);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const count = importKeysBundle(input.value.trim());
        close();
        syncSettingsForm();
        onKeysImported?.();
        if (providerHelpEl) {
          providerHelpEl.textContent = `Se importaron ${count} clave(s) en este dispositivo.`;
        }
      } catch {
        if (providerHelpEl) {
          providerHelpEl.textContent = "El texto pegado no corresponde a un pack válido.";
        }
      }
    });

    form.append(input, okBtn, closeBtn);
    importKeysSlot.appendChild(form);
    input.focus();
  });

  fetchModelsBtn?.addEventListener("click", async () => {
    const provider = AI_PROVIDERS[activeProviderId];
    if (!provider) return;

    fetchModelsBtn.disabled = true;
    try {
      const liveModels = await fetchLiveFreeModels(provider.id, getApiKey(provider.id));
      if (liveModels.length > 0) {
        provider.models = liveModels;
        activeModelId = liveModels[0].id;
        saveModel(provider.id, activeModelId);
        syncSettingsForm();
        if (providerHelpEl) {
          providerHelpEl.textContent = `Lista actualizada (${liveModels.length} modelos gratuitos disponibles).`;
        }
      }
    } catch (error) {
      if (providerHelpEl) {
        providerHelpEl.textContent = error instanceof Error ? error.message : "Error al actualizar modelos.";
      }
    } finally {
      fetchModelsBtn.disabled = false;
    }
  });

  promptInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composerForm?.requestSubmit();
    }
  });

  composerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (abortController) {
      abortController.abort();
      abortController = null;
      setStreamingUiState(false);
      return;
    }

    const userText = (promptInput?.value || "").trim();
    if (!userText) {
      return;
    }

    const apiKey = getApiKey(activeProviderId);
    if (!apiKey) {
      toggleSettings(true);
      apiKeyInput?.focus();
      appendErrorBanner(
        `Falta la API Key gratuita para ${AI_PROVIDERS[activeProviderId].name}. Pegala arriba (queda guardada en este navegador).`
      );
      return;
    }

    if (promptInput) {
      promptInput.value = "";
    }

    await sendPrompt(userText, apiKey);
  });

  async function sendPrompt(userText, apiKey) {
    const snapshot = getContextSnapshot();
    const systemPrompt = buildSystemPrompt(snapshot);

    conversation.push({ role: "user", content: userText });
    const assistantEntry = { role: "assistant", content: "" };
    conversation.push(assistantEntry);

    renderConversation();
    scrollToBottom();

    abortController = new AbortController();
    currentStreamStatus = "";
    setStreamingUiState(true);

    let rafPending = false;
    const scheduleRender = () => {
      if (rafPending) return;
      rafPending = true;
      window.requestAnimationFrame(() => {
        rafPending = false;
        updateLastAssistantMessage(assistantEntry.content, true);
        scrollToBottom();
      });
    };

    try {
      await streamAiCompletion({
        providerId: activeProviderId,
        model: activeModelId,
        apiKey,
        systemPrompt,
        history: conversation.slice(0, -1),
        signal: abortController.signal,
        onModelsSynced(syncedProviderId, liveModels) {
          if (activeProviderId === syncedProviderId && Array.isArray(liveModels) && liveModels.length > 0) {
            const stillValid = liveModels.some((m) => m.id === activeModelId);
            if (!stillValid) {
              activeModelId = liveModels[0].id;
              saveModel(syncedProviderId, activeModelId);
            }
            syncSettingsForm();
          }
        },
        onFallbackNotice(noticeText) {
          currentStreamStatus = noticeText;
          if (providerHelpEl) {
            providerHelpEl.textContent = noticeText;
          }
          scheduleRender();
        },
        onChunk(delta) {
          currentStreamStatus = "";
          assistantEntry.content += delta;
          scheduleRender();
        }
      });

      updateLastAssistantMessage(assistantEntry.content || "Sin contenido devuelto por el modelo.", false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        assistantEntry.content += "\n\n*(Generación detenida)*";
        updateLastAssistantMessage(assistantEntry.content, false);
      } else {
        conversation.pop();
        renderConversation();
        appendErrorBanner(error instanceof Error ? error.message : "Error de red al conectar con el proveedor gratuito.");
      }
    } finally {
      currentStreamStatus = "";
      abortController = null;
      setStreamingUiState(false);
      onConversationChange?.(conversation.map((m) => ({ role: m.role, content: m.content })));
      scrollToBottom();
    }
  }

  function populateProviderOptions() {
    if (!providerSelect) return;
    providerSelect.innerHTML = "";
    for (const provider of Object.values(AI_PROVIDERS)) {
      const opt = document.createElement("option");
      opt.value = provider.id;
      opt.textContent = provider.name;
      providerSelect.appendChild(opt);
    }
    providerSelect.value = activeProviderId;
  }

  function syncSettingsForm() {
    const provider = AI_PROVIDERS[activeProviderId] ?? AI_PROVIDERS.gemini;

    if (providerSelect) {
      providerSelect.value = provider.id;
    }

    if (modelSelect) {
      modelSelect.innerHTML = "";
      for (const m of provider.models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
      const existsInPreset = provider.models.some((m) => m.id === activeModelId);
      if (!existsInPreset && activeModelId) {
        const customOpt = document.createElement("option");
        customOpt.value = activeModelId;
        customOpt.textContent = `${activeModelId} (Personalizado)`;
        modelSelect.appendChild(customOpt);
      }
      modelSelect.value = activeModelId;
    }

    if (customModelInput) {
      customModelInput.value = activeModelId;
    }

    if (fetchModelsBtn) {
      fetchModelsBtn.hidden = !provider.supportsLiveModels;
    }

    if (apiKeyInput) {
      apiKeyInput.placeholder = provider.keyPlaceholder;
      apiKeyInput.value = getApiKey(provider.id);
    }

    if (providerHelpEl) {
      providerHelpEl.textContent = provider.helpText;
    }

    syncStorageModeButtons();
    updateModelStrip();
  }

  function syncStorageModeButtons() {
    const mode = getKeyStorageMode();
    modeLocalBtn?.setAttribute("aria-pressed", String(mode === "local"));
    modeSessionBtn?.setAttribute("aria-pressed", String(mode === "session"));
  }

  function updateModelStrip() {
    const provider = AI_PROVIDERS[activeProviderId] ?? AI_PROVIDERS.gemini;
    const hasKey = Boolean(getApiKey(provider.id));

    if (currentModelLabel) {
      currentModelLabel.textContent = `${provider.name}: ${activeModelId}`;
    }

    if (keyStatusBtn) {
      keyStatusBtn.classList.toggle("has-key", hasKey);
      keyStatusBtn.innerHTML = `${icon("key")}<span>${hasKey ? "Clave lista" : "Falta clave"}</span>`;
    }
  }

  function setStreamingUiState(streaming) {
    if (!submitBtn) return;
    if (streaming) {
      submitBtn.setAttribute("aria-label", "Detener respuesta");
      submitBtn.title = "Detener respuesta";
      submitBtn.innerHTML = icon("square");
    } else {
      submitBtn.setAttribute("aria-label", "Enviar consulta");
      submitBtn.title = "Enviar consulta";
      submitBtn.innerHTML = icon("send");
    }
  }

  function renderExtraTabChips() {
    if (!extraTabsBar) return;
    const { otherOpenFiles } = getContextSnapshot();

    const validIds = new Set(otherOpenFiles.map((f) => f.id));
    for (const id of [...attachedTabIds]) {
      if (!validIds.has(id)) {
        attachedTabIds.delete(id);
      }
    }

    if (otherOpenFiles.length === 0) {
      extraTabsBar.hidden = true;
      return;
    }

    extraTabsBar.hidden = false;
    extraTabsBar.innerHTML = `<span class="chat-extra-label">Sumar pestaña:</span>`;

    for (const file of otherOpenFiles) {
      const attached = attachedTabIds.has(file.id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "context-chip";
      chip.setAttribute("aria-pressed", String(attached));
      chip.innerHTML = `${icon(attached ? "check" : "plus")}<span>${escapeHtml(file.shortName || file.name)}</span>`;
      chip.addEventListener("click", () => {
        if (attachedTabIds.has(file.id)) {
          attachedTabIds.delete(file.id);
        } else {
          attachedTabIds.add(file.id);
        }
        renderExtraTabChips();
      });
      extraTabsBar.appendChild(chip);
    }
  }

  function renderConversation() {
    if (!streamContainer) return;
    streamContainer.innerHTML = "";

    if (conversation.length === 0) {
      const welcome = document.createElement("div");
      welcome.className = "chat-empty-welcome";
      welcome.innerHTML = `
        <div class="chat-empty-title">Asistente contextual listo</div>
        <p>Configurado exclusivamente con proveedores y modelos gratuitos. Leo automáticamente el archivo abierto en el centro y las líneas que selecciones.</p>
        <div class="chat-quick-prompts">
          <button type="button" class="btn btn-sm" data-quick-prompt="Revisá este archivo y sugerí mejoras concretas.">Revisar archivo</button>
          <button type="button" class="btn btn-sm" data-quick-prompt="Explicame paso a paso cómo funciona este código.">Explicar código</button>
        </div>
      `;
      welcome.querySelectorAll("[data-quick-prompt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const text = btn.getAttribute("data-quick-prompt") || "";
          if (promptInput) {
            promptInput.value = text;
            composerForm?.requestSubmit();
          }
        });
      });
      streamContainer.appendChild(welcome);
      return;
    }

    conversation.forEach((msg, index) => {
      if (msg.role === "user") {
        const capsule = document.createElement("div");
        capsule.className = "chat-user-capsule";
        capsule.textContent = msg.content;
        streamContainer.appendChild(capsule);
      } else {
        const aiNode = document.createElement("div");
        aiNode.className = "chat-ai-response";
        aiNode.dataset.assistantIndex = String(index);
        populateAssistantNode(aiNode, msg.content, false);
        streamContainer.appendChild(aiNode);
      }
    });
  }

  function updateLastAssistantMessage(markdownText, isStreaming) {
    if (!streamContainer) return;
    const nodes = streamContainer.querySelectorAll(".chat-ai-response");
    const lastNode = nodes[nodes.length - 1];
    if (lastNode instanceof HTMLElement) {
      populateAssistantNode(lastNode, markdownText, isStreaming);
    }
  }

  function populateAssistantNode(container, markdownText, isStreaming) {
    const segments = parseMarkdownSegments(markdownText);
    container.innerHTML = "";

    if (segments.length === 0 && isStreaming) {
      const waiting = document.createElement("p");
      waiting.className = "chat-streaming-note";
      waiting.textContent = currentStreamStatus || "Generando respuesta…";
      container.appendChild(waiting);
      return;
    }

    for (const seg of segments) {
      if (seg.type === "prose") {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = formatProseHtml(seg.content);
        while (wrapper.firstChild) {
          container.appendChild(wrapper.firstChild);
        }
      } else {
        container.appendChild(buildCodeBlockElement(seg.lang, seg.code));
      }
    }

    if (isStreaming) {
      const indicator = document.createElement("span");
      indicator.className = "chat-streaming-note";
      indicator.textContent = "Escribiendo…";
      container.appendChild(indicator);
    }
  }

  function buildCodeBlockElement(lang, code) {
    const block = document.createElement("div");
    block.className = "chat-code-block";

    const header = document.createElement("div");
    header.className = "chat-code-header-wrap";

    const langSpan = document.createElement("span");
    langSpan.className = "code-font";
    langSpan.textContent = lang || "código";

    const actions = document.createElement("div");
    actions.className = "chat-code-actions-wrap";

    const btnInsert = createCodeActionButton("arrowDownLeft", "En cursor", "Insertar en la posición del cursor", async () => {
      await onInsertAtCursor(code, lang);
      btnInsert.innerHTML = `${icon("check")}<span>Insertado</span>`;
      window.setTimeout(() => {
        btnInsert.innerHTML = `${icon("arrowDownLeft")}<span>En cursor</span>`;
      }, 1300);
    });

    const hasSelNow = Boolean(getContextSnapshot().selection?.lineCount > 0);
    const btnReplace = createCodeActionButton(
      "replace",
      "Reemplazar sel.",
      hasSelNow
        ? "Reemplazar las líneas seleccionadas"
        : "Seleccioná líneas en el editor para habilitar el reemplazo",
      async () => {
        const applied = await onReplaceSelection(code);
        if (applied !== false) {
          btnReplace.innerHTML = `${icon("check")}<span>Reemplazado</span>`;
          window.setTimeout(() => {
            btnReplace.innerHTML = `${icon("replace")}<span>Reemplazar sel.</span>`;
          }, 1300);
        }
      }
    );
    btnReplace.dataset.action = "replace-selection";
    btnReplace.disabled = !hasSelNow;

    const btnApplyFile = createCodeActionButton("fileCheck", "Aplicar archivo", "Reemplazar contenido completo del archivo (reversible con Deshacer)", () => {
      onApplyWholeFile(code, lang);
    });

    const btnCopy = createCodeActionButton("copy", "Copiar", "Copiar bloque al portapapeles", async () => {
      const copied = await copyToClipboardSafe(code);
      btnCopy.innerHTML = copied
        ? `${icon("check")}<span>Copiado</span>`
        : `${icon("x")}<span>Sin acceso</span>`;
      window.setTimeout(() => {
        btnCopy.innerHTML = `${icon("copy")}<span>Copiar</span>`;
      }, 1400);
    });

    actions.append(btnInsert, btnReplace, btnApplyFile, btnCopy);
    header.append(langSpan, actions);

    const pre = document.createElement("pre");
    pre.className = "chat-code-pre code-font";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    block.append(header, pre);
    return block;
  }

  function createCodeActionButton(iconName, label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm";
    btn.title = title;
    btn.innerHTML = `${icon(iconName)}<span>${label}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function appendErrorBanner(message) {
    if (!streamContainer) return;
    const banner = document.createElement("div");
    banner.className = "chat-error-banner";
    banner.setAttribute("role", "alert");
    banner.textContent = message;
    streamContainer.appendChild(banner);
    scrollToBottom();
  }

  function scrollToBottom() {
    if (scrollBody) {
      scrollBody.scrollTop = scrollBody.scrollHeight;
    }
  }

  function buildSystemPrompt(snapshot) {
    const parts = [
      "Sos el asistente de programación integrado en Studio IDE (estilo Antigravity).",
      "Respondé en español claro, directo y técnico. Cuando propongas código, encerralo siempre en bloques Markdown con su lenguaje (por ejemplo ```python, ```cpp, ```html, ```css, ```js, ```sql, ```markdown) para que el usuario pueda inyectarlo directamente en el editor con un toque desde su iPad."
    ];

    if (snapshot.activeFile) {
      parts.push(
        `\n--- ARCHIVO ACTIVO EN EL EDITOR: ${snapshot.activeFile.name} (${snapshot.activeFile.lang}) ---\n\`\`\`${snapshot.activeFile.lang}\n${snapshot.activeFile.content}\n\`\`\``
      );
    }

    if (snapshot.selection.text) {
      parts.push(
        `\n--- FRAGMENTO SELECCIONADO POR EL USUARIO (${snapshot.selection.lineCount} líneas) ---\n\`\`\`\n${snapshot.selection.text}\n\`\`\``
      );
    }

    const attachedFiles = snapshot.otherOpenFiles.filter((f) => attachedTabIds.has(f.id));
    for (const extra of attachedFiles) {
      parts.push(
        `\n--- PESTAÑA ADJUNTA DE REFERENCIA: ${extra.name} (${extra.lang}) ---\n\`\`\`${extra.lang}\n${extra.content}\n\`\`\``
      );
    }

    return parts.join("\n");
  }

  function syncReplaceButtonsState() {
    if (!streamContainer) return;
    const hasSel = Boolean(getContextSnapshot().selection?.lineCount > 0);
    const buttons = streamContainer.querySelectorAll('button[data-action="replace-selection"]');
    for (const btn of buttons) {
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = !hasSel;
        btn.title = hasSel
          ? "Reemplazar las líneas seleccionadas"
          : "Seleccioná líneas en el editor para habilitar el reemplazo";
      }
    }
  }

  return {
    notifyWorkspaceChanged() {
      renderExtraTabChips();
      syncReplaceButtonsState();
    },
    notifySelectionChanged() {
      syncReplaceButtonsState();
    },
    setConversation(nextHistory) {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      conversation = Array.isArray(nextHistory)
        ? nextHistory
            .filter(
              (item) =>
                item &&
                (item.role === "user" || item.role === "assistant") &&
                typeof item.content === "string"
            )
            .map((item) => ({ role: item.role, content: item.content }))
        : [];
      renderConversation();
      scrollToBottom();
    }
  };
}

function parseMarkdownSegments(raw) {
  const segments = [];
  const fenceRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const prose = raw.slice(lastIndex, match.index).trim();
      if (prose) {
        segments.push({ type: "prose", content: prose });
      }
    }
    segments.push({
      type: "code",
      lang: (match[1] || "").trim(),
      code: (match[2] || "").replace(/\n$/, "")
    });
    lastIndex = fenceRegex.lastIndex;
    if (!raw.slice(match.index).includes("```", 3)) {
      break;
    }
  }

  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex).trim();
    if (tail) {
      segments.push({ type: "prose", content: tail });
    }
  }

  return segments;
}

function formatProseHtml(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let paragraphLines = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.map(formatInlineMarkdown).join("<br>")}</p>`);
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listType && listItems.length > 0) {
      out.push(`<${listType}>${listItems.join("")}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const hrMatch = trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/);
    if (hrMatch) {
      flushParagraph();
      flushList();
      out.push('<hr class="chat-md-hr">');
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      out.push(`<h3 class="chat-md-heading">${formatInlineMarkdown(headingMatch[2])}</h3>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      out.push(`<blockquote class="chat-md-quote">${formatInlineMarkdown(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = rawLine.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    paragraphLines.push(rawLine);
  }

  flushParagraph();
  flushList();
  return out.join("");
}

function formatInlineMarkdown(str) {
  const codeTokens = [];
  const withPlaceholders = String(str).replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code class="chat-inline-code">${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  let safe = escapeHtml(withPlaceholders);
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  safe = safe.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || "");
  return safe;
}

async function copyToClipboardSafe(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Respaldo con textarea temporal
    }
  }
  try {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.setAttribute("readonly", "");
    temp.style.position = "fixed";
    temp.style.opacity = "0";
    temp.style.pointerEvents = "none";
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand("copy");
    temp.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
