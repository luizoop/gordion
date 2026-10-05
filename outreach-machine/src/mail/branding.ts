import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const logoContentId = "gordion-signature-logo";
export const logoPath = "assets/gordion-logo.png";
export const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function readLogo() {
  const bytes = readFileSync(logoPath);
  if (
    bytes.length > 1_000_000 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("Invalid logo asset");
  return { bytes, sha256: digest(bytes) };
}
export function brandedHtml(text: string) {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<html><body><pre style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escaped}</pre><img src="cid:${logoContentId}" alt="" width="200" style="width:200px;max-width:100%;height:auto"></body></html>`;
}
// Fail closed if Outlook rewrites the supported layout or someone changes the draft.
// Parse entities with an HTML parser, not regex or untrusted HTML execution.
export function readBrandedText(html: string): string {
  const doc = parse(html);
  let text = "",
    pres = 0,
    images = 0;
  function walk(node: DefaultTreeAdapterMap["node"], insidePre = false) {
    if (node.nodeName === "#text") {
      const value = (node as DefaultTreeAdapterMap["textNode"]).value;
      if (insidePre) text += value;
      else if (value.trim())
        throw new Error("Unexpected text outside approved mail");
      return;
    }
    if ("tagName" in node) {
      if (node.tagName === "head") {
        for(const child of node.childNodes) {
          if(child.nodeName==='#text' && !(child as DefaultTreeAdapterMap['textNode']).value.trim()) continue;
          if(!('tagName' in child) || child.tagName!=='meta') throw new Error('Unsupported mail head markup');
          const fields=Object.fromEntries(child.attrs.map(a=>[a.name.toLowerCase(),a.value.toLowerCase()]));
          if(Object.keys(fields).some(k=>!['charset','http-equiv','content'].includes(k)) ||
            (fields['http-equiv'] && fields['http-equiv']!=='content-type') ||
            (fields.charset && !/^utf-?8$/.test(fields.charset)) ||
            (fields.content && !/^text\/html;\s*charset=utf-?8$/.test(fields.content))) throw new Error('Unexpected mail metadata');
        }
        return;
      }
      if (!["html", "body", "div", "pre", "img"].includes(node.tagName))
        throw new Error("Unsupported mail markup");
      if (insidePre) throw new Error("Unexpected markup inside mail text");
      if (node.attrs.some((a) => /^on/i.test(a.name)))
        throw new Error("Unexpected active markup");
      const permitted=node.tagName==='img'?['src','alt','width','height','style']:['style','class','id','lang','dir'];
      if(node.attrs.some(a=>!permitted.includes(a.name))) throw new Error('Unapproved mail attribute');
      const style=node.attrs.find(a=>a.name==='style')?.value;
      if(style) {
        const expected:Record<string,string>=node.tagName==='pre'?{'font-family':'arial,sans-serif','font-size':'14px','line-height':'1.5','white-space':'pre-wrap'}:
          node.tagName==='img'?{'width':'200px','max-width':'100%','height':'auto'}:{};
        for(const declaration of style.split(';').filter(s=>s.trim())) {
          const colon=declaration.indexOf(':');const key=declaration.slice(0,colon).trim().toLowerCase();
          const value=declaration.slice(colon+1).replace(/[\s"']/g,'').toLowerCase();
          // Previously created Outlook drafts retain their original 320px layout.
          const legacyLogoWidth=node.tagName==='img' && key==='width' && value==='320px';
          if(colon<1 || (expected[key]!==value && !legacyLogoWidth)) throw new Error('Unapproved mail styling');
        }
      }
      if (node.tagName === "pre") {
        pres++;
        insidePre = true;
      }
      if (node.tagName === "img") {
        images++;
        if (pres !== 1) throw new Error("Logo must follow the mail text");
        if (
          node.attrs.find((a) => a.name === "src")?.value !==
            `cid:${logoContentId}` ||
          (node.attrs.find((a) => a.name === "alt")?.value || "") !== ""
        )
          throw new Error("Unexpected mail image");
      }
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) walk(child, insidePre);
  }
  walk(doc);
  if (pres !== 1 || images !== 1)
    throw new Error("Missing or additional mail content");
  return text;
}
