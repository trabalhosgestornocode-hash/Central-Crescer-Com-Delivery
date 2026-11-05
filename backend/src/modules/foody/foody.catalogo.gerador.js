// Geração OFFLINE do catálogo de linhas por operação (função PURA). Nunca roda em produção: o resultado vira o arquivo
// versionado foody.catalogo-operacao.js por PR, com teste de regressão do hash.
//
// CAMADA 2 — COOCORRÊNCIA ANCORADA (corrige a dependência do termo literal: "combos no precinho #cm #x steak churrasco" nunca
// traz "sub"/"subway", mas sempre vem junto de itens já conhecidos da Subway). Depois da camada 1 + validadas à mão, um pedido
// é ANCORADO na operação X quando suas linhas com evidência (catálogo ou termo validado) apontam só para X. Uma linha ainda sem
// evidência entra no catálogo de X quando, no histórico inteiro:
//   * aparece em >= coocorrencia.minimoPedidos pedidos ancorados em X, em >= coocorrencia.minimoDias dias distintos;
//   * NUNCA aparece em pedido com evidência da outra operação nem em pedido que o Parser rotula POR TERMO de outra operação, nem em revisão
//     (exclusividade histórica);
//   * não parece texto livre e não contém termo da outra operação.
// Ausência no Açaí NÃO basta: sem âncora positiva (linha sozinha ou só com itens desconhecidos) a linha segue na triagem.
// Uma rodada só (linhas da camada 2 não ancoram outras), para não propagar erro em cadeia.
//
// CAMADA 1 — rótulo por TERMO do Parser (classificarOperacao) — só entram pedidos com
// termo de UMA operação (sem termo, em revisão ou misturados ficam fora). Uma linha entra no catálogo de uma operação quando:
//   * aparece em pedidos de UMA só operação (linha vista nas duas é descartada e contada);
//   * foi vista >= `minimoOcorrencias` vezes em >= `minimoDias` dias distintos (corta texto livre e digitação única);
//   * não parece texto livre/dado pessoal (filtro abaixo) e não contém termo validado da OUTRA operação.
import { createHash } from "node:crypto";
import { classificarOperacao } from "../parser-food-delivery/parserFoodDelivery.operacao.js";
import { linhasDoPedido, operacoesPorTermo, normalizarLinhaItem } from "./foody.classificacao.js";

const PARECE_TEXTO_LIVRE = /@|\d{5,}|\b(obs|observ\w*|rua|avenida|av|apto|apartamento|bloco|casa|condominio|troco|cpf|cartao|pix|telefone|whats\w*|zap|entregar|entregador|portao|campainha|teste|favor|por favor|obrigad\w*|cliente)\b/;

export function pareceTextoLivre(linha) {
  return linha.length > 120 || PARECE_TEXTO_LIVRE.test(linha);
}

/** Hash estável do conteúdo do catálogo (linhas + termos). Muda com qualquer linha. */
export function hashCatalogo(linhas) {
  const canonico = JSON.stringify(Object.keys(linhas).sort().map((op) => [op, [...linhas[op]].sort()]));
  return createHash("sha256").update(canonico).digest("hex");
}

/** Hash do conjunto de entrada (ordem estável por id) — vai para `origem` e torna a geração auditável/reprodutível. */
export function hashEntrada(pedidos) {
  const canon = pedidos.map((p) => [String(p.id ?? ""), String(p.dia ?? ""), String(p.detalhes ?? "")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

const OPS = ["subway", "acai_no_grau"];

/**
 * @param {Array<{detalhes:string, dia?:string}>} pedidos  texto de itens + dia (AAAA-MM-DD) do pedido
 * @param {{minimoOcorrencias?:number, minimoDias?:number, validadas?:ReadonlyArray<object>,
 *   coocorrencia?: false|{minimoPedidos?:number, minimoDias?:number}}} [opcoes]
 */
export function gerarCatalogo(pedidos, { minimoOcorrencias = 2, minimoDias = 2, validadas = [], coocorrencia = { minimoPedidos: 3, minimoDias: 3 } } = {}) {
  const cont = new Map();
  const estat = { pedidos: 0, treino: 0, semTermoOuRevisao: 0, linhasVistasNasDuas: 0, descartadasTextoLivre: 0, descartadasRaras: 0,
    descartadasTermoDaOutra: 0 };
  const lidos = [];
  for (const p of pedidos) {
    estat.pedidos++;
    const r = classificarOperacao({ detalhesPedido: p.detalhes });
    const linhasP = linhasDoPedido(p.detalhes);
    lidos.push({ linhas: linhasP, dia: p.dia, parser: r.termosEncontrados.length || r.operacao === "revisao_necessaria" ? r.operacao : null });
    if (r.termosEncontrados.length === 0 || (r.operacao !== "subway" && r.operacao !== "acai_no_grau")) { estat.semTermoOuRevisao++; continue; }
    estat.treino++;
    for (const l of linhasP) {
      const x = cont.get(l) ?? { subway: 0, acai_no_grau: 0, dias: new Set() };
      x[r.operacao]++; if (p.dia) x.dias.add(p.dia); cont.set(l, x);
    }
  }
  const camada1 = { subway: [], acai_no_grau: [] };
  for (const [l, x] of cont) {
    if (x.subway && x.acai_no_grau) { estat.linhasVistasNasDuas++; continue; }
    const op = x.subway ? "subway" : "acai_no_grau";
    if (x[op] < minimoOcorrencias || x.dias.size < minimoDias) { estat.descartadasRaras++; continue; }
    if (pareceTextoLivre(l)) { estat.descartadasTextoLivre++; continue; }
    if (operacoesPorTermo(l).some((o) => o !== op)) { estat.descartadasTermoDaOutra++; continue; }
    camada1[op].push(l);
  }
  const base = validadas.length ? incluirValidadas(camada1, validadas).linhas : camada1;
  const linhas = { subway: [...base.subway], acai_no_grau: [...base.acai_no_grau] };
  const c2 = { subway: 0, acai_no_grau: 0, semAncora: 0, semFrequencia: 0, vistaNaOutra: 0, textoLivre: 0, termoDaOutra: 0 };
  if (coocorrencia) {
    const minP = coocorrencia.minimoPedidos ?? 3, minD = coocorrencia.minimoDias ?? 3;
    const indice = new Map(); for (const op of OPS) for (const l of base[op]) indice.set(l, op);
    const evid = (l) => { const s = new Set(operacoesPorTermo(l)); if (indice.has(l)) s.add(indice.get(l)); return s; };
    const st = new Map(); // linha ainda sem evidência -> âncoras e exclusividade
    for (const p of lidos) {
      const evs = p.linhas.map(evid);
      const opsPedido = new Set(evs.flatMap((s) => [...s]));
      for (let i = 0; i < p.linhas.length; i++) {
        if (evs[i].size) continue;
        const l = p.linhas[i];
        const x = st.get(l) ?? { anc: { subway: 0, acai_no_grau: 0 }, dias: { subway: new Set(), acai_no_grau: new Set() }, viu: new Set(), parser: new Set() };
        for (const o of opsPedido) x.viu.add(o);
        if (p.parser) x.parser.add(p.parser); // "Subway por falta de termo" do Parser não é evidência
        if (opsPedido.size === 1) { const op = [...opsPedido][0]; x.anc[op]++; if (p.dia) x.dias[op].add(p.dia); }
        st.set(l, x);
      }
    }
    for (const [l, x] of st) {
      if (x.viu.size > 1) { c2.vistaNaOutra++; continue; }
      if (x.viu.size === 0) { c2.semAncora++; continue; }
      const op = [...x.viu][0];
      if ([...x.parser].some((po) => po !== op)) { c2.vistaNaOutra++; continue; }
      if (x.anc[op] < minP || x.dias[op].size < minD) { c2.semFrequencia++; continue; }
      if (pareceTextoLivre(l)) { c2.textoLivre++; continue; }
      if (operacoesPorTermo(l).some((o) => o !== op)) { c2.termoDaOutra++; continue; }
      linhas[op].push(l); c2[op]++;
    }
  }
  for (const op of Object.keys(linhas)) linhas[op].sort();
  return { linhas, hash: hashCatalogo(linhas), camada1: { subway: camada1.subway.length, acai_no_grau: camada1.acai_no_grau.length },
    estatisticas: { ...estat, coocorrencia: c2, subway: linhas.subway.length, acai_no_grau: linhas.acai_no_grau.length },
    parametros: { minimoOcorrencias, minimoDias,
      coocorrencia: coocorrencia ? { minimoPedidos: coocorrencia.minimoPedidos ?? 3, minimoDias: coocorrencia.minimoDias ?? 3 } : false } };
}

/**
 * Junta as linhas VALIDADAS À MÃO (foody.catalogo-validadas.js) às linhas geradas. Função PURA; lança erro (nunca ignora) se uma
 * validada não estiver normalizada, parecer texto livre, trouxer termo da outra operação ou já existir no catálogo da outra.
 * @param {{subway:string[], acai_no_grau:string[]}} linhas
 * @param {ReadonlyArray<{operacao:string, linha:string, evidencia:string, validadoEm:string}>} validadas
 */
export function incluirValidadas(linhas, validadas) {
  const saida = Object.fromEntries(Object.entries(linhas).map(([op, l]) => [op, [...l]]));
  let incluidas = 0, jaPresentes = 0;
  for (const v of validadas) {
    const op = v.operacao, l = v.linha;
    if (!Object.hasOwn(saida, op)) throw new Error(`validada com operação desconhecida: ${op}`);
    if (normalizarLinhaItem(l) !== l) throw new Error(`validada não normalizada: ${l}`);
    if (pareceTextoLivre(l)) throw new Error(`validada parece texto livre: ${l}`);
    if (operacoesPorTermo(l).some((o) => o !== op)) throw new Error(`validada com termo de outra operação: ${l}`);
    if (!(String(v.evidencia ?? "").length > 20) || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.validadoEm ?? ""))) throw new Error(`validada sem evidência/data: ${l}`);
    for (const [outra, ls] of Object.entries(saida)) if (outra !== op && ls.includes(l)) throw new Error(`validada já está no catálogo de ${outra}: ${l}`);
    if (saida[op].includes(l)) { jaPresentes++; continue; }
    saida[op].push(l); incluidas++;
  }
  for (const op of Object.keys(saida)) saida[op].sort();
  return { linhas: saida, hash: hashCatalogo(saida), incluidas, jaPresentes };
}

/** Texto do arquivo versionado foody.catalogo-operacao.js (função PURA; quem grava é o script offline). */
export function renderizarCatalogo(corpo) {
  return `// GERADO por scripts/foody-gerar-catalogo.mjs / scripts/foody-catalogo-incluir-validadas.mjs — NÃO editar à mão.
// Catálogo VERSIONADO de linhas de item por operação. Mudança só por PR: gerar de novo com --versao nova e registrar o hash em
// test/foody-compartilhada-catalogo.test.js. Linhas validadas à mão ficam em foody.catalogo-validadas.js (com a evidência).
// Conteúdo: nomes de produto/complemento do cardápio (sem dado de cliente).
const congelar = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(v)])));
const C = ${JSON.stringify(corpo, null, 2)};
export const CATALOGO_OPERACAO = Object.freeze({ ...C, origem: Object.freeze(C.origem), termosValidados: congelar(C.termosValidados), linhas: congelar(C.linhas) });
`;
}
