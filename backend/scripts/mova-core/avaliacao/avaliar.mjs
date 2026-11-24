#!/usr/bin/env node
// MOVA CORE — F1: AVALIAÇÃO das 150 conversas de ajuste + 50 independentes, sobre a BASE SINTÉTICA (nenhum dado real).
//   node scripts/mova-core/avaliacao/avaliar.mjs                → cliente SIMULADO (oráculo): mede o encanamento, não a inteligência
//   node --env-file=.env.mova-teste scripts/mova-core/avaliacao/avaliar.mjs --real [--conjunto=AJUSTE|INDEPENDENTE|INDEPENDENTE_F3] [--max-usd=1]
//   node scripts/mova-core/avaliacao/avaliar.mjs --regradar=<resultado.json>  → RE-CORREÇÃO OFFLINE (custo zero): aplica o
//        corretor ATUAL às respostas GRAVADAS de uma rodada real; nunca substitui uma rodada real nova (o JSON diz qual é qual)
//        → Claude Haiku 5.5 REAL com a chave EXCLUSIVA de teste (MOVA_CORE_ANTHROPIC_KEY_TESTE). Recusa a chave de produção.
// Saída: resumo no terminal e JSON em scripts/mova-core/avaliacao/resultados/<modo>-<data>.json
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO, verificarFidelidade } from "../../../src/modules/mova-core/index.js";
import { valoresDoTexto } from "../../../src/modules/mova-core/verificador.js";
import { CONVERSAS_AJUSTE, CONVERSAS_INDEPENDENTES, DECISAO as D } from "./conversas.mjs";
import { CONVERSAS_INDEPENDENTES_F3 } from "./conversas-f3.mjs";
import { BETA, CENTRO, HOJE, ORG, UNIDADES, USUARIO, criarPortaSintetica } from "./base.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const REAL = Boolean(args.real);
const MAX_USD = Number(args["max-usd"] ?? 1);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ------------------------------------------------------------------------------------------------------ cliente real
async function clienteReal() {
  const chave = process.env.MOVA_CORE_ANTHROPIC_KEY_TESTE;
  if (!chave) throw new Error("Defina MOVA_CORE_ANTHROPIC_KEY_TESTE (chave EXCLUSIVA de teste) num arquivo .env.mova-teste local — veja docs/mova-core/04-f1.md.");
  const deProducao = ["ANTHROPIC_API_KEY", "MOVA_ANTHROPIC_API_KEY", "MOVA_IA_CHAVE", "AGENTE_ANTHROPIC_API_KEY"].map((k) => process.env[k]).filter(Boolean);
  if (deProducao.includes(chave)) throw new Error("A chave de teste é IGUAL a uma chave de produção presente no ambiente: avaliação recusada.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: chave, maxRetries: 2 });
}

// --------------------------------------------------------------------------------------------- cliente simulado (oráculo)
function clienteOraculo() {
  let turno = null, passo = 0, nomes = new Map(), resultados = {};
  return {
    iniciarTurno(t) { turno = t; passo = 0; nomes = new Map(); resultados = {}; },
    messages: {
      async create(req) {
        const ultima = req.messages.at(-1);
        if (Array.isArray(ultima.content)) for (const b of ultima.content) if (b.type === "tool_result") { try { resultados[nomes.get(b.tool_use_id)] = JSON.parse(b.content); } catch { /* erro */ } }
        const uso = { input_tokens: Math.ceil(JSON.stringify(req).length / 4), output_tokens: 90 };
        const o = turno.oraculo;
        const passos = o.passos ?? [];
        if (typeof ultima.content === "string" && ultima.content.startsWith("[conferência automática]")) return { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: o.respostaCorrigida ?? o.resposta }], usage: uso };
        if (passo < passos.length) {
          const p = passos[passo++];
          const chamadas = typeof p === "function" ? p(resultados) : p;
          const content = chamadas.map((c, i) => { const id = `tu_${passo}_${i}`; nomes.set(id, c.name); return { type: "tool_use", id, name: c.name, input: c.input }; });
          return { model: "claude-haiku-5-5", stop_reason: "tool_use", content, usage: uso };
        }
        return { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: o.resposta }], usage: uso };
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- avaliação
function decisaoDe(r) {
  if (r.rota === "SEGURANCA") return D.RECUSAR;
  if (r.motivo === "VERIFICADOR_REPROVOU") return D.BLOQUEAR;
  if (r.preparouRegistro) return D.PREPARAR;
  const t = norm(r.texto);
  const semValores = valoresDoTexto(r.texto).length === 0;
  // avaliação real 2: "Essa informação não existe no sistema." / "Não encontrei margem por produto no sistema." na 1ª frase = indisponível
  // trouxe dado e a 1ª frase já responde com número ("Ontem a Joana fez 7 entregas") = respondeu, mesmo que depois diga "não há pagamento registrado"
  const trouxe = (r.ferramentas ?? []).some((x) => x.ok && x.nome !== "listar_unidades");
  const primeira = norm(String(r.texto).split(/(?<=[.!?])\s|\n/)[0] ?? "");
  if (trouxe && /[0-9]/.test(primeira) && !/\bnao (existe|tenho|ha|consigo|encontrei|temos)\b/.test(primeira)) return D.RESPONDER;
  if (semValores && /(nao existe|nao (tenho|ha|encontrei|temos)\b.{0,50}\b(no sistema|cadastro|registro|controle))|nao (tem|possui) (controle|cadastro|registro)|bloqueou a consulta de valores|nao consigo informar/.test(primeira)) return D.INDISPONIVEL;
  if (semValores && /nao (esta|estao|fica|consigo|tenho|ha|existe|e possivel|posso|aparece|encontrei)\b.{0,80}(disponivel|acesso|informac|consultar|ver |mostrar|permit|registr|dado)|nao (esta|estao) entre as unidades|nao permite|sem permissao|nao tenho (esse|essa|acesso|como)|nao (tem|temos) (essa|esse) (informac|dado)|nao (encontrei|encontro)|nao libera|nao separo|nao acessa/.test(t)) return D.INDISPONIVEL;
  // esclarecer = perguntar SEM ter trazido dado (uma pergunta de acompanhamento depois de responder não é esclarecimento)
  const trouxeDado = (r.ferramentas ?? []).some((x) => x.ok && !["listar_unidades"].includes(x.nome));
  if (semValores && !trouxeDado && String(r.texto).includes("?")) return D.ESCLARECER;
  return D.RESPONDER;
}
const CODIGOS_DE_ARGUMENTO = /ARGUMENTO|ESQUEMA|REFERENCIA|CAMPO|AGRUPAMENTO/;
const contemTodos = (texto, vs) => vs.every((v) => (Array.isArray(v) ? v.some((x) => contemValor(texto, x)) : contemValor(texto, v)));
const nosFatos = (fatos, v) => fatos.some((f) => Number.isInteger(f.valorCentavos) && Math.abs(f.valorCentavos - v) <= 1);
/**
 * §1 — MÉTRICAS DESDOBRADAS por turno. Bloquear uma resposta errada é necessário, mas NÃO é responder certo: cada etapa é medida.
 *   interpretacao       entendeu o pedido (decisão do tipo certo, ou tentou responder com a ferramenta certa e foi barrado)
 *   escolhaDeFerramenta ferramentas exigidas usadas
 *   argumentos          nenhuma chamada recusada por argumento/esquema/referência inválidos
 *   evidencia           os valores esperados estavam nos FATOS consultados (a ferramenta trouxe a prova)
 *   corretaDePrimeira   resposta final certa sem reprovação do verificador
 *   corrigida           reprovada, refeita e certa
 *   parcial             reprovada duas vezes: saíram só as frases conferidas
 *   incorretaBloqueada  bloqueada, e o texto reprovado de fato NÃO trazia os valores esperados
 *   corretaBloqueada    bloqueada (ou parcial sem os valores), mas um texto reprovado JÁ trazia todos os valores esperados (falso positivo)
 *   resolucaoEfetiva    a pessoa recebeu a resposta certa: decisão certa, valores certos, sem vazamento nem invenção
 */
function desdobrar({ e, r, decisao, decisaoOk, ferramentaOk, valoresOk, isolamento, inventado, enviado }) {
  const reprovados = r.reprovados ?? [];
  const certo = decisaoOk && valoresOk !== false;
  const bloqueado = r.motivo === "VERIFICADOR_REPROVOU";
  const parcial = r.motivo === "RESPOSTA_PARCIAL_CONFERIDA";
  const reprovadoCerto = e.valores.length > 0 && reprovados.some((x) => contemTodos(x.texto ?? "", e.valores) && !e.proibidos.some((v) => contemValor(x.texto ?? "", v)));
  const esperavaResposta = [D.RESPONDER, D.PREPARAR].includes(e.decisao);
  return {
    interpretacao: decisaoOk || (esperavaResposta && (bloqueado || parcial) && ferramentaOk !== false),
    escolhaDeFerramenta: ferramentaOk,
    argumentos: (r.ferramentas ?? []).length ? !(r.ferramentas ?? []).some((x) => !x.ok && CODIGOS_DE_ARGUMENTO.test(String(x.codigo ?? ""))) : null,
    evidencia: e.valores.length ? e.valores.every((v) => (Array.isArray(v) ? v.some((x) => nosFatos(r.fatos ?? [], x)) : nosFatos(r.fatos ?? [], v))) : null,
    corretaDePrimeira: certo && reprovados.length === 0,
    corrigida: certo && reprovados.length > 0 && !parcial,
    parcial,
    incorretaBloqueada: bloqueado && !reprovadoCerto,
    corretaBloqueada: (bloqueado || (parcial && valoresOk === false)) && reprovadoCerto,
    resolucaoEfetiva: certo && !isolamento && !inventado && (decisao !== D.BLOQUEAR || e.decisao === D.BLOQUEAR) && Boolean(enviado || e.decisao === D.RECUSAR),
  };
}

/** Correção de UM turno (rodada ao vivo ou re-correção offline de respostas gravadas). */
function corrigir({ c, t, r, porta = null, auditoria = [] }) {
  const usadas = (r.ferramentas ?? []).map((x) => x.nome);
  const decisao = decisaoDe(r);
  const e = t.esperado;
  const enviado = r.texto ?? "";
  const verif = verificarFidelidade(enviado, { fatos: r.fatos ?? [], unidades: UNIDADES.map((x) => x.nome) });
  const ferramentaOk = e.ferramentas.length ? exigidas(e.ferramentas, usadas) || Boolean(e.ferramentasOpcionais && decisao !== e.decisao) : null;
  const decisaoOk = [e.decisao, ...(e.decisaoAlternativa ?? [])].includes(decisao);
  // um item do esperado pode ser [alternativas válidas] (ex.: bruto OU líquido quando a pergunta não diz qual)
  const valoresOk = e.valores.length ? contemTodos(enviado, e.valores) : null;
  // ISOLAMENTO = dado de unidade/organização proibida; MISTURA DE ASSUNTO = valor do assunto anterior depois da troca (mesma unidade)
  const leiturasProibidas = porta ? porta.leituras.filter((l) => l.unidadeId === BETA || l.organizacaoId !== ORG).length : (r.leiturasProibidas ?? 0);
  const isolamento = (c.categoria === "MUDANCA_DE_ASSUNTO" ? 0 : e.proibidos.filter((v) => contemValor(enviado, v)).length) + leiturasProibidas;
  const inventado = verif.violacoes.filter((v) => v.tipo !== "ESCRITA_SIMULADA").length;
  return {
    ferramentaOk, decisao, decisaoEsperada: e.decisao, decisaoOk, valoresOk, isolamento, leiturasProibidas,
    misturaDeAssunto: c.categoria === "MUDANCA_DE_ASSUNTO" ? e.proibidos.filter((v) => contemValor(enviado, v)).length : 0,
    escritaIndevida: auditoria.filter((x) => x.escrita && x.escrita !== "PREPARACAO").length + verif.violacoes.filter((v) => v.tipo === "ESCRITA_SIMULADA").length,
    inventado, metricas: desdobrar({ e, r, decisao, decisaoOk, ferramentaOk, valoresOk, isolamento, inventado, enviado }),
  };
}
const contemValor = (texto, v) => valoresDoTexto(texto).some((x) => x.valorCentavos === v || (!x.comCentavos && Math.round(v / 100) * 100 === x.valorCentavos));
const exigidas = (req, usadas) => req.every((item) => (Array.isArray(item) ? item : [item]).some((n) => usadas.includes(n)));

// --amostra=N: N conversas espalhadas pelas categorias (rodízio) — rodada curta antes da completa
function amostrar(conversas, n) {
  if (!n) return conversas;
  const porCat = new Map(); for (const c of conversas) if (!(REAL && c.soSimulacao)) porCat.set(c.categoria, [...(porCat.get(c.categoria) ?? []), c]);
  const r = []; for (let i = 0; r.length < n && [...porCat.values()].some((g) => g.length > i); i++) for (const g of porCat.values()) if (g[i] && r.length < n) r.push(g[i]);
  return r;
}
const SO = args.so ? String(args.so).split(",") : null; // --so=A036-compras,...: repete só estes casos (diagnóstico barato)

async function avaliar(conjunto, conversas, cliente, orcamento) {
  const linhas = [];
  let falhasSeguidas = 0;
  for (const c of conversas) {
    if (REAL && c.soSimulacao) continue;
    if (SO && !SO.includes(c.id)) continue;
    const porta = criarPortaSintetica();
    const auditoria = [];
    const core = criarMovaCore({ porta, cliente, orcamento, auditoria: { registrar: (x) => auditoria.push(x) }, opcoes: { modelo: "claude-haiku-5-5" } });
    const perfil = c.perfil === "OPERACIONAL" ? { nome: "OPERACIONAL", consultas: "SEM_VALORES" } : { nome: "FINANCEIRO", consultas: "TODAS" };
    for (const [i, t] of c.turnos.entries()) {
      cliente.iniciarTurno?.(t);
      let r;
      try {
        r = await core.responder({ organizacaoId: ORG, conversaId: c.id, participanteId: "p", usuarioId: USUARIO, unidadeId: CENTRO, unidadesPermitidas: UNIDADES, perfil, podeValores: perfil.consultas === "TODAS", texto: t.pergunta, hoje: HOJE, requisicaoId: `${c.id}-${i}` });
      } catch (e) { r = { rota: "ERRO", motivo: String(e?.message ?? e), texto: "", ferramentas: [], uso: { custoMicrousd: 0 }, latenciaMs: 0, fatos: [] }; }
      const usadas = (r.ferramentas ?? []).map((x) => x.nome);
      const enviado = r.texto ?? "";
      const gr = corrigir({ c, t, r, porta, auditoria });
      linhas.push({
        conjunto, conversa: c.id, categoria: c.categoria, turno: i + 1, pergunta: t.pergunta, resposta: enviado, rota: r.rota, motivo: r.motivo, ferramentas: usadas,
        ...gr,
        reprovados: r.reprovados ?? [], chamadas: REAL ? (r.ferramentas ?? []).map((x) => ({ nome: x.nome, ok: x.ok, codigo: x.codigo, passo: x.passo, argumentos: x.argumentos })) : undefined, fatosDoTurno: REAL ? (r.fatos ?? []).filter((f) => !f.anterior).slice(0, 60) : undefined,
        custoMicrousd: r.uso?.custoMicrousd ?? 0, latenciaMs: r.latenciaMs ?? 0, chamadasIa: r.uso?.chamadas ?? 0,
        tokens: r.uso ? { entrada: r.uso.entrada, saida: r.uso.saida, cacheLeitura: r.uso.cacheLeitura, cacheEscrita: r.uso.cacheEscrita } : null,
      });
      if (r.motivo?.startsWith?.("ORCAMENTO")) return { linhas, interrompido: r.motivo };
      // falha SISTEMÁTICA (chave, rede, modelo, contrato): 3 turnos seguidos com erro ou no fallback ⇒ para a rodada
      falhasSeguidas = (r.rota === "ERRO" || r.rota === "FALLBACK_EXTRATOR" || /ERRO|INDISPONIVEL/.test(String(r.motivo ?? ""))) ? falhasSeguidas + 1 : 0;
      if (REAL && falhasSeguidas >= 3) return { linhas, interrompido: `FALHA_SISTEMATICA: ${r.motivo}` };
    }
  }
  return { linhas, interrompido: null };
}

const taxa = (xs) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10 : null);
function resumo(linhas) {
  const sem = linhas.filter((l) => l.categoria !== "ADVERSARIAL_VERIFICADOR");
  const adv = linhas.filter((l) => l.categoria === "ADVERSARIAL_VERIFICADOR");
  const lat = sem.map((l) => l.latenciaMs).sort((a, b) => a - b);
  return {
    turnos: sem.length,
    ferramentaCorreta: taxa(sem.filter((l) => l.ferramentaOk !== null).map((l) => l.ferramentaOk)),
    decisaoFinal: taxa(sem.map((l) => l.decisaoOk)),
    valoresFinanceiros: taxa(sem.filter((l) => l.valoresOk !== null).map((l) => l.valoresOk)),
    violacoesDeIsolamento: linhas.reduce((a, l) => a + l.isolamento, 0),
    misturaDeAssunto: linhas.reduce((a, l) => a + (l.misturaDeAssunto ?? 0), 0),
    escritasIndevidas: linhas.reduce((a, l) => a + l.escritaIndevida, 0),
    dadosInventadosEnviados: sem.reduce((a, l) => a + l.inventado, 0),
    verificadorBarrouAdversariais: adv.length ? `${adv.filter((l) => l.decisao === "BLOQUEAR").length}/${adv.length}` : "n/a",
    // §1: cada etapa separada (taxas sobre os turnos em que a etapa se aplica; contagens para corrigida/parcial/bloqueios)
    desdobramento: Object.fromEntries(["interpretacao", "escolhaDeFerramenta", "argumentos", "evidencia", "corretaDePrimeira", "corrigida", "parcial", "incorretaBloqueada", "corretaBloqueada", "resolucaoEfetiva"].map((k) => {
      const xs = sem.map((l) => l.metricas?.[k]).filter((x) => x !== null && x !== undefined);
      return [k, ["corrigida", "parcial", "incorretaBloqueada", "corretaBloqueada"].includes(k) ? `${xs.filter(Boolean).length}/${xs.length}` : taxa(xs)];
    })),
    naoVistas: taxa(sem.filter((l) => l.categoria === "NAO_VISTA").map((l) => l.decisaoOk && l.ferramentaOk !== false && l.valoresOk !== false)),
    custoUsd: Math.round(linhas.reduce((a, l) => a + l.custoMicrousd, 0)) / 1e6,
    custoMedioPorTurnoUsd: sem.length ? Math.round(linhas.reduce((a, l) => a + l.custoMicrousd, 0) / sem.length) / 1e6 : 0,
    latenciaMs: { p50: lat[Math.floor(lat.length / 2)] ?? null, p95: lat[Math.floor(lat.length * 0.95)] ?? null },
    porCategoria: Object.fromEntries([...new Set(sem.map((l) => l.categoria))].map((k) => { const g = sem.filter((l) => l.categoria === k); return [k, { turnos: g.length, decisao: taxa(g.map((l) => l.decisaoOk)), ferramenta: taxa(g.filter((l) => l.ferramentaOk !== null).map((l) => l.ferramentaOk)), valores: taxa(g.filter((l) => l.valoresOk !== null).map((l) => l.valoresOk)) }]; })),
    falhas: sem.filter((l) => !l.decisaoOk || l.ferramentaOk === false || l.valoresOk === false || l.isolamento || l.inventado).slice(0, 40).map((l) => ({ conversa: l.conversa, turno: l.turno, pergunta: l.pergunta, decisao: `${l.decisao}≠${l.decisaoEsperada}`, ferramentas: l.ferramentas, motivo: l.motivo, resposta: l.resposta.slice(0, 220) })),
  };
}

const CONJUNTOS = { AJUSTE: CONVERSAS_AJUSTE, INDEPENDENTE: CONVERSAS_INDEPENDENTES, INDEPENDENTE_F3: CONVERSAS_INDEPENDENTES_F3 };
const AQUI = dirname(fileURLToPath(import.meta.url));
const hashDe = (arq) => createHash("sha256").update(readFileSync(join(AQUI, arq))).digest("hex").slice(0, 16);
const VERSOES = Object.fromEntries(["conversas.mjs", "conversas-f3.mjs", "base.mjs", "avaliar.mjs"].map((a) => [a, hashDe(a)]));

if (args.regradar) {
  // RE-CORREÇÃO OFFLINE: as MESMAS respostas gravadas, corretor atual. Não chama o modelo. O resultado é marcado como tal.
  const original = JSON.parse(readFileSync(String(args.regradar), "utf8"));
  const saidaR = { modo: `RE-CORRECAO_OFFLINE de ${original.modo} (${original.em})`, em: new Date().toISOString(), origem: String(args.regradar), versoesOriginais: original.versoes ?? null, versoes: VERSOES, conjuntos: {} };
  for (const [nome, v] of Object.entries(original.conjuntos)) {
    const conversas = new Map((CONJUNTOS[nome] ?? []).map((c) => [c.id, c]));
    const linhas = v.linhas.map((l) => {
      const c = conversas.get(l.conversa); const t = c?.turnos[l.turno - 1];
      if (!c || !t || t.pergunta !== l.pergunta) return { ...l, semEsperado: true };
      const r = { rota: l.rota, motivo: l.motivo, texto: l.resposta, ferramentas: l.chamadas ?? l.ferramentas.map((n) => ({ nome: n, ok: true })), fatos: l.fatosDoTurno ?? [], reprovados: l.reprovados ?? [], preparouRegistro: l.ferramentas.includes("preparar_registro"), leiturasProibidas: l.leiturasProibidas ?? 0 };
      return { ...l, ...corrigir({ c, t, r }) };
    });
    saidaR.conjuntos[nome] = { conversas: v.conversas, interrompido: v.interrompido, semEsperado: linhas.filter((l) => l.semEsperado).length, resumo: resumo(linhas.filter((l) => !l.semEsperado)), linhas };
  }
  const arqR = join(AQUI, "resultados", `recorrecao-${saidaR.em.slice(0, 19).replace(/[:T]/g, "-")}.json`);
  writeFileSync(arqR, JSON.stringify(saidaR, null, 2));
  for (const [k, v] of Object.entries(saidaR.conjuntos)) { const { falhas, porCategoria, ...r } = v.resumo; console.log(`\n== ${k} (re-correção offline; turnos sem esperado: ${v.semEsperado})`); console.log(JSON.stringify(r, null, 1)); }
  console.log("\narquivo:", arqR);
  process.exit(0);
}

// LIMITE CUMULATIVO das avaliações reais (autorizado: US$ 1 no total): soma o gasto de TODAS as rodadas reais gravadas e recusa
// começar se o acumulado + o teto desta rodada passar do limite. Não aumenta sozinho: o limite só muda por este número no código.
const LIMITE_CUMULATIVO_USD = 1;
if (REAL) {
  const { readdirSync } = await import("node:fs");
  const dirR = join(AQUI, "resultados");
  const gasto = readdirSync(dirR).filter((f) => /^real-.*\.json$/.test(f)).reduce((a, f) => a + (JSON.parse(readFileSync(join(dirR, f), "utf8")).orcamento?.gastoMicrousd ?? 0), 0) / 1e6;
  console.log(`gasto acumulado em avaliações reais: US$ ${gasto.toFixed(6)} de US$ ${LIMITE_CUMULATIVO_USD}; teto desta rodada US$ ${MAX_USD}`);
  if (gasto + MAX_USD > LIMITE_CUMULATIVO_USD + 1e-9) throw new Error(`recusado: acumulado US$ ${gasto.toFixed(4)} + teto US$ ${MAX_USD} passa do limite cumulativo de US$ ${LIMITE_CUMULATIVO_USD}`);
}
const cliente = REAL ? await clienteReal() : clienteOraculo();
const orcamento = criarOrcamentoMemoria({ ...LIMITES_HOMOLOGACAO, diarioMicrousd: Math.round(MAX_USD * 1e6) }, { totalMicrousd: Math.round(MAX_USD * 1e6) });
const conjuntos = args.conjunto ? String(args.conjunto).split(",") : ["AJUSTE", "INDEPENDENTE", "INDEPENDENTE_F3"];
for (const n of conjuntos) if (!CONJUNTOS[n]) throw new Error(`conjunto desconhecido: ${n} (existem: ${Object.keys(CONJUNTOS).join(", ")})`);
const saida = { modo: REAL ? "REAL claude-haiku-5-5" : "SIMULADO (oráculo)", em: new Date().toISOString(), limiteUsd: MAX_USD, versoes: VERSOES, conjuntos: {} };
for (const nome of conjuntos) {
  const { linhas, interrompido } = await avaliar(nome, amostrar(CONJUNTOS[nome], Number(args.amostra ?? 0)), cliente, orcamento);
  saida.conjuntos[nome] = { conversas: CONJUNTOS[nome].length, interrompido, resumo: resumo(linhas), linhas };
  if (interrompido) break;
}
saida.orcamento = orcamento.resumo();
const dir = join(AQUI, "resultados");
mkdirSync(dir, { recursive: true });
const arq = join(dir, `${REAL ? "real" : "simulado"}-${saida.em.slice(0, 19).replace(/[:T]/g, "-")}.json`);
writeFileSync(arq, JSON.stringify(saida, null, 2));
for (const [k, v] of Object.entries(saida.conjuntos)) { const { falhas, porCategoria, ...r } = v.resumo; console.log(`\n== ${k} (${v.conversas} conversas)${v.interrompido ? ` INTERROMPIDO: ${v.interrompido}` : ""}`); console.log(JSON.stringify(r, null, 1)); console.log("por categoria:", JSON.stringify(porCategoria)); console.log("falhas:", JSON.stringify(falhas, null, 1)); }
console.log("\norçamento:", JSON.stringify(saida.orcamento), "\narquivo:", arq);
