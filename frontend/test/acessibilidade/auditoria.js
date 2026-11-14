// Execução 08D — AUDITOR DE ACESSIBILIDADE próprio (sem dependências): as MESMAS regras sobre o HTML gerado (Node) e sobre
// a página real (navegador, via `auditarElemento(document.body)`). Cobre o que dá para verificar estruturalmente:
//   - todo campo de formulário visível tem nome acessível (label[for], label envolvente, aria-label, aria-labelledby);
//   - todo botão/link tem texto ou aria-label; imagens têm alt;
//   - tabelas têm legenda (caption/aria-label/aria-labelledby) e cabeçalhos <th>; th de cabeçalho com scope;
//   - nada de tabindex positivo; ids não se repetem; aria-labelledby/describedby apontam para ids existentes;
//   - diálogos (role=dialog) têm título; resultados de ação têm região de anúncio (role=status/alert ou aria-live).
// NÃO cobre contraste de cores, ordem visual × ordem do DOM nem a experiência com leitor de tela real.

const VAZIOS = new Set(["input", "img", "br", "hr", "meta", "link", "col", "source", "wbr", "area", "base", "embed", "track", "param"]);
const decodificar = (t) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** HTML → árvore { tag, attrs, filhos, texto } (suficiente para o HTML bem formado que as telas geram). */
export function arvoreDeHtml(html) {
  const raiz = { tag: "#raiz", attrs: {}, filhos: [] };
  const pilha = [raiz];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(html));) {
    if (m[0].startsWith("<!--")) continue;
    if (m[5] !== undefined) { pilha.at(-1).filhos.push({ tag: "#texto", texto: decodificar(m[5]) }); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = pilha.map((x) => x.tag).lastIndexOf(tag);
      if (i > 0) pilha.length = i;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decodificar(a[2] ?? a[3] ?? a[4] ?? "");
    const no = { tag, attrs, filhos: [] };
    pilha.at(-1).filhos.push(no);
    if (!VAZIOS.has(tag) && !m[4]) pilha.push(no);
  }
  return raiz;
}

/** Elemento do DOM → mesma árvore (para rodar no navegador). */
export function arvoreDeElemento(el) {
  if (el.nodeType === 3) return { tag: "#texto", texto: el.textContent };
  if (el.nodeType !== 1) return null;
  const attrs = {};
  for (const a of el.attributes) attrs[a.name.toLowerCase()] = a.value;
  if (el.hidden || el.closest?.("[hidden]")) attrs.__oculto = "1";
  return { tag: el.tagName.toLowerCase(), attrs, filhos: [...el.childNodes].map(arvoreDeElemento).filter(Boolean) };
}

const texto = (no) => (no.tag === "#texto" ? no.texto : (no.filhos ?? []).map(texto).join("")).replace(/\s+/g, " ").trim();
function percorrer(no, fn, ancestrais = []) {
  if (no.tag !== "#texto") fn(no, ancestrais);
  for (const f of no.filhos ?? []) percorrer(f, fn, [...ancestrais, no]);
}

/** Regras sobre a árvore. Devolve a lista de problemas { regra, onde }. */
export function auditar(raiz) {
  const problemas = [];
  const ids = new Map();
  const labelsFor = new Set();
  percorrer(raiz, (no) => {
    if (no.attrs.id) ids.set(no.attrs.id, (ids.get(no.attrs.id) ?? 0) + 1);
    if (no.tag === "label" && no.attrs.for) labelsFor.add(no.attrs.for);
  });
  const onde = (no) => `<${no.tag}${no.attrs.id ? `#${no.attrs.id}` : ""}${no.attrs.name ? ` name=${no.attrs.name}` : ""}${no.attrs.class ? ` .${no.attrs.class.split(" ")[0]}` : ""}>`;
  const add = (regra, no) => problemas.push({ regra, onde: onde(no) });
  const temNome = (no) => no.attrs["aria-label"]?.trim() || no.attrs["aria-labelledby"] || no.attrs.title?.trim();
  percorrer(raiz, (no, ancestrais) => {
    // Conteúdo oculto (hidden) não chega à árvore de acessibilidade: não é auditado enquanto oculto.
    if (no.attrs.__oculto || no.attrs.hidden !== undefined || ancestrais.some((a) => a.attrs?.hidden !== undefined)) return;
    const t = no.tag;
    if ((t === "input" && !["hidden", "submit", "button", "reset", "image"].includes(no.attrs.type)) || t === "select" || t === "textarea") {
      const envolvido = ancestrais.some((a) => a.tag === "label");
      if (!envolvido && !(no.attrs.id && labelsFor.has(no.attrs.id)) && !temNome(no)) add("campo sem rótulo", no);
    }
    if (t === "button" && !texto(no) && !temNome(no)) add("botão sem nome", no);
    if (t === "a" && no.attrs.href !== undefined && !texto(no) && !temNome(no)) add("link sem nome", no);
    if (t === "img" && no.attrs.alt === undefined) add("imagem sem alt", no);
    if (no.attrs.tabindex && Number(no.attrs.tabindex) > 0) add("tabindex positivo", no);
    if (t === "table") {
      let caption = false; let th = false;
      percorrer(no, (x) => { if (x.tag === "caption") caption = true; if (x.tag === "th") th = true; });
      if (!caption && !temNome(no)) add("tabela sem legenda", no);
      if (!th) add("tabela sem cabeçalho", no);
    }
    if (t === "th" && ancestrais.some((a) => a.tag === "thead") && !no.attrs.scope) add("cabeçalho de coluna sem scope", no);
    for (const ref of ["aria-labelledby", "aria-describedby"]) {
      for (const id of (no.attrs[ref] ?? "").split(/\s+/).filter(Boolean)) if (!ids.has(id)) add(`${ref} aponta para id inexistente (${id})`, no);
    }
    if (no.attrs.role === "dialog" && !temNome(no)) add("diálogo sem título", no);
    if (t === "form" && no.attrs["data-acao"]) {
      let anuncio = false;
      percorrer(no, (x) => { if (["status", "alert"].includes(x.attrs?.role) || x.attrs?.["aria-live"]) anuncio = true; });
      if (!anuncio) add("formulário de ação sem região de anúncio do resultado", no);
    }
  });
  for (const [id, n] of ids) if (n > 1) problemas.push({ regra: "id duplicado", onde: `#${id} (${n}×)` });
  return problemas;
}

export const auditarHtml = (html) => auditar(arvoreDeHtml(html));
export const auditarElemento = (el) => auditar(arvoreDeElemento(el));
