import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const p = await import("../js/ai/providers.js");

function sseResponse(lines, status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const l of lines) ctrl.enqueue(enc.encode(l));
      ctrl.close();
    }
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("Bóveda de claves", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test("importKeysBundle acepta claves de proveedores y aliases del PAT; ignora valores no string", () => {
    const n = p.importKeysBundle(JSON.stringify({ gemini: " g1 ", groq: 42, mistral: "", github: "ghp_x", desconocido: "z" }));
    assert.equal(n, 2);
    assert.equal(p.getApiKey("gemini"), "g1");
    assert.equal(p.getApiKey("groq"), "");
    assert.equal(localStorage.getItem("ide.github.pat"), "ghp_x");
  });

  test("importKeysBundle con JSON inválido / null / array lanza error controlado", () => {
    assert.throws(() => p.importKeysBundle("{mal"));
    assert.throws(() => p.importKeysBundle("null"), /inválido/);
    assert.equal(p.importKeysBundle("[]"), 0);
  });

  test("export -> import ida y vuelta conserva todas las claves", () => {
    p.saveApiKey("gemini", "G");
    p.saveApiKey("openrouter", "O");
    localStorage.setItem("ide.github.pat", "P");
    const bundle = p.exportKeysBundle();
    localStorage.clear();
    assert.equal(p.importKeysBundle(bundle), 3);
    assert.equal(p.getApiKey("openrouter"), "O");
    assert.equal(localStorage.getItem("ide.github.pat"), "P");
  });

  test("cambiar a modo sesión migra claves, PAT y caché, y no deja copias en localStorage", () => {
    p.saveApiKey("groq", "K");
    localStorage.setItem("ide.github.pat", "P");
    p.setKeyStorageMode("session");
    assert.equal(sessionStorage.getItem("ide.ai.key.groq"), "K");
    assert.equal(localStorage.getItem("ide.ai.key.groq"), null);
    assert.equal(sessionStorage.getItem("ide.github.pat"), "P");
    assert.equal(localStorage.getItem("ide.github.pat"), null);
    p.setKeyStorageMode("local");
    assert.equal(localStorage.getItem("ide.ai.key.groq"), "K");
  });

  test("proveedor guardado inexistente vuelve a gemini; modelo Gemini no gratuito se corrige", () => {
    localStorage.setItem("ide.ai.provider", "github");
    assert.equal(p.getSavedProviderId(), "gemini");
    localStorage.setItem("ide.ai.model.gemini", "gemini-2.5-pro");
    assert.equal(p.getSavedModel("gemini"), p.AI_PROVIDERS.gemini.models[0].id);
  });
});

describe("Streaming SSE OpenAI-compatible", () => {
  test("ensambla deltas partidos en fragmentos arbitrarios, CRLF, comentarios y [DONE]", async () => {
    const payloads = ["Hola", " ñandú", " 😀", " fin"].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\r\n\r\n`);
    const raw = `: keep-alive\n\n${payloads.join("")}data: [DONE]\n\n`;
    // Partir en trozos de 7 bytes (corta caracteres multibyte y líneas)
    const bytes = new TextEncoder().encode(raw);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
      return new Response(body, { status: 200 });
    };
    let out = "";
    await p.streamAiCompletion({
      providerId: "groq", model: "llama-3.3-70b-versatile", apiKey: "k", systemPrompt: "s",
      history: [{ role: "user", content: "hi" }], onChunk: (t) => { out += t; }
    });
    assert.equal(out, "Hola ñandú 😀 fin");
  });

  test("error 401 no reintenta con otros modelos y propaga mensaje", async () => {
    let chatCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response("{}", { status: 401 });
      chatCalls += 1;
      return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
    };
    await assert.rejects(
      p.streamAiCompletion({ providerId: "mistral", model: "codestral-latest", apiKey: "bad", systemPrompt: "s", history: [{ role: "user", content: "x" }], onChunk() {} }),
      /Invalid API Key/
    );
    assert.equal(chatCalls, 1);
  });

  test("429 en el primer modelo cae al siguiente", async () => {
    const models = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/models")) return new Response("{}", { status: 500 });
      const m = JSON.parse(init.body).model;
      models.push(m);
      if (models.length === 1) return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
      return sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`]);
    };
    let out = "";
    await p.streamAiCompletion({ providerId: "groq", model: "llama-3.1-8b-instant", apiKey: "k2", systemPrompt: "s", history: [{ role: "user", content: "x" }], onChunk: (t) => { out += t; } });
    assert.equal(out, "ok");
    assert.equal(models.length, 2);
    assert.notEqual(models[0], models[1]);
  });

  test("[BUG-21] si el flujo ya emitió texto y luego falla, no se reintenta con otro modelo (sin texto duplicado)", async () => {
    let chatCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response("{}", { status: 500 });
      chatCalls += 1;
      const enc = new TextEncoder();
      let pulls = 0;
      const body = new ReadableStream({
        pull(c) {
          pulls += 1;
          if (pulls === 1) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "parcial" } }] })}\n\n`));
          } else {
            c.error(Object.assign(new Error("upstream overloaded"), { httpStatus: 503 }));
          }
        }
      }, { highWaterMark: 0 });
      return new Response(body, { status: 200 });
    };
    let out = "";
    await assert.rejects(
      p.streamAiCompletion({ providerId: "groq", model: "llama-3.1-8b-instant", apiKey: "k3", systemPrompt: "s", history: [{ role: "user", content: "x" }], onChunk: (t) => { out += t; } })
    );
    assert.equal(out, "parcial");
    assert.equal(chatCalls, 1);
  });

  test("[BUG-22] la clave de Gemini viaja en cabecera, nunca en la URL", async () => {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url: String(url), headers: init.headers || {} });
      if (String(url).endsWith("/models") || String(url).includes("/models?")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return sseResponse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hola" }] } }] })}\n\n`]);
    };
    let out = "";
    await p.streamAiCompletion({ providerId: "gemini", model: "gemini-2.5-flash", apiKey: "AIzaSECRETO", systemPrompt: "s", history: [{ role: "user", content: "x" }], onChunk: (t) => { out += t; } });
    assert.equal(out, "hola");
    for (const s of seen) {
      assert.ok(!s.url.includes("AIzaSECRETO"), `clave expuesta en URL: ${s.url}`);
    }
    assert.ok(seen.some((s) => s.headers["x-goog-api-key"] === "AIzaSECRETO"));
  });
});
