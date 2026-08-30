/*
 * Runs in the PAGE's JavaScript world (world: "MAIN"), so fetch() here is a
 * genuine first-party request carrying the site's own cookies / session.
 * It talks to the isolated bridge script only through window.postMessage.
 */
(() => {
  const REQ = "cce-extract-request";
  const RES = "cce-extract-response";

  console.log("[exporter] content-main (page world) loaded on", location.href);

  let OPTS = { images: true, compress: "medium" };

  const COMPRESS_LEVELS = {
    off: null,
    light: { max: 2048, quality: 0.82 },
    medium: { max: 1600, quality: 0.7 },
    strong: { max: 1200, quality: 0.55 },
  };

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.tag !== REQ) return;
    OPTS = Object.assign({ images: true, compress: "medium" }, d.options || {});
    if (OPTS.compress === true) OPTS.compress = "medium";
    if (OPTS.compress === false) OPTS.compress = "off";
    console.log("[exporter] content-main extracting…", OPTS);
    try {
      WARNINGS.length = 0;
      const conv = await extract();
      conv.warnings = WARNINGS.slice();
      console.log("[exporter] extracted:", conv);
      window.postMessage({ tag: RES, id: d.id, ok: true, conv }, "*");
    } catch (e) {
      window.postMessage({ tag: RES, id: d.id, ok: false, error: String((e && e.message) || e) }, "*");
    }
  });

  function extract() {
    const h = location.hostname;
    if (h.includes("claude.ai")) return extractClaude();
    if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) return extractChatGPT();
    throw new Error("This page is not ChatGPT or Claude.");
  }

  /* ---------- helpers ---------- */

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function extFromMime(mime) {
    return ((mime || "").split("/")[1] || "png").split("+")[0].split(";")[0] || "png";
  }

  const WARNINGS = [];

  async function encodeCanvas(canvas, type, quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((res) => canvas.toBlob(res, type, quality));
  }

  async function compressBlob(blob) {
    const cfg = COMPRESS_LEVELS[OPTS.compress];
    if (!cfg) return blob;
    const t = blob.type || "";
    if (!t.startsWith("image/") || t === "image/gif" || t === "image/svg+xml") return blob;
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, cfg.max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));

      let canvas;
      if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
      else {
        canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();

      let out = await encodeCanvas(canvas, "image/webp", cfg.quality);
      if (!out || out.type !== "image/webp") {
        // browser refused webp — fall back to jpeg
        out = await encodeCanvas(canvas, "image/jpeg", cfg.quality);
      }
      if (!out) throw new Error("encoder returned null");

      const kept = out.size < blob.size ? out : blob;
      console.log(
        `[exporter] ${t} ${(blob.size / 1024) | 0}KB @${bmp.width}x${bmp.height} -> ` +
          `${out.type} ${(out.size / 1024) | 0}KB @${w}x${h}` +
          (kept === blob ? " (original was smaller, kept)" : "")
      );
      return kept;
    } catch (e) {
      const m = "image compression failed (" + ((e && e.message) || e) + ") — originals kept";
      console.warn("[exporter] " + m);
      if (!WARNINGS.includes(m)) WARNINGS.push(m);
      return blob;
    }
  }

  async function fetchImage(url, name) {
    if (!OPTS.images) return null;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const raw = await res.blob();
    if (!raw || raw.size === 0) return null;
    const blob = await compressBlob(raw);
    const mime = blob.type || "image/png";
    return {
      name: name || "image",
      mime,
      ext: extFromMime(mime),
      dataUrl: await blobToDataUrl(blob),
      bytes: blob.size,
      originalBytes: raw.size,
    };
  }

  /* ---------- ChatGPT ---------- */

  async function extractChatGPT() {
    const m =
      location.pathname.match(/\/c\/([0-9a-f-]{36})/i) ||
      location.pathname.match(/\/g\/[^/]+\/c\/([0-9a-f-]{36})/i);
    if (!m) throw new Error("Open a saved ChatGPT conversation first (the URL should contain /c/<id>).");
    const convId = m[1];

    const sess = await fetch("/api/auth/session", { credentials: "include" }).then((r) => r.json()).catch(() => null);
    const token = sess && sess.accessToken;
    if (!token) throw new Error("You do not appear to be signed in to ChatGPT.");
    const authHeaders = { Authorization: "Bearer " + token };

    const res = await fetch("/backend-api/conversation/" + convId, {
      headers: authHeaders,
      credentials: "include",
    });
    if (!res.ok) throw new Error("Could not load conversation from ChatGPT (HTTP " + res.status + ").");
    const data = await res.json();

    // Follow the active branch from current_node up to the root.
    const map = data.mapping || {};
    const chain = [];
    let nodeId = data.current_node;
    const guard = new Set();
    while (nodeId && !guard.has(nodeId)) {
      guard.add(nodeId);
      const node = map[nodeId];
      if (!node) break;
      if (node.message) chain.push(node.message);
      nodeId = node.parent;
    }
    chain.reverse();

    const messages = [];
    for (const msg of chain) {
      const role = msg.author && msg.author.role;
      if (!msg.content) continue;
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
      if (role === "system" || role === "tool") continue;

      const out = {
        role: role === "assistant" ? "assistant" : "user",
        text: "",
        images: [],
        attachments: [],
        createdAt: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
      };

      const c = msg.content;
      const parts = c.parts || [];

      if (c.content_type === "text") {
        out.text = parts.filter((p) => typeof p === "string").join("\n\n");
      } else if (c.content_type === "code") {
        out.text = "```" + (c.language || "") + "\n" + (c.text || parts.join("\n")) + "\n```";
      } else if (c.content_type === "multimodal_text") {
        const segs = [];
        for (const p of parts) {
          if (typeof p === "string") {
            if (p) segs.push(p);
          } else if (p && (p.content_type === "image_asset_pointer" || p.asset_pointer)) {
            if (!OPTS.images) {
              segs.push("_[image not exported]_");
              continue;
            }
            const ptr = String(p.asset_pointer || p.image_url || "");
            const fileId = ptr.split("://").pop();
            try {
              const img = await downloadChatGPTFile(fileId, authHeaders);
              if (img) out.images.push(img);
              else segs.push("_[image unavailable: " + fileId + "]_");
            } catch (_) {
              segs.push("_[image download failed: " + fileId + "]_");
            }
          }
        }
        out.text = segs.join("\n\n");
      } else {
        out.text = parts.filter((p) => typeof p === "string").join("\n\n");
      }

      if ((out.text && out.text.trim()) || out.images.length) messages.push(out);
    }

    return {
      source: "chatgpt",
      id: convId,
      title: data.title || "ChatGPT conversation",
      createdAt: data.create_time ? new Date(data.create_time * 1000).toISOString() : null,
      url: location.href,
      model: data.default_model_slug || "",
      messages,
    };
  }

  async function downloadChatGPTFile(fileId, authHeaders) {
    let meta = null;
    for (const u of ["/backend-api/files/" + fileId + "/download", "/backend-api/files/download/" + fileId]) {
      const r = await fetch(u, { headers: authHeaders, credentials: "include" });
      if (r.ok) {
        meta = await r.json();
        break;
      }
    }
    if (!meta || !meta.download_url) return null;
    const img = await fetchImage(meta.download_url, meta.file_name || fileId);
    return img;
  }

  /* ---------- Claude ---------- */

  async function extractClaude() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    if (!m) throw new Error("Open a Claude conversation first (the URL should contain /chat/<id>).");
    const convId = m[1];

    const orgs = await fetch("/api/organizations", { credentials: "include" })
      .then((r) => r.json())
      .catch(() => null);
    if (!Array.isArray(orgs) || !orgs.length) throw new Error("You do not appear to be signed in to Claude.");
    const org =
      orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || orgs[0];

    const url =
      "/api/organizations/" + org.uuid + "/chat_conversations/" + convId +
      "?tree=True&rendering_mode=messages";
    const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load conversation from Claude (HTTP " + res.status + ").");
    const data = await res.json();

    const messages = [];
    for (const msg of data.chat_messages || []) {
      const role = msg.sender === "assistant" ? "assistant" : "user";

      let text = "";
      if (Array.isArray(msg.content) && msg.content.length) {
        text = msg.content
          .map((b) => (b && b.type === "text" ? b.text || "" : ""))
          .filter(Boolean)
          .join("\n\n");
      }
      if (!text) text = msg.text || "";

      const out = { role, text, images: [], attachments: [], createdAt: msg.created_at || null };

      const fileCount = (msg.files_v2 || []).length + (msg.files || []).length;
      if (!OPTS.images && fileCount) {
        out.text = (out.text ? out.text + "\n\n" : "") + "_[image not exported]_";
      }

      for (const f of msg.files_v2 || []) {
        const isImage = f.file_kind === "image" || String(f.file_type || "").startsWith("image");
        const src = f.preview_url || f.thumbnail_url;
        if (isImage && src) {
          try {
            const img = await fetchImage(src.startsWith("http") ? src : "https://claude.ai" + src, f.file_name);
            if (img) out.images.push(img);
          } catch (_) {}
        }
      }
      for (const f of msg.files || []) {
        const src = (f.preview_asset && f.preview_asset.url) || f.preview_url;
        if (src) {
          try {
            const img = await fetchImage(src.startsWith("http") ? src : "https://claude.ai" + src, f.file_name);
            if (img) out.images.push(img);
          } catch (_) {}
        }
      }
      for (const a of msg.attachments || []) {
        if (a.extracted_content) {
          out.attachments.push({ name: a.file_name || "attachment", content: a.extracted_content });
        }
      }

      if (text.trim() || out.images.length || out.attachments.length) messages.push(out);
    }

    return {
      source: "claude",
      id: convId,
      title: data.name || "Claude conversation",
      createdAt: data.created_at || null,
      url: location.href,
      model: data.model || "",
      messages,
    };
  }
})();
