/* Turns the normalized conversation object into downloadable files. */
/* global JSZip, marked */

(() => {
  const roleLabel = (r) => (r === "assistant" ? "Assistant" : r === "user" ? "You" : r);

  const slug = (s) =>
    (s || "conversation")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "") // réparer -> reparer
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .replace(/-{2,}/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "conversation";

  const safeFile = (s) => (s || "file").replace(/[^\w.-]+/g, "_").slice(0, 80);

  const baseName = (conv) => {
    const d = (conv.createdAt || new Date().toISOString()).slice(0, 10);
    return `${conv.source}-${slug(conv.title)}-${d}`;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "");

  const header = (conv) =>
    [
      conv.title,
      `Source: ${conv.source}${conv.model ? " (" + conv.model + ")" : ""}`,
      `Exported: ${fmtDate(new Date().toISOString())}`,
      conv.url,
    ].join("\n");

  /* ---------- plain text ---------- */

  function toTxt(conv) {
    const out = [header(conv), "=".repeat(60), ""];
    for (const m of conv.messages) {
      out.push(`### ${roleLabel(m.role)}${m.createdAt ? " — " + fmtDate(m.createdAt) : ""}`);
      out.push("");
      if (m.text) out.push(m.text, "");
      for (const img of m.images) out.push(`[image: ${img.name}]`);
      for (const a of m.attachments) out.push(`[attachment: ${a.name}]`, "", a.content, "");
      out.push("");
    }
    return out.join("\n");
  }

  /* ---------- json ---------- */

  function toJson(conv) {
    return JSON.stringify(conv, null, 2);
  }

  /* ---------- markdown ---------- */

  // imgRef(img, index) -> string to place in an ![]() link, or null to inline data URL
  function toMarkdown(conv, imgRef) {
    const out = [`# ${conv.title}`, "", `> ${header(conv).split("\n").slice(1).join(" · ")}`, "", "---", ""];
    conv.messages.forEach((m) => {
      out.push(`## ${roleLabel(m.role)}${m.createdAt ? " — " + fmtDate(m.createdAt) : ""}`, "");
      if (m.text) out.push(m.text, "");
      m.images.forEach((img, i) => {
        const ref = imgRef ? imgRef(img, i, m) : img.dataUrl;
        out.push(`![${img.name}](${ref})`, "");
      });
      m.attachments.forEach((a) => {
        out.push(`**Attachment: ${a.name}**`, "", "```", a.content, "```", "");
      });
      out.push("---", "");
    });
    return out.join("\n");
  }

  async function toMarkdownZip(conv) {
    const zip = new JSZip();
    const used = new Set();

    const md = toMarkdown(conv, (img, i, m) => {
      const mi = conv.messages.indexOf(m) + 1;
      let name = `images/${String(mi).padStart(2, "0")}-${i + 1}-${safeFile(img.name)}`;
      if (!/\.\w+$/.test(name)) name += "." + img.ext;
      let final = name;
      let n = 2;
      while (used.has(final)) final = name.replace(/(\.\w+)$/, `-${n++}$1`);
      used.add(final);
      zip.file(final, img.dataUrl.split(",")[1], { base64: true });
      return final;
    });

    zip.file(baseName(conv) + ".md", md);
    return zip.generateAsync({ type: "blob" });
  }

  /* ---------- html ---------- */

  function toHtml(conv) {
    const md = (t) => (typeof marked !== "undefined" ? marked.parse(t || "") : "<pre>" + esc(t || "") + "</pre>");
    const rows = conv.messages
      .map((m) => {
        const imgs = m.images
          .map((img) => `<img alt="${esc(img.name)}" src="${img.dataUrl}" />`)
          .join("\n");
        const atts = m.attachments
          .map((a) => `<details><summary>Attachment: ${esc(a.name)}</summary><pre>${esc(a.content)}</pre></details>`)
          .join("\n");
        return `<article class="msg ${esc(m.role)}">
  <div class="who">${esc(roleLabel(m.role))}${m.createdAt ? ' <span class="ts">' + esc(fmtDate(m.createdAt)) + "</span>" : ""}</div>
  <div class="body">${md(m.text)}${imgs}${atts}</div>
</article>`;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(conv.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 780px; margin: 0 auto; padding: 24px; font: 15px/1.6 system-ui, sans-serif; }
  h1 { font-size: 20px; }
  .meta { color: GrayText; font-size: 13px; margin-bottom: 24px; }
  .meta a { color: inherit; }
  .msg { padding: 14px 16px; border-radius: 10px; margin: 12px 0; }
  .msg.user { background: color-mix(in srgb, currentColor 7%, transparent); }
  .msg.assistant { background: color-mix(in srgb, #10a37f 12%, transparent); }
  .who { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
  .ts { font-weight: 400; color: GrayText; }
  .body :first-child { margin-top: 0; }
  .body :last-child { margin-bottom: 0; }
  .body img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
  pre { overflow-x: auto; padding: 12px; border-radius: 8px; background: color-mix(in srgb, currentColor 10%, transparent); }
  code { font-family: ui-monospace, monospace; font-size: .9em; }
</style>
</head>
<body>
<h1>${esc(conv.title)}</h1>
<div class="meta">
  ${esc(conv.source)}${conv.model ? " · " + esc(conv.model) : ""} ·
  exported ${esc(fmtDate(new Date().toISOString()))} ·
  <a href="${esc(conv.url)}">original</a>
</div>
${rows}
</body>
</html>`;
  }

  (typeof globalThis !== "undefined" ? globalThis : self).CCE = {
    baseName,
    toTxt,
    toJson,
    toMarkdown, // plain .md, images inlined as data URIs
    toMarkdownZip, // .zip: conversation .md + images/ folder
    toHtml,
  };
})();
