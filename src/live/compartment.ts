export const LIVE_DOC_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; navigate-to 'none'";

export const LIVE_3D_CSP =
  "default-src 'none'; img-src data:; style-src 'self' 'unsafe-inline'; script-src 'self' blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; navigate-to 'none'";

export const LIVE_PRELUDE = `(function(){var n=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel"];for(var i=0;i<n.length;i++){try{Object.defineProperty(window,n[i],{configurable:false,enumerable:false,writable:false,value:undefined})}catch(e){try{window[n[i]]=undefined}catch(e2){}}}var create=Document.prototype.createElement;Document.prototype.createElement=function(name,opts){var el=create.call(this,name,opts);if(String(name).toLowerCase()==="meta"){var set=el.setAttribute.bind(el);el.setAttribute=function(k,v){if(/^http-equiv$/i.test(k)&&/refresh/i.test(String(v)))return;if(/^content$/i.test(k)&&/url=/i.test(String(v)))return;return set(k,v)}}return el};function strip(el){if(!el||el.nodeType!==1)return;if(el.hasAttribute("href")||el.hasAttribute("xlink:href")){el.removeAttribute("href");el.removeAttribute("xlink:href")}if(/^META$/i.test(el.tagName)){var eq=el.getAttribute("http-equiv")||"";if(/refresh/i.test(eq))el.remove()}}var desc=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");if(desc&&desc.set){Object.defineProperty(Element.prototype,"innerHTML",{configurable:true,enumerable:desc.enumerable,get:desc.get,set:function(v){desc.set.call(this,v);strip(this);if(this.querySelectorAll)this.querySelectorAll("*").forEach(strip)}})}document.addEventListener("click",function(ev){var t=ev.target;while(t&&t.nodeType===1){if(t.hasAttribute&&(t.hasAttribute("href")||t.hasAttribute("xlink:href"))){ev.preventDefault();ev.stopPropagation();return}t=t.parentNode}},true);window.ncliFakes=function(){var loc={href:"",assign:function(){},replace:function(){},reload:function(){}};var win;var par=new Proxy(window.parent,{get:function(t,p){if(p==="location")return loc;var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});var doc=new Proxy(document,{get:function(t,p){if(p==="location")return loc;if(p==="defaultView")return win;if(p==="write"||p==="writeln"||p==="open")return function(){};var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});win=new Proxy(window,{get:function(t,p){if(p==="location")return loc;if(p==="document")return doc;if(p==="parent"||p==="top")return par;if(p==="window"||p==="self"||p==="globalThis"||p==="frames")return win;if(p==="Function"||p==="eval")return function(){return function(){}};var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});return [win,doc,loc,par,par,win,win,win,function(){return function(){}},function(){}]};function muteDoc(d){try{d.write=function(){};d.writeln=function(){};d.open=function(){}}catch(e){}}muteDoc(document);try{muteDoc(Document.prototype)}catch(e5){}function ping(op){try{parent.postMessage({type:"ncli-live",op:op,name:String(window.name||"")},"*")}catch(e){}}try{ping("hello")}catch(e3){}try{window.addEventListener("pagehide",function(){ping("nav")},true)}catch(e4){}})();`;

export function sanitizeLiveMarkup(source: string): string {
  return String(source ?? "")
    .replace(/<meta\b[^>]*>/gi, (tag) => (/refresh|url\s*=/i.test(tag) ? "" : tag))
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/\s(?:href|src|action|formaction|xlink:href|poster)\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\s(?:href|src|action|formaction|xlink:href|poster)\s*=\s*[^\s>]+/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
}

export function wrapLiveScript(source: string): string {
  return `(function(){var a=window.ncliFakes();return (function(window,document,location,top,parent,self,globalThis,frames,Function,ncliEval){"use strict";${source}\n}).apply(a[0],a)})();`;
}

export function compartmentHtml(body: string, extraHead = ""): string {
  const clean = sanitizeLiveMarkup(body);
  const scripts: string[] = [];
  const markup = clean.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_m, src: string) => {
    if (src.trim()) scripts.push(src);
    return "";
  });
  const wrapped = scripts.map((s) => `<script>${wrapLiveScript(s)}</script>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${LIVE_DOC_CSP}">${extraHead}</head><body><script>${LIVE_PRELUDE}</script>${markup}${wrapped}</body></html>`;
}
