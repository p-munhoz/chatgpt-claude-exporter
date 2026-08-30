const api = globalThis.browser ?? globalThis.chrome;

const $ = (s) => document.querySelector(s);
const contextEl = $("#context");
const statusEl = $("#status");
const exportBtn = $("#export");

const SITES = /^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai)\//;

let activeTab = null;

function setStatus(msg, kind) {
  console.log("[exporter] status:", msg);
  statusEl.textContent = msg;
  statusEl.className = kind || "muted";
}

window.addEventListener("error", (e) => setStatus("Popup script error: " + e.message, "error"));

$("#opt-images").addEventListener("change", (e) => {
  $("#opt-compress").disabled = !e.target.checked;
});

/* ---- remember last-used settings ---- */

const SETTINGS_KEY = "settings";

function currentSettings() {
  return {
    formats: [...document.querySelectorAll("#formats input:checked")].map((i) => i.value),
    images: $("#opt-images").checked,
    compress: $("#opt-compress").value,
  };
}

async function loadSettings() {
  try {
    const { [SETTINGS_KEY]: s } = await api.storage.local.get(SETTINGS_KEY);
    if (!s) return;
    if (Array.isArray(s.formats)) {
      document.querySelectorAll("#formats input").forEach((i) => {
        i.checked = s.formats.includes(i.value);
      });
    }
    if (typeof s.images === "boolean") $("#opt-images").checked = s.images;
    if (typeof s.compress === "string") $("#opt-compress").value = s.compress;
    $("#opt-compress").disabled = !$("#opt-images").checked;
  } catch (e) {
    console.warn("[exporter] could not load settings:", e);
  }
}

function saveSettings() {
  Promise.resolve(api.storage.local.set({ [SETTINGS_KEY]: currentSettings() })).catch(() => {});
}

document
  .querySelectorAll("#formats input, #imgopts input, #imgopts select")
  .forEach((el) => el.addEventListener("change", saveSettings));

/* ---- progress relayed from the content-script export ---- */

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "progress") return;
  setStatus(msg.text, msg.error ? "error" : msg.done ? "ok" : "muted");
  if (msg.done) exportBtn.disabled = false;
});

async function init() {
  try {
    await loadSettings();
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;
    console.log("[exporter] active tab:", tab && tab.url);
    if (!tab || !SITES.test(tab.url || "")) {
      contextEl.textContent =
        "Open a ChatGPT or Claude conversation, then click this button." +
        (tab && tab.url ? "\n(current tab: " + tab.url + ")" : "");
      return;
    }
    const site = tab.url.includes("claude.ai") ? "Claude" : "ChatGPT";
    contextEl.textContent = `Ready to export this ${site} conversation.`;
    exportBtn.disabled = false;
  } catch (e) {
    setStatus("init failed: " + ((e && e.message) || e), "error");
  }
}

async function run() {
  const formats = [...document.querySelectorAll("#formats input:checked")].map((i) => i.value);
  if (!formats.length) return setStatus("Pick at least one format.", "error");

  const options = {
    images: $("#opt-images").checked,
    compress: $("#opt-compress").value, // "off" | "light" | "medium" | "strong"
  };

  exportBtn.disabled = true;
  setStatus("Starting…");
  try {
    await api.tabs.sendMessage(activeTab.id, { action: "export", formats, options });
    setStatus("Export started — safe to close this popup.");
  } catch (e) {
    exportBtn.disabled = false;
    setStatus(
      "Could not reach the page. Hard-reload the ChatGPT/Claude tab (Ctrl/Cmd-Shift-R) and retry.",
      "error"
    );
  }
}

exportBtn.addEventListener("click", run);
console.log("[exporter] popup loaded");
init();
