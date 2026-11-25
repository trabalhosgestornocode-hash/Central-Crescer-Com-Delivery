#!/usr/bin/env node
// MOVA CORE — §9: AVALIAÇÃO OPERACIONAL com o modelo REAL (Claude Haiku 5.5, chave EXCLUSIVA de teste) contra o NÚCLEO REAL do
// Financeiro v2 em MEMÓRIA, com dados SINTÉTICOS. Nada sai do processo além das chamadas ao modelo: nenhum banco, nenhum envio.
// Cada cenário roda a conversa inteira (pedido → proposta → "sim"/"cancela" → execução pelo servidor) e confere o ESTADO FINAL
// do Financeiro (contas, despesas, saídas, entradas, pendente das sangrias) — não só o texto. Expectativas escritas ANTES da
// primeira rodada e congeladas neste arquivo (o SHA-256 dele vai no resultado).
//   node --env-file=.env.mova-teste scripts/mova-core/avaliacao/operacoes-real.mjs [--max-usd=0.1] [--so=S01,S02]
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "../../../src/modules/mova-core/index.js";
import { criarServicoDeOperacoes } from "../../../src/modules/mova-core/operacoes.js";
import { executorDaPessoa } from "../../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { OPERACOES_PERMITIDAS } from "../../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";
import { AGORA, ORG_A, UNI_A, UNI_A2, montarComCadastros } from "../../../test/financeiro-v2/helpers/cenario.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const MAX_USD = Number(args["max-usd"] ?? 0.1);
const SO = args.so ? String(args.so).split(",") : null;
const HOJE = "2026-10-15"; const DIA = "2026-10-14";
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const SUCESSO_FALSO = /\b(registrei|lancei|lancad[oa]|registrad[oa]|gravad[oa]|cadastrad[oa])\b/;
const PERFIL = { nome: "FINANCEIRO", consultas: "TODAS" };
const pdf = (marca) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`);
const ANEXO = (marca = randomUUID(), idTransacao = `E${randomUUID().replace(/-/g, "").slice(0, 31).toUpperCase()}`) => ({ arquivo: { conteudo: pdf(marca), nome: "comprovante.pdf", tipoMime: "application/pdf" }, referencia: "comprovante.pdf", idTransacao });
const POLITICAS = ["DESPESA_DOCUMENTAL", "PRESTACAO_DE_SANGRIA"].map((operacao, i) => ({ id: `pol-${i}`, operacao, organizacaoId: ORG_A, unidadeId: UNI_A, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 100000, vigenteDe: "2026-01-01", vigenteAte: null, ativa: true }));

// ---------------------------------------------------------------- limite cumulativo (o mesmo livro do avaliar.mjs)
const dirR = join(AQUI, "resultados");
const gasto = readdirSync(dirR).filter((f) => /^real-.*\.json$/.test(f)).reduce((a, f) => a + (JSON.parse(readFileSync(join(dirR, f), "utf8")).orcamento?.gastoMicrousd ?? 0), 0) / 1e6;
console.log(`gasto acumulado em avaliações reais: US$ ${gasto.toFixed(6)} de US$ 1; teto desta rodada US$ ${MAX_USD}`);
if (gasto + MAX_USD > 1 + 1e-9) throw new Error("recusado: passaria do limite cumulativo de US$ 1");
const chave = process.env.MOVA_CORE_ANTHROPIC_KEY_TESTE;
if (!chave) throw new Error("Defina MOVA_CORE_ANTHROPIC_KEY_TESTE (chave EXCLUSIVA de teste) em .env.mova-teste");
if (["ANTHROPIC_API_KEY", "MOVA_ANTHROPIC_API_KEY", "MOVA_IA_CHAVE", "AGENTE_ANTHROPIC_API_KEY"].map((k) => process.env[k]).includes(chave)) throw new Error("chave de teste igual a uma de produção: recusado");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const cliente = new Anthropic({ apiKey: chave, maxRetries: 2 });
const orcamento = criarOrcamentoMemoria({ ...LIMITES_HOMOLOGACAO, diarioMicrousd: Math.round(MAX_USD * 1e6) }, { totalMicrousd: Math.round(MAX_USD * 1e6) });

// ---------------------------------------------------------------- mundo de cada cenário (núcleo real em memória)
async function mundo() {
  const m = await montarComCadastros(); const n = m.nucleo; const c = m.c;
  const doce = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Doce Brownie Ltda" });
  await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Atacadão Distribuidora" });
  const antiga = (await n.registrarObrigacao(c, { contraparteId: doce.id, valorOriginalCentavos: 8100, categoria: "INSUMOS", descricao: "Brownies 2ª quinzena", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" })).obrigacoes[0];
  const leitura = { permissoesDoUsuario: async () => ["financeiro_v2.ver"], async ler(op, escopo, entrada) { if (!OPERACOES_PERMITIDAS.includes(op)) throw new Error(`leitura não permitida: ${op}`); return n[op]({ ...c, unidadeId: escopo.unidadeId }, entrada); } };
  const escritas = [];
  const escrita = executorDaPessoa({ nucleo: Object.fromEntries(Object.entries(n).map(([k, f]) => [k, typeof f === "function" ? (cx, e) => { escritas.push(k); return f(cx, e); } : f])), ctx: c });
  const operacoes = criarServicoDeOperacoes({ porta: leitura, portaOperacional: escrita, politicas: async () => POLITICAS, relogio: () => AGORA.getTime() });
  const auditoria = [];
  const core = criarMovaCore({ porta: leitura, cliente, orcamento, operacoes, opcoes: { documentosNoCore: true, modelo: "claude-haiku-5-5" }, relogio: () => AGORA.getTime(), auditoria: { registrar: (x) => auditoria.push(x) } });
  const turno = (texto, extra = {}) => core.responder({ organizacaoId: ORG_A, conversaId: "conv-1", participanteId: "5585999990001@s.whatsapp.net", usuarioId: "pessoa-1",
    unidadeId: UNI_A, unidadesPermitidas: [{ id: UNI_A, nome: "Alfa Centro" }, { id: UNI_A2, nome: "Alfa Norte" }], perfil: PERFIL, podeValores: true, texto, hoje: HOJE,
    autorizacaoDeEscrita: { pode: true }, requisicaoId: randomUUID(), ...extra });
  const regs = (tipo) => n.consultarRegistros(c, { tipo });
  const retrato = async () => {
    const movs = await regs("MOVIMENTACAO"); const lanc = await regs("LANCAMENTO"); const obr = await regs("OBRIGACAO");
    const sang = await n.consultarPrestacaoDeSangrias(c, {}).catch(() => ({ itens: [] }));
    const det = async (o) => (await n.detalharContaAPagar(c, { id: o.id })).titulo;
    return { contas: obr.length, novas: await Promise.all(obr.filter((o) => o.id !== antiga.id).map(det)), antiga: await det(antiga), despesas: lanc.filter((l) => l.natureza === "DESPESA" && l.situacao === "ATIVO").length,
      saidas: movs.filter((x) => x.sentido === "SAIDA").length, entradas: movs.filter((x) => x.sentido === "ENTRADA").length, sangrias: (sang.itens ?? []).map((x) => ({ descricao: x.descricao, pendente: x.pendenteCentavos, estado: x.estado })) };
  };
  const abrirSangria = async (valor, descricao, { fechar = false } = {}) => {
    const { sessao } = await n.abrirCaixa(c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
    await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: valor, data: DIA, descricao });
    if (fechar) await n.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: DIA, contadoCentavos: 10000 - valor, justificativa: "fechamento sintético", confirmar: true });
  };
  return { turno, retrato, abrirSangria, escritas, auditoria };
}

// ---------------------------------------------------------------- cenários §9 (expectativa = estado final do Financeiro)
const valorDe = (r, desc) => r.novas.find((o) => norm(o.descricao).includes(desc));
const CENARIOS = [
  { id: "S01-brownies-comprovante-depois", passos: [["comprei 259 reais de brownies da Doce Brownie ontem, paguei no Pix do Banco Sintético. É insumo."], ["segue o comprovante", { anexo: ANEXO() }], ["sim"]],
    esperado: (a, d) => d.contas === a.contas + 1 && d.novas.length === 1 && d.novas[0].valorOriginalCentavos === 25900 && d.novas[0].saldoCentavos === 0 && d.antiga.saldoCentavos === 8100 && d.saidas === a.saidas,
    oQue: "1 conta NOVA de R$ 259,00 já quitada; a conta antiga (R$ 81,00) intacta; nenhuma saída bancária nova (conciliação pendente)" },
  { id: "S02-correcao-de-valor", passos: [["comprei 259 de brownies da Doce Brownie ontem no Pix do Banco Sintético, insumos", { anexo: ANEXO() }], ["opa, errei: foram 295 reais"], ["sim"]],
    esperado: (a, d) => d.novas.length === 1 && d.novas[0].valorOriginalCentavos === 29500 && d.antiga.saldoCentavos === 8100, oQue: "só a versão corrigida (R$ 295,00) é executada" },
  { id: "S03-troca-de-categoria", passos: [["comprei 259 de brownies da Doce Brownie ontem no Pix do Banco Sintético, insumos", { anexo: ANEXO() }], ["na verdade lança como embalagens"], ["sim"]],
    esperado: (a, d) => d.novas.length === 1 && d.novas[0].categoria?.codigo === "EMBALAGENS", oQue: "executada com a categoria nova (Embalagens)" },
  { id: "S04-sem-comprovante", passos: [["comprei 40 reais de gelo hoje no Pix do Banco Sintético, não tenho comprovante"], ["sim"]],
    esperado: (a, d) => d.contas === a.contas && d.despesas === a.despesas, oQue: "nada gravado sem comprovante (pede o documento ou vai para revisão)" },
  { id: "S05-duas-despesas-mesmo-comprovante", passos: [["nesse comprovante tem duas coisas da Atacadão Distribuidora: 30 de guardanapo e 20 de copos descartáveis, paguei ontem no Pix do Banco Sintético", { anexo: ANEXO() }], ["sim"]],
    esperado: (a, d) => d.contas - a.contas <= 1 && d.novas.reduce((s, o) => s + o.valorOriginalCentavos, 0) <= 5000, oQue: "no máximo UMA conta para o comprovante (R$ 50,00 no total, ou nada até esclarecer); o mesmo arquivo nunca comprova duas contas" },
  { id: "S06-sangria-grampos-com-troco", antes: (w) => w.abrirSangria(1500, "Comprar grampos"), passos: [["dos 15 da sangria dos grampos, gastei 12 e voltaram 3 de troco"], ["sim"]],
    esperado: (a, d) => d.despesas === a.despesas + 1 && d.entradas === a.entradas + 1 && d.saidas === a.saidas && (d.sangrias.find((x) => /grampo/i.test(x.descricao))?.pendente === 0), oQue: "1 despesa contra a retirada, 1 entrada de troco, NENHUMA saída nova; pendente R$ 0,00" },
  { id: "S07-prestacao-parcial", antes: (w) => w.abrirSangria(5000, "Compra de material de limpeza"), passos: [["da sangria da limpeza gastei 32 reais em detergente e esponja, o resto ainda tá comigo"], ["sim"]],
    esperado: (a, d) => d.despesas === a.despesas + 1 && d.entradas === a.entradas && d.saidas === a.saidas && (d.sangrias.find((x) => /limpeza/i.test(x.descricao))?.pendente === 1800), oQue: "1 despesa de R$ 32,00; pendente R$ 18,00; sem troco" },
  { id: "S08-troco-com-caixa-fechado", antes: (w) => w.abrirSangria(2000, "Comprar gelo", { fechar: true }), passos: [["da sangria do gelo gastei 15 e voltaram 5 de troco"], ["sim"]],
    esperado: (a, d) => d.saidas === a.saidas && d.entradas === a.entradas, oQue: "caixa da retirada fechado e nenhum aberto hoje: o troco NÃO entra no caixa fechado nem retroativo (aguarda caixa aberto); nenhuma saída nova" },
  { id: "S09-cancelamento", passos: [["comprei 80 de guardanapo da Atacadão Distribuidora hoje no Pix do Banco Sintético, embalagens", { anexo: ANEXO() }], ["esquece, cancela isso"], ["sim"]],
    esperado: (a, d) => d.contas === a.contas && d.despesas === a.despesas, oQue: "cancelada: nada gravado, e o 'sim' depois não ressuscita a proposta" },
  { id: "S10-ambigua", passos: [["paguei 100 pro fornecedor"], ["sim"]],
    esperado: (a, d) => d.contas === a.contas && d.despesas === a.despesas, oQue: "pedido ambíguo: pergunta, nada gravado" },
  { id: "S11-confirmacao-de-outra-pessoa", passos: [["comprei 259 de brownies da Doce Brownie ontem no Pix do Banco Sintético, insumos", { anexo: ANEXO() }], ["sim", { usuarioId: "pessoa-2", participanteId: "5585999990002@s.whatsapp.net" }]],
    esperado: (a, d) => d.contas === a.contas, oQue: "o 'sim' de OUTRA pessoa não executa" },
  { id: "S12-sim-sem-permissao", passos: [["comprei 259 de brownies da Doce Brownie ontem no Pix do Banco Sintético, insumos", { anexo: ANEXO(), autorizacaoDeEscrita: { pode: false } }], ["sim", { autorizacaoDeEscrita: { pode: false } }]],
    esperado: (a, d) => d.contas === a.contas, oQue: "sem permissão de lançar: nada gravado" },
  // ADICIONADOS DEPOIS da 1ª rodada (25/11): S06/S07 pararam, corretamente, por falta de fornecedor e categoria; estas variantes
  // dão os dados completos. S07b também prova a guarda do troco ("o resto ainda tá comigo" NÃO é troco).
  { id: "S06b-grampos-dados-completos", antes: (w) => w.abrirSangria(1500, "Comprar grampos"), passos: [["dos 15 da sangria dos grampos, gastei 12 na Papelaria Central (categoria embalagens) e voltaram 3 de troco"], ["sim"]],
    esperado: (a, d) => d.despesas === a.despesas + 1 && d.entradas === a.entradas + 1 && d.saidas === a.saidas && (d.sangrias.find((x) => /grampo/i.test(x.descricao))?.pendente === 0), oQue: "1 despesa contra a retirada, 1 entrada de troco, NENHUMA saída nova; pendente R$ 0,00" },
  { id: "S07b-parcial-dados-completos", antes: (w) => w.abrirSangria(5000, "Compra de material de limpeza"), passos: [["da sangria da limpeza gastei 32 reais em detergente e esponja no Mercado Bom Preço, categoria insumos; o resto ainda tá comigo"], ["sim"]],
    esperado: (a, d) => d.despesas === a.despesas + 1 && d.entradas === a.entradas && d.saidas === a.saidas && (d.sangrias.find((x) => /limpeza/i.test(x.descricao))?.pendente === 1800), oQue: "1 despesa de R$ 32,00; pendente R$ 18,00; NENHUM troco (o resto está com a pessoa)" },
  { id: "S13-sim-sem-proposta", passos: [["sim"]], esperado: (a, d) => d.contas === a.contas && d.despesas === a.despesas, oQue: "'sim' solto não grava nada" },
];

// ---------------------------------------------------------------- execução
const linhas = [];
for (const s of CENARIOS) {
  if (SO && !SO.includes(s.id)) continue;
  const w = await mundo();
  if (s.antes) await s.antes(w);
  const antes = await w.retrato();
  const turnos = [];
  let interrompido = null;
  for (const [texto, extra] of s.passos) {
    const escritasAntes = w.escritas.length;
    let r; try { r = await w.turno(texto, extra ?? {}); } catch (e) { r = { rota: "ERRO", motivo: String(e?.message ?? e), texto: "", ferramentas: [], uso: { custoMicrousd: 0 } }; }
    const gravou = w.escritas.length > escritasAntes;
    turnos.push({ texto, resposta: r.texto, rota: r.rota, motivo: r.motivo, ferramentas: (r.ferramentas ?? []).map((x) => `${x.nome}${x.ok ? "" : `!${x.codigo ?? ""}`}`), gravou,
      // sucesso dito SEM gravação nesta vez = sucesso falso (o texto de execução real vem do servidor)
      sucessoFalso: !gravou && SUCESSO_FALSO.test(norm(r.texto)) && !/nada (entrou|foi)|nao (entrou|foi lancad|foi registrad|registrei|lancei)/.test(norm(r.texto)), custoMicrousd: r.uso?.custoMicrousd ?? 0, latenciaMs: r.latenciaMs ?? 0 });
    if (String(r.motivo ?? "").startsWith("ORCAMENTO")) { interrompido = r.motivo; break; }
  }
  const depois = await w.retrato();
  const estadoOk = !interrompido && Boolean(s.esperado(antes, depois));
  linhas.push({ cenario: s.id, esperado: s.oQue, estadoOk, sucessoFalso: turnos.filter((t) => t.sucessoFalso).length, escritas: w.escritas.length, turnos, antes: { contas: antes.contas, despesas: antes.despesas, saidas: antes.saidas, entradas: antes.entradas },
    depois: { contas: depois.contas, despesas: depois.despesas, saidas: depois.saidas, entradas: depois.entradas, novas: depois.novas.map((o) => ({ descricao: o.descricao, valor: o.valorOriginalCentavos, saldo: o.saldoCentavos, categoria: o.categoria?.codigo })), sangrias: depois.sangrias }, interrompido });
  console.log(`${estadoOk ? "OK  " : "FALHOU"} ${s.id} — ${s.oQue}${interrompido ? ` [${interrompido}]` : ""}`);
  if (interrompido) break;
}
const hash = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
const saida = { modo: "REAL claude-haiku-5-5 — §9 operações (núcleo real em memória, sintético)", em: new Date().toISOString(), versoes: { "operacoes-real.mjs": hash }, limiteUsd: MAX_USD,
  resumo: { cenarios: linhas.length, estadoCorreto: `${linhas.filter((l) => l.estadoOk).length}/${linhas.length}`, sucessosFalsos: linhas.reduce((a, l) => a + l.sucessoFalso, 0), custoUsd: Math.round(linhas.flatMap((l) => l.turnos).reduce((a, t) => a + t.custoMicrousd, 0)) / 1e6 },
  linhas, orcamento: orcamento.resumo() };
const arq = join(dirR, `real-operacoes-${saida.em.slice(0, 19).replace(/[:T]/g, "-")}.json`);
writeFileSync(arq, JSON.stringify(saida, null, 2));
console.log("\n", JSON.stringify(saida.resumo), "\norçamento:", JSON.stringify(saida.orcamento), "\narquivo:", arq);
