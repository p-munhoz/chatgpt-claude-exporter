/* Emits dist/firefox/ and dist/chrome/ from the shared source.
 * Only the manifest differs between targets. Run: node build.mjs */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const SHARED = ["popup.html", "popup.css", "popup.js", "formatters.js", "lib", "src", "icons"];
const base = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));

function emit(target, manifest) {
  const dir = new URL(`dist/${target}/`, import.meta.url);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of SHARED) cpSync(new URL(p, import.meta.url), new URL(p, dir), { recursive: true });
  writeFileSync(new URL("manifest.json", dir), JSON.stringify(manifest, null, 2) + "\n");
  console.log("built dist/" + target);
}

// Firefox: exactly the source manifest.
emit("firefox", base);

// Chrome: drop the Gecko block, require a Chrome new enough for world:"MAIN".
const chrome = structuredClone(base);
delete chrome.browser_specific_settings;
chrome.minimum_chrome_version = "111";
emit("chrome", chrome);
