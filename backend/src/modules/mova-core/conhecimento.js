// MOVA CORE — F5: CONHECIMENTO CORPORATIVO (migração 0021). O MOVA explica o sistema, as metodologias, os procedimentos e as
// regras APROVADAS; os FATOS (saldo, conta, venda, pendência) vêm sempre das ferramentas oficiais, nunca daqui.
//
// Três camadas que a resposta precisa distinguir (a ferramenta devolve a "autoridade" de cada trecho):
//   • REGRA_APROVADA            — regra/política/decisão aprovada por uma pessoa responsável (versão vigente);
//   • DOCUMENTACAO_DO_SISTEMA   — como o sistema funciona, aprovado;
//   • DOCUMENTACAO_EM_REVISAO   — como o sistema funciona, ainda PENDENTE de aprovação: pode explicar o funcionamento citando
//                                 "pela documentação do sistema", nunca como regra da empresa.
// Regra, política, decisão ou particularidade PENDENTE só chega ao modelo como PROPOSTA_PENDENTE (nunca como oficial). A IA pode SUGERIR conhecimento
// (fica PENDENTE, marcado como sugestão da IA); só uma pessoa com permissão aprova, e nunca quem sugeriu.
import { randomUUID } from "node:crypto";
import { radical } from "./resolucao.js";

export const TIPO_CONHECIMENTO = Object.freeze({
  FUNCIONAMENTO: "FUNCIONAMENTO", REGRA_FINANCEIRA: "REGRA_FINANCEIRA", METODOLOGIA: "METODOLOGIA", PROCEDIMENTO: "PROCEDIMENTO", POLITICA: "POLITICA",
  INTEGRACAO: "INTEGRACAO", GLOSSARIO: "GLOSSARIO", PARTICULARIDADE_DA_UNIDADE: "PARTICULARIDADE_DA_UNIDADE", DECISAO: "DECISAO",
});
export const ESTADO_CONHECIMENTO = Object.freeze({ PENDENTE: "PENDENTE", APROVADO: "APROVADO", RECUSADO: "RECUSADO", SUBSTITUIDO: "SUBSTITUIDO", REVOGADO: "REVOGADO" });
/** Tipos que DESCREVEM o sistema (pendente pode ser usado como "documentação em revisão"). Os demais são NORMATIVOS. */
export const TIPOS_DOCUMENTAIS = Object.freeze(new Set(["FUNCIONAMENTO", "METODOLOGIA", "PROCEDIMENTO", "INTEGRACAO", "GLOSSARIO"]));
const NORMATIVOS_COM_VALOR = new Set(["POLITICA", "REGRA_FINANCEIRA", "DECISAO"]);

export class ErroDeConhecimento extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "ErroDeConhecimento"; this.codigo = codigo; }
}
const falhar = (codigo, mensagem) => { throw new ErroDeConhecimento(codigo, mensagem); };

export const normalizarTexto = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").replace(/\s+/g, " ").trim();
const PARADAS = new Set("a o as os um uma de da do das dos e em no na nos nas para por com sem que qual quais quando como onde porque por que se ao aos ou mais menos muito pouco nosso nossa nossos nossas meu minha esse essa isso este esta isto aqui ali la eu voce voces nos ele ela eles elas tem ter ser esta estao foi sao era fazer faz feito sobre entre ja ainda tambem so mesmo nao sim pode posso devo deve mova oi ola".split(" "));
export const palavrasDaPergunta = (texto) => [...new Set(normalizarTexto(texto).split(" ").filter((w) => w.length >= 3 && !PARADAS.has(w) && /^[a-z0-9]+$/.test(w)))].slice(0, 24);
export const termosDaPergunta = (texto) => [...new Set(normalizarTexto(texto).split(" ").filter((w) => w.length >= 3 && !PARADAS.has(w)).map((w) => radical(w)))].slice(0, 24);

/**
 * Conhecimento NÃO guarda dado financeiro dinâmico. Recusa: saldo/posição com valor, "devemos/falta pagar R$", valor de venda do
 * dia/mês, vencimento relativo ("vence amanhã"). Valor em reais só em POLÍTICA/REGRA/DECISÃO, e só como limite/parâmetro.
 */
export function pareceDadoDinamico({ conteudo, tipo }) {
  const t = normalizarTexto(conteudo);
  if (/\b(saldo|em aberto|devemos|deve|falta pagar|faltam pagar|vendemos|faturamos|faturou|recebemos)\b[^.]{0,40}\b(r \d|\d+ reais|\d{1,3}( \d{3})* \d{2}\b)/.test(t)) return "VALOR_DE_POSICAO";
  if (/\bvence(m)? (hoje|amanha|ontem)\b/.test(t)) return "VENCIMENTO_RELATIVO";
  const temReais = /r\$\s?\d|\b\d+ reais\b/i.test(String(conteudo));
  if (temReais && !NORMATIVOS_COM_VALOR.has(tipo)) return "VALOR_FORA_DE_REGRA";
  if (temReais && !/\b(limite|ate|acima|abaixo|teto|minimo|maximo|por pagamento|a partir|superior|inferior)\b/.test(t)) return "VALOR_SEM_SER_PARAMETRO";
  return null;
}

function validar(x) {
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(String(x.chave ?? ""))) falhar("CHAVE_INVALIDA", "chave: minúsculas, números, ponto, hífen (3–81).");
  if (!TIPO_CONHECIMENTO[x.tipo]) falhar("TIPO_INVALIDO", "tipo desconhecido");
  if (String(x.titulo ?? "").trim().length < 3 || String(x.titulo).length > 160) falhar("TITULO_INVALIDO", "título entre 3 e 160 caracteres");
  if (String(x.conteudo ?? "").trim().length < 10 || String(x.conteudo).length > 8000) falhar("CONTEUDO_INVALIDO", "conteúdo entre 10 e 8000 caracteres");
  if (String(x.origem ?? "").trim().length < 3) falhar("SEM_ORIGEM", "todo conhecimento precisa de origem (documento, decisão, conversa)");
  if (String(x.responsavel ?? "").trim().length < 2) falhar("SEM_RESPONSAVEL", "todo conhecimento precisa de responsável");
  if (x.unidadeId && !x.organizacaoId) falhar("ESCOPO_INVALIDO", "unidade só dentro de uma empresa");
  if (x.vigenteDe && x.vigenteAte && x.vigenteAte < x.vigenteDe) falhar("VIGENCIA_INVALIDA", "vigência invertida");
  const dinamico = pareceDadoDinamico(x);
  if (dinamico) falhar("DADO_DINAMICO", `conhecimento não guarda dado financeiro dinâmico (${dinamico}); isso vem das ferramentas oficiais`);
}
const ehIa = (por) => /^(mova|ia|ai|claude|sistema|modelo)\b/i.test(String(por ?? "").trim());
const escopoDe = (x) => (x.unidadeId ? "UNIDADE" : x.organizacaoId ? "EMPRESA" : "SISTEMA");
const textoDeBusca = (x) => normalizarTexto([x.titulo, x.titulo, (x.palavras ?? []).join(" "), (x.palavras ?? []).join(" "), x.conteudo].join(" ")).slice(0, 12000);

// ---------------------------------------------------------------- repositório em memória (mesmo contrato do PostgreSQL)
export function criarRepositorioDeConhecimentoMemoria() {
  const itens = new Map(); const eventos = [];
  const mesmoEscopo = (a, b) => (a.organizacaoId ?? null) === (b.organizacaoId ?? null) && (a.unidadeId ?? null) === (b.unidadeId ?? null) && a.chave === b.chave;
  return {
    async inserir(x) {
      if ([...itens.values()].some((y) => mesmoEscopo(x, y) && y.versao === x.versao)) return { ok: false, motivo: "VERSAO_EXISTENTE" };
      const novo = { ...structuredClone(x), textoBusca: textoDeBusca(x) }; itens.set(novo.id, novo); return { ok: true, item: structuredClone(novo) };
    },
    async obter(id) { const x = itens.get(id); return x ? structuredClone(x) : null; },
    async ultimaVersao({ organizacaoId, unidadeId, chave }) { return Math.max(0, ...[...itens.values()].filter((y) => mesmoEscopo({ organizacaoId, unidadeId, chave }, y)).map((y) => y.versao)); },
    async aprovadoDaChave({ organizacaoId, unidadeId, chave }) { const y = [...itens.values()].find((z) => mesmoEscopo({ organizacaoId, unidadeId, chave }, z) && z.estado === "APROVADO"); return y ? structuredClone(y) : null; },
    /** troca de estado condicional (o estado esperado protege contra duas decisões simultâneas) */
    async mudarEstado(id, estadoEsperado, patch) {
      const x = itens.get(id); if (!x || x.estado !== estadoEsperado) return { ok: false, motivo: "CONCORRENCIA" };
      if (patch.estado === "APROVADO" && [...itens.values()].some((y) => y.id !== id && mesmoEscopo(x, y) && y.estado === "APROVADO")) return { ok: false, motivo: "JA_HA_APROVADO" };
      Object.assign(x, structuredClone(patch)); return { ok: true, item: structuredClone(x) };
    },
    async registrarEvento(e) { eventos.push({ ...structuredClone(e), em: e.em ?? new Date().toISOString() }); },
    async eventos(conhecimentoId) { return eventos.filter((e) => e.conhecimentoId === conhecimentoId).map((e) => structuredClone(e)); },
    async candidatos({ organizacaoId, unidadeId }) {
      return [...itens.values()].filter((x) => (x.organizacaoId == null || x.organizacaoId === organizacaoId) && (x.unidadeId == null || x.unidadeId === unidadeId)
        && (x.estado === "APROVADO" || x.estado === "PENDENTE")).map((x) => structuredClone(x));
    },
    async listar({ organizacaoId = null, estados = null } = {}) {
      return [...itens.values()].filter((x) => (x.organizacaoId == null || x.organizacaoId === organizacaoId) && (!estados || estados.includes(x.estado))).map((x) => structuredClone(x));
    },
  };
}

// ---------------------------------------------------------------- repositório PostgreSQL (0021)
const daLinha = (r) => (r ? { id: r.id, chave: r.chave, versao: r.versao, organizacaoId: r.organizacao_id, unidadeId: r.unidade_id, tipo: r.tipo, titulo: r.titulo, conteudo: r.conteudo,
  palavras: r.palavras ?? [], textoBusca: r.texto_busca, origem: r.origem, responsavel: r.responsavel, estado: r.estado, sugeridoPor: r.sugerido_por, sugeridoPelaIa: r.sugerido_pela_ia,
  aprovadoPor: r.aprovado_por, aprovadoEm: r.aprovado_em?.toISOString?.() ?? r.aprovado_em, vigenteDe: r.vigente_de ? toData(r.vigente_de) : null, vigenteAte: r.vigente_ate ? toData(r.vigente_ate) : null,
  revogadoEm: r.revogado_em?.toISOString?.() ?? r.revogado_em, revogadoPor: r.revogado_por, motivoRevogacao: r.motivo_revogacao, criadoEm: r.criado_em?.toISOString?.() ?? r.criado_em } : null);
const toData = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : String(d).slice(0, 10));
const ZERO = "00000000-0000-0000-0000-000000000000";

export function criarRepositorioDeConhecimentoPostgres(pool) {
  const escopo = "coalesce(organizacao_id, $1::uuid) = coalesce($2::uuid, $1::uuid) and coalesce(unidade_id, $1::uuid) = coalesce($3::uuid, $1::uuid) and chave = $4";
  return {
    async inserir(x) {
      try {
        const { rows } = await pool.query(`insert into mova.core_conhecimento (id, chave, versao, organizacao_id, unidade_id, tipo, titulo, conteudo, palavras, texto_busca, origem, responsavel, estado,
            sugerido_por, sugerido_pela_ia, vigente_de, vigente_ate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
        [x.id, x.chave, x.versao, x.organizacaoId ?? null, x.unidadeId ?? null, x.tipo, x.titulo, x.conteudo, x.palavras ?? [], textoDeBusca(x), x.origem, x.responsavel, x.estado,
          x.sugeridoPor, Boolean(x.sugeridoPelaIa), x.vigenteDe ?? null, x.vigenteAte ?? null]);
        return { ok: true, item: daLinha(rows[0]) };
      } catch (e) { if (e?.code === "23505") return { ok: false, motivo: "VERSAO_EXISTENTE" }; throw e; }
    },
    async obter(id) { const { rows } = await pool.query("select * from mova.core_conhecimento where id = $1", [id]); return daLinha(rows[0]); },
    async ultimaVersao({ organizacaoId, unidadeId, chave }) {
      const { rows } = await pool.query(`select coalesce(max(versao), 0) as v from mova.core_conhecimento where ${escopo}`, [ZERO, organizacaoId ?? null, unidadeId ?? null, chave]);
      return Number(rows[0].v);
    },
    async aprovadoDaChave({ organizacaoId, unidadeId, chave }) {
      const { rows } = await pool.query(`select * from mova.core_conhecimento where ${escopo} and estado = 'APROVADO'`, [ZERO, organizacaoId ?? null, unidadeId ?? null, chave]);
      return daLinha(rows[0]);
    },
    async mudarEstado(id, estadoEsperado, patch) {
      const col = { estado: "estado", aprovadoPor: "aprovado_por", aprovadoEm: "aprovado_em", revogadoEm: "revogado_em", revogadoPor: "revogado_por", motivoRevogacao: "motivo_revogacao", vigenteDe: "vigente_de" };
      const campos = Object.keys(patch).filter((k) => col[k]);
      try {
        const { rows } = await pool.query(`update mova.core_conhecimento set ${campos.map((k, i) => `${col[k]} = $${i + 3}`).join(", ")} where id = $1 and estado = $2 returning *`,
          [id, estadoEsperado, ...campos.map((k) => patch[k])]);
        return rows[0] ? { ok: true, item: daLinha(rows[0]) } : { ok: false, motivo: "CONCORRENCIA" };
      } catch (e) { if (e?.code === "23505") return { ok: false, motivo: "JA_HA_APROVADO" }; throw e; }
    },
    async registrarEvento(e) {
      await pool.query("insert into mova.core_conhecimento_evento (conhecimento_id, acao, por, detalhes) values ($1, $2, $3, $4::jsonb)", [e.conhecimentoId, e.acao, e.por, JSON.stringify(e.detalhes ?? {})]);
    },
    async eventos(conhecimentoId) {
      const { rows } = await pool.query("select conhecimento_id, acao, por, em, detalhes from mova.core_conhecimento_evento where conhecimento_id = $1 order by id", [conhecimentoId]);
      return rows.map((r) => ({ conhecimentoId: r.conhecimento_id, acao: r.acao, por: r.por, em: r.em.toISOString(), detalhes: r.detalhes }));
    },
    /** pré-filtro pelo índice de texto (português) com OR dos termos; sem acerto, cai para o escopo inteiro (base pequena) */
    async candidatos({ organizacaoId, unidadeId, palavras = [] }) {
      const base = `select * from mova.core_conhecimento where (organizacao_id is null or organizacao_id = $1) and (unidade_id is null or unidade_id = $2) and estado in ('APROVADO', 'PENDENTE')`;
      const limpos = palavras.map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 3);
      if (limpos.length) {
        const { rows } = await pool.query(`${base} and busca @@ to_tsquery('portuguese', $3) order by ts_rank_cd(busca, to_tsquery('portuguese', $3)) desc limit 60`,
          [organizacaoId ?? null, unidadeId ?? null, limpos.join(" | ")]);
        if (rows.length) return rows.map(daLinha);
      }
      const { rows } = await pool.query(`${base} limit 300`, [organizacaoId ?? null, unidadeId ?? null]);
      return rows.map(daLinha);
    },
    async listar({ organizacaoId = null, estados = null } = {}) {
      const { rows } = await pool.query("select * from mova.core_conhecimento where (organizacao_id is null or organizacao_id = $1) and ($2::text[] is null or estado = any($2)) order by chave, versao", [organizacaoId, estados]);
      return rows.map(daLinha);
    },
  };
}

// ---------------------------------------------------------------- serviço
export function criarServicoDeConhecimento({ repositorio = criarRepositorioDeConhecimentoMemoria(), relogio = () => Date.now(), auditoria = { registrar() {} } } = {}) {
  const agoraIso = () => new Date(relogio()).toISOString();
  const evento = async (item, acao, por, detalhes = {}) => {
    await repositorio.registrarEvento({ conhecimentoId: item.id, acao, por, detalhes });
    auditoria.registrar({ tipo: "MOVA_CORE_CONHECIMENTO", acao, conhecimentoId: item.id, chave: item.chave, versao: item.versao, por });
  };
  const exigirAprovador = (por, podeAprovar) => {
    if (!podeAprovar) falhar("SEM_PERMISSAO", "só quem tem permissão de aprovar conhecimento pode decidir");
    if (!por || ehIa(por)) falhar("APROVADOR_HUMANO", "a decisão é de uma pessoa responsável, nunca da IA");
  };

  return Object.freeze({
    /** Sugestão (de pessoa, de documento ou da IA): sempre PENDENTE, numa versão nova da chave. */
    async sugerir(x) {
      validar(x);
      const sugeridoPelaIa = Boolean(x.sugeridoPelaIa) || ehIa(x.sugeridoPor);
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const versao = (await repositorio.ultimaVersao(x)) + 1;
        const item = { id: randomUUID(), chave: x.chave, versao, organizacaoId: x.organizacaoId ?? null, unidadeId: x.unidadeId ?? null, tipo: x.tipo, titulo: x.titulo.trim(), conteudo: x.conteudo.trim(),
          palavras: (x.palavras ?? []).slice(0, 40).map((p) => String(p).slice(0, 60)), origem: x.origem.trim(), responsavel: x.responsavel.trim(), estado: "PENDENTE",
          sugeridoPor: String(x.sugeridoPor ?? "desconhecido").slice(0, 160), sugeridoPelaIa, vigenteDe: x.vigenteDe ?? null, vigenteAte: x.vigenteAte ?? null, criadoEm: agoraIso() };
        const r = await repositorio.inserir(item);
        if (r.ok) { await evento(r.item, "SUGERIDO", item.sugeridoPor, { sugeridoPelaIa, origem: item.origem }); return r.item; }
      }
      falhar("CONCORRENCIA", "não consegui reservar a versão; tente de novo");
    },

    /** Aprovação HUMANA (nunca quem sugeriu): a versão aprovada substitui a anterior aprovada da mesma chave. */
    async aprovar({ id, por, podeAprovar, vigenteDe = null }) {
      exigirAprovador(por, podeAprovar);
      const x = await repositorio.obter(id);
      if (!x) falhar("NAO_ENCONTRADO", "conhecimento não encontrado");
      if (x.estado !== "PENDENTE") falhar("ESTADO_INVALIDO", `só PENDENTE é aprovável (está ${x.estado})`);
      if (x.sugeridoPor === por) falhar("APROVADOR_E_AUTOR", "quem sugeriu não aprova a própria sugestão");
      const anterior = await repositorio.aprovadoDaChave(x);
      if (anterior) {
        const s = await repositorio.mudarEstado(anterior.id, "APROVADO", { estado: "SUBSTITUIDO" });
        if (!s.ok) falhar("CONCORRENCIA", "outra decisão aconteceu ao mesmo tempo; confira e repita");
        await evento(anterior, "SUBSTITUIDO", por, { pela: x.id, versao: x.versao });
      }
      const r = await repositorio.mudarEstado(id, "PENDENTE", { estado: "APROVADO", aprovadoPor: por, aprovadoEm: agoraIso(), ...(vigenteDe ? { vigenteDe } : {}) });
      if (!r.ok) falhar(r.motivo === "JA_HA_APROVADO" ? "JA_HA_APROVADO" : "CONCORRENCIA", "outra decisão aconteceu ao mesmo tempo; confira e repita");
      await evento(r.item, "APROVADO", por);
      return r.item;
    },
    async recusar({ id, por, podeAprovar, motivo }) {
      exigirAprovador(por, podeAprovar);
      const r = await repositorio.mudarEstado(id, "PENDENTE", { estado: "RECUSADO" });
      if (!r.ok) falhar("ESTADO_INVALIDO", "só PENDENTE pode ser recusado");
      await evento(r.item, "RECUSADO", por, { motivo: String(motivo ?? "").slice(0, 300) });
      return r.item;
    },
    /** Revogação vale NA HORA: o item some da busca no mesmo instante. */
    async revogar({ id, por, podeAprovar, motivo }) {
      exigirAprovador(por, podeAprovar);
      if (String(motivo ?? "").trim().length < 5) falhar("SEM_MOTIVO", "revogação exige motivo");
      const x = await repositorio.obter(id);
      if (!x || !["APROVADO", "PENDENTE"].includes(x.estado)) falhar("ESTADO_INVALIDO", "só APROVADO ou PENDENTE pode ser revogado");
      const r = await repositorio.mudarEstado(id, x.estado, { estado: "REVOGADO", revogadoEm: agoraIso(), revogadoPor: por, motivoRevogacao: String(motivo).slice(0, 300) });
      if (!r.ok) falhar("CONCORRENCIA", "outra decisão aconteceu ao mesmo tempo");
      await evento(r.item, "REVOGADO", por, { motivo });
      return r.item;
    },
    async eventos(id) { return repositorio.eventos(id); },
    async listar(f) { return repositorio.listar(f); },

    /**
     * Recuperação textual + estruturada: termos da pergunta (radicais) × título/palavras-chave (peso 3) e conteúdo (peso 1);
     * escopo mais específico (unidade > empresa > sistema) desempata e SOBREPÕE o mais geral da mesma chave; vigência conferida;
     * normativo pendente vem SÓ como PROPOSTA_PENDENTE (nunca como regra; a versão aprovada da chave tem precedência). Devolve no máximo `limite` trechos com a autoridade de cada um.
     */
    async buscar({ organizacaoId, unidadeId, pergunta, hoje = new Date(relogio()).toISOString().slice(0, 10), limite = 4, tipos = null }) {
      const termos = termosDaPergunta(pergunta);
      if (!termos.length) return [];
      const lista = await repositorio.candidatos({ organizacaoId, unidadeId, termos, palavras: palavrasDaPergunta(pergunta) });
      const vigente = (x) => (!x.vigenteDe || x.vigenteDe <= hoje) && (!x.vigenteAte || x.vigenteAte >= hoje);
      const usavel = (x) => vigente(x) && (x.estado === "APROVADO" || x.estado === "PENDENTE") && (!tipos || tipos.includes(x.tipo));
      // a versão que vale de cada chave: aprovada > pendente mais nova; escopo específico sobrepõe o geral
      const porChave = new Map();
      const peso = (x) => (x.unidadeId ? 4 : x.organizacaoId ? 2 : 0) + (x.estado === "APROVADO" ? 1 : 0);
      for (const x of lista.filter(usavel)) { const a = porChave.get(x.chave); if (!a || peso(x) > peso(a) || (peso(x) === peso(a) && x.versao > a.versao)) porChave.set(x.chave, x); }
      const pontuar = (x) => {
        const cab = new Set(normalizarTexto(`${x.titulo} ${(x.palavras ?? []).join(" ")}`).split(" ").map(radical));
        const corpo = new Set(normalizarTexto(x.conteudo).split(" ").map(radical));
        let p = 0; for (const t of termos) { if (cab.has(t)) p += 3; else if (corpo.has(t)) p += 1; }
        return p + (x.unidadeId ? 0.5 : x.organizacaoId ? 0.25 : 0);
      };
      return [...porChave.values()].map((x) => ({ x, p: pontuar(x) })).filter(({ p }) => p >= 2).sort((a, b) => b.p - a.p).slice(0, limite).map(({ x }) => ({
        ref: `${x.chave}@v${x.versao}`, chave: x.chave, versao: x.versao, tipo: x.tipo, titulo: x.titulo, conteudo: x.conteudo, origem: x.origem, responsavel: x.responsavel, escopo: escopoDe(x),
        autoridade: x.estado === "APROVADO" ? (TIPOS_DOCUMENTAIS.has(x.tipo) ? "DOCUMENTACAO_DO_SISTEMA" : "REGRA_APROVADA") : TIPOS_DOCUMENTAIS.has(x.tipo) ? "DOCUMENTACAO_EM_REVISAO" : "PROPOSTA_PENDENTE",
        aprovadoPor: x.estado === "APROVADO" ? x.aprovadoPor : null, vigencia: { de: x.vigenteDe, ate: x.vigenteAte },
      }));
    },
  });
}

// ---------------------------------------------------------------- ferramentas do modelo
const DINHEIRO = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
const PERCENT = /(\d{1,3}(?:[.,]\d{1,2})?)\s?%/g;
function fatosDoTexto(texto, entidade) {
  const fatos = [];
  for (const m of String(texto).matchAll(DINHEIRO)) { const v = Math.round(Number(m[1].replace(/\./g, "").replace(",", ".")) * 100); if (Number.isFinite(v)) fatos.push({ valorCentavos: v, significado: "CONHECIMENTO:parametro", entidade, periodo: null }); }
  for (const m of String(texto).matchAll(PERCENT)) { const v = Number(m[1].replace(",", ".")); if (Number.isFinite(v)) fatos.push({ percentual: v, significado: "CONHECIMENTO:parametro", entidade, periodo: null }); }
  return fatos;
}

export function ferramentasDeConhecimento() {
  return [
    {
      nome: "buscar_conhecimento",
      descricao: "Base de CONHECIMENTO do Crescer com Delivery: como cada módulo e tela funciona, metodologias (DRE, faturamento líquido, CMV, competência × caixa), procedimentos (caixa, sangria, compras, entregadores, fechamento), integrações (iFood, Foody, SAIPOS, Stone, WhatsApp), regras e políticas APROVADAS e particularidades das unidades. Use para 'como funciona', 'por que', 'o que acontece quando', 'como devo', 'qual a regra'. NÃO traz valores atuais: saldo, contas, vendas e pendências vêm das outras ferramentas.",
      esquema: { type: "object", properties: { pergunta: { type: "string", maxLength: 300, description: "o assunto, nas palavras da pessoa" } }, required: ["pergunta"] },
      valores: false, ops: [], semCache: true,
      async executar({ args, sessao }) {
        if (!sessao.conhecimento) return { erro: "MODULO_INDISPONIVEL", dados: { mensagem: "A base de conhecimento não está ligada." } };
        const itens = await sessao.conhecimento.buscar({ organizacaoId: sessao.organizacaoId, unidadeId: sessao.unidadeId, pergunta: args.pergunta, hoje: sessao.hoje ?? undefined });
        if (!itens.length) return { situacao: "SEM_REGISTROS", dados: { itens: [], comoUsar: "Não há conhecimento registrado sobre isso. Explique só o que for conhecimento geral, dizendo que é explicação geral (não regra da empresa), ou diga que não há regra registrada. Nunca invente regra interna." } };
        return {
          dados: { itens, comoUsar: "Formule a resposta com as SUAS palavras a partir destes trechos, adaptada à pergunta. REGRA_APROVADA = regra oficial da empresa (pode dizer 'a regra aprovada é…'). DOCUMENTACAO_DO_SISTEMA = como o sistema funciona. DOCUMENTACAO_EM_REVISAO = funcionamento descrito na documentação ainda sem aprovação: diga 'pela documentação do sistema', nunca 'a regra da empresa é'. PROPOSTA_PENDENTE = regra/política AINDA NÃO APROVADA: só pode ser citada como proposta pendente de aprovação ('ainda não há regra oficial; existe uma proposta de…'), NUNCA como regra, prazo ou limite oficial. Números atuais (saldo, contas, vendas) NÃO estão aqui: use as ferramentas de consulta." },
          fatos: itens.flatMap((x) => fatosDoTexto(x.conteudo, x.titulo)),
        };
      },
    },
    {
      nome: "sugerir_conhecimento",
      descricao: "Registra uma SUGESTÃO de conhecimento (fica PENDENTE para uma pessoa responsável aprovar; você nunca aprova). Use quando a pessoa ensinar um procedimento, corrigir uma explicação ou pedir para 'guardar' uma regra. Não guarde valores atuais (saldo, conta, venda).",
      esquema: { type: "object", properties: {
        chave: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{2,80}$" }, tipo: { type: "string", enum: Object.values(TIPO_CONHECIMENTO) },
        titulo: { type: "string", maxLength: 160 }, conteudo: { type: "string", maxLength: 4000 }, daUnidade: { type: "boolean", description: "vale só para esta unidade" },
      }, required: ["chave", "tipo", "titulo", "conteudo"] },
      valores: false, ops: [], escrita: "PROPOSTA",
      async executar({ args, sessao }) {
        if (!sessao.conhecimento) return { erro: "MODULO_INDISPONIVEL", dados: { mensagem: "A base de conhecimento não está ligada." } };
        try {
          const x = await sessao.conhecimento.sugerir({ ...args, organizacaoId: sessao.organizacaoId, unidadeId: args.daUnidade ? sessao.unidadeId : null, origem: `conversa:${sessao.requisicaoId ?? "?"}`,
            responsavel: "a definir na aprovação", sugeridoPor: `MOVA (pedido de ${sessao.usuarioId ?? "participante"})`, sugeridoPelaIa: true });
          return { dados: { registrado: "SUGESTAO_PENDENTE", ref: `${x.chave}@v${x.versao}`, comoResponder: "Diga que a sugestão foi guardada para APROVAÇÃO de uma pessoa responsável e que, até lá, não é regra oficial." }, fatos: [] };
        } catch (e) {
          if (e instanceof ErroDeConhecimento) return { erro: e.codigo, dados: { mensagem: e.message } };
          throw e;
        }
      },
    },
  ];
}
