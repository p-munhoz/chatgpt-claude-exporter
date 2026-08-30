/* global CCE */
/*
 * Isolated content script. Owns the whole export so it keeps running after
 * the popup closes, and works the same in Firefox and Chrome:
 *   - relays the extract request to the MAIN-world script (content-main.js)
 *   - builds the files with CCE (JSZip / marked are bundled alongside)
 *   - saves them with an <a download> click (needs no downloads permission)
 *   - shows an in-page toast + relays progress to the popup if it is open
 */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const REQ = "cce-extract-request";
  const RES = "cce-extract-response";

  console.log("[exporter] content-export loaded on", location.href);

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== "export") return;
    doExport(msg).catch((e) => {
      const t = "Export failed: " + ((e && e.message) || e);
      progress(t, true, true);
      toast(t, true);
    });
    // deliberately no async response — popup only needs to know the message landed
  });

  function progress(text, done, isError) {
    console.log("[exporter]", text);
    Promise.resolve(api.runtime.sendMessage({ type: "progress", text, done: !!done, error: !!isError })).catch(
      () => {}
    );
  }

  function extractViaMain(options) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("Timed out reading the conversation."));
      }, 120000);
      const handler = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.tag !== RES || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        if (d.ok) resolve(d.conv);
        else reject(new Error(d.error || "extraction failed"));
      };
      window.addEventListener("message", handler);
      window.postMessage({ tag: REQ, id, options }, "*");
    });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fmtBytes = (n) =>
    n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB";

  async function doExport({ formats, options }) {
    progress("Reading conversation…");
    const conv = await extractViaMain(options || {});
    if (!conv || !conv.messages || !conv.messages.length)
      throw new Error("No messages found in this conversation.");

    const base = CCE.baseName(conv);
    for (const fmt of formats) {
      progress("Building " + fmt.toUpperCase() + "…");
      let blob, name;
      if (fmt === "json") {
        blob = new Blob([CCE.toJson(conv)], { type: "application/json" });
        name = base + ".json";
      } else if (fmt === "txt") {
        blob = new Blob([CCE.toTxt(conv)], { type: "text/plain" });
        name = base + ".txt";
      } else if (fmt === "html") {
        blob = new Blob([CCE.toHtml(conv)], { type: "text/html" });
        name = base + ".html";
      } else if (fmt === "md") {
        if (conv.messages.some((m) => m.images.length)) {
          blob = await CCE.toMarkdownZip(conv);
          name = base + ".zip";
        } else {
          blob = new Blob([CCE.toMarkdown(conv)], { type: "text/markdown" });
          name = base + ".md";
        }
      } else {
        continue;
      }
      triggerDownload(blob, name);
      await sleep(400); // space out downloads; Chrome asks once about multiple files
    }

    const imgs = conv.messages.flatMap((m) => m.images);
    const bytes = imgs.reduce((n, i) => n + (i.bytes || 0), 0);
    const orig = imgs.reduce((n, i) => n + (i.originalBytes || i.bytes || 0), 0);
    const imgNote = imgs.length
      ? `, ${imgs.length} image(s) ${fmtBytes(bytes)}` +
        (orig > bytes + 1024 ? ` (from ${fmtBytes(orig)})` : "")
      : options && options.images === false
      ? ", images skipped"
      : ", no images";
    const warn = (conv.warnings || []).join("; ");
    const summary = `${conv.messages.length} messages${imgNote}`;
    progress("Done — " + summary + (warn ? " ⚠ " + warn : ""), true, !!warn);
    toast("Export complete — " + summary + (warn ? "\n⚠ " + warn : ""), !!warn);
  }

  let toastEl;
  function toast(text, isError) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed",
        zIndex: "2147483647",
        right: "16px",
        bottom: "16px",
        maxWidth: "360px",
        padding: "12px 14px",
        borderRadius: "10px",
        font: "13px/1.4 system-ui, -apple-system, sans-serif",
        color: "#fff",
        boxShadow: "0 6px 24px rgba(0,0,0,.3)",
        whiteSpace: "pre-wrap",
        transition: "opacity .4s",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = isError ? "#c0392b" : "#10a37f";
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl && (toastEl.style.opacity = "0"), 6000);
  }
})();
