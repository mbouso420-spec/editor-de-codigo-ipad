// Entorno mínimo de navegador para ejecutar los módulos ES de la app en Node.
import "fake-indexeddb/auto";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.window = globalThis;
if (typeof globalThis.window.addEventListener !== "function") globalThis.window.addEventListener = () => {};
if (typeof globalThis.window.removeEventListener !== "function") globalThis.window.removeEventListener = () => {};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
if (!globalThis.navigator) globalThis.navigator = {};

class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.classList = {
      _classes: new Set(),
      add: (c) => this.classList._classes.add(c),
      remove: (c) => this.classList._classes.delete(c),
      contains: (c) => this.classList._classes.has(c),
      toggle: (c, val) => {
        if (val === undefined) val = !this.classList.contains(c);
        if (val) this.classList.add(c); else this.classList.remove(c);
        return val;
      }
    };
    this.attributes = new Map();
    this.style = {
      setProperty: (k, v) => { this.style[k] = String(v); },
      removeProperty: (k) => { delete this.style[k]; },
      getPropertyValue: (k) => this.style[k] || ""
    };
    this.value = "";
    this._innerHTML = "";
    this._textContent = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  get className() {
    return Array.from(this.classList._classes).join(" ");
  }
  set className(v) {
    this.classList._classes.clear();
    String(v || "").trim().split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach(c => this.appendChild(c)); }
  removeChild(child) { const i = this.children.indexOf(child); if (i !== -1) this.children.splice(i, 1); return child; }
  contains(child) { return this.children.includes(child); }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) || null; }
  setRangeText(text, start, end) {
    const s = start !== undefined ? start : (this.selectionStart || 0);
    const e = end !== undefined ? end : (this.selectionEnd || 0);
    this.value = this.value.slice(0, s) + text + this.value.slice(e);
  }
  setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
  focus() {}
  querySelector(sel) {
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      if (this.classList.contains(cls)) return this;
      for (const ch of this.children) {
        if (ch instanceof MockElement) {
          const res = ch.querySelector(sel);
          if (res) return res;
        }
      }
    }
    return null;
  }
  querySelectorAll(sel) {
    const list = [];
    if (sel === "iframe" && this.tagName === "IFRAME") list.push(this);
    for (const ch of this.children) {
      if (ch instanceof MockElement) list.push(...ch.querySelectorAll(sel));
    }
    return list;
  }
}

const htmlElement = new MockElement("html");
const bodyElement = new MockElement("body");
htmlElement.appendChild(bodyElement);

globalThis.document = {
  documentElement: htmlElement,
  body: bodyElement,
  createElement: (tag) => new MockElement(tag),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => []
};

/** Generador pseudoaleatorio reproducible (mulberry32) para fuzzing determinista. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
