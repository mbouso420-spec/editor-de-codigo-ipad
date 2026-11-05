import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "docs", "screenshots");

const puppeteerModulePath = path.join(ROOT_DIR, "tests", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const { default: puppeteer } = await import(pathToFileURL(puppeteerModulePath).href);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

// 1. Static HTTP Server
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  let filePath = path.join(ROOT_DIR, urlPath === "/" ? "index.html" : urlPath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(8088, "127.0.0.1", resolve));
console.log("Local HTTP server running at http://127.0.0.1:8088");

// Detect Chrome or Edge
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const executablePath = fs.existsSync(chromePath) ? chromePath : edgePath;

console.log("Launching browser from:", executablePath);

const tempUserDataDir = path.join(ROOT_DIR, "scripts", `chrome_ud_${Date.now()}`);
fs.mkdirSync(tempUserDataDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: tempUserDataDir,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1280,820"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });

  console.log("Navigating to Studio IDE...");
  await page.goto("http://127.0.0.1:8088/index.html", { waitUntil: "networkidle0", timeout: 15000 });
  
  // Wait for workspace and editor to initialize
  await page.waitForSelector(".ide-workspace", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Ensure screenshots directory exists
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  // 1. CAPTURE MAIN OVERVIEW
  console.log("Capturing 01-studio-ide-overview.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "01-studio-ide-overview.png") });

  // 2. CAPTURE LIVE PREVIEW (WEB)
  console.log("Opening web preview...");
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".tree-label, .tree-item, .tab-item, span"));
    const htmlFile = items.find((el) => (el.textContent || "").trim().endsWith(".html"));
    if (htmlFile) htmlFile.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  await page.click("#btn-live-preview");
  await page.waitForSelector("#preview-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("Capturing 02-live-preview-responsive.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "02-live-preview-responsive.png") });

  // Close preview dialog
  await page.click("#btn-close-preview");
  await new Promise((r) => setTimeout(r, 800));

  // 3. CAPTURE C/C++ RUNNER PREVIEW
  console.log("Opening C/C++ runner preview...");
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".tree-label, .tree-item, .tab-item, span"));
    const cppFile = items.find((el) => (el.textContent || "").trim().endsWith(".cpp") || (el.textContent || "").trim().endsWith(".c"));
    if (cppFile) cppFile.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  await page.click("#btn-live-preview");
  await page.waitForSelector("#preview-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("Capturing 03-c-runner-interactive.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "03-c-runner-interactive.png") });

  // Close preview dialog
  await page.click("#btn-close-preview");
  await new Promise((r) => setTimeout(r, 800));

  // 4. CAPTURE AI ASSISTANT IN ACTION
  console.log("Preparing AI Assistant chat panel...");
  await page.evaluate(() => {
    const chatInput = document.getElementById("chat-input");
    if (chatInput) {
      chatInput.value = "¿Podrías optimizar este código en C++ para que use memoria dinámica eficientemente?";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 800));

  console.log("Capturing 04-ai-assistant.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "04-ai-assistant.png") });

  // 5. CAPTURE GITHUB DIALOG
  console.log("Opening GitHub dialog...");
  await page.click("#btn-open-github");
  await page.waitForSelector("#github-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 1200));

  console.log("Capturing 05-github-branches-sync.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "05-github-branches-sync.png") });

  await page.click("#btn-close-github");
  await new Promise((r) => setTimeout(r, 800));

  // 6. CAPTURE QUICK OPEN PALETTE (Cmd+P)
  console.log("Opening Quick Open palette...");
  await page.evaluate(() => {
    const dlg = document.getElementById("quick-open-dialog");
    const input = document.getElementById("quick-open-input");
    if (dlg) {
      dlg.showModal();
      if (input) {
        input.value = ":15";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  });
  await new Promise((r) => setTimeout(r, 800));

  console.log("Capturing 06-quick-open.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "06-quick-open.png") });

  console.log("All real browser screenshots captured successfully!");
} catch (err) {
  console.error("Error capturing screenshots:", err);
} finally {
  await browser.close();
  server.close();
  try {
    fs.rmSync(tempUserDataDir, { recursive: true, force: true });
  } catch {}
}
