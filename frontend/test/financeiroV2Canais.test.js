// Fases 04–06 — telas "Canais de faturamento" (SAIPOS, fechamento manual, iFood/99Food, Operadoras e Taxas).
// Só apresentação: dados SINTÉTICOS montados aqui; nenhuma regra de dinheiro na tela.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as can from "../financeiro-v2/telasCanais.js";
import { GRADE_FECHAMENTO as GRADE_SERVIDOR } from "../../backend/src/modules/fv2-integracao/escritas.js";

const arquivo = (n) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${n}`, import.meta.url)), "utf8");
const grupo = (extra = {}) => ({ quantidade: 1, brutoCentavos: 10000, brutoCalculadoCentavos: 10000, taxaCentavos: 110, liquidoEsperadoCentavos: 9890, percentualEfetivoCentesimos: 110, brutoSemCalculoCentavos: 0, situacao: "CALCULADO", recebidoCentavos: null, diferencaCentavos: null, situacaoConferencia: "AGUARDANDO_EXTRATO", ...extra });
const PERIODO = { aba: "presencial", inicio: "2026-11-01", fim: "2026-11-15" };

test("cards: taxa pendente nunca aparece como zero; recebido não confirmado é dito; bandeiras e Pix por operadora", () => {
  const debito = { modalidade: "DEBITO", ...grupo(), bandeiras: [{ bandeira: "MASTERCARD", ...grupo() }] };
  const voucher = { modalidade: "VOUCHER", ...grupo({ taxaCentavos: 0, brutoCalculadoCentavos: 0, liquidoEsperadoCentavos: 0, percentualEfetivoCentesimos: null, brutoSemCalculoCentavos: 2500, situacao: "PENDENTE", situacaoConferencia: "PENDENTE" }), bandeiras: [{ bandeira: "—", ...grupo({ situacao: "PENDENTE" }) }] };
  const pix = { modalidade: "PIX", ...grupo(), bandeiras: [{ bandeira: "MAQUININHA_IFOOD", ...grupo() }] };
  const total = grupo({ brutoCentavos: 22500 });
  const html = can.saipos({ cards: { BALCAO: { modalidades: [debito, voucher, pix], total } } }, PERIODO);
  const cardVoucher = html.slice(html.indexOf('data-modalidade="VOUCHER"'));
  assert.match(cardVoucher, /Taxa não configurada/);
  assert.match(cardVoucher, /nunca considerado zero/);
  assert.match(html, /Não confirmado/);
  assert.match(html, /Ver por bandeira \(1\)/);
  assert.match(html, /Ver por operadora \(1\)[\s\S]*Maquininha do iFood/);
  assert.match(html, /data-detalhe="card:BALCAO\|DEBITO\|MASTERCARD\|2026-11-01\|2026-11-15"/);
  assert.match(html, /Ver lançamentos \(1\)/, "voucher sem bandeira: link direto aos lançamentos");
});

test("sem vendas: ausência de dados, nunca zero confirmado; iFood/99Food sem fonte oficial idem", () => {
  assert.match(can.saipos({ cards: { BALCAO: { modalidades: [], total: null } } }, PERIODO), /não é zero confirmado/);
  const ifood = can.plataforma({ canal: "IFOOD", competencia: "2026-11", situacao: "PRELIMINAR", totais: null, historico: [], pendencias: [{ codigo: "DEMONSTRATIVO_AUSENTE", mensagem: "Sem demonstrativo oficial (não é zero)." }], conferenciaSaipos: { pedidos: 3, cancelados: 0, totalCentavos: 9000 } });
  assert.match(ifood, /Depende do relatório oficial/);
  assert.doesNotMatch(ifood.split("só conferência")[0], /R\$ 0,00/);
  assert.match(ifood, /Preliminar/);
  const noventa = can.plataforma({ canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-11", situacao: "SEM_FONTE_OFICIAL", dependeDeRelatorioOficial: true, totais: null, historico: [], pendencias: [] });
  assert.match(noventa, /nenhum número é presumido/);
  assert.match(noventa, /envie o arquivo Dados da loja na aba Importações/);
  assert.doesNotMatch(noventa, /for implementado|ainda não foram fornecidos/);
  assert.match(noventa, /da 99Food/);
});

test("fechamento manual: a grade da tela é a mesma do servidor; sem permissão, sem formulário", () => {
  const campos = can.GRADE_FECHAMENTO.flatMap(([g, , subs]) => subs.map((s) => `${g}|${s}`)).sort();
  assert.deepEqual(campos, GRADE_SERVIDOR.map(([g, s]) => `${g}|${s}`).sort());
  const dados = { periodoFim: "2026-11-15", dias: [] };
  assert.match(can.fechamentoManual(dados, { permissoes: ["financeiro_v2.registrar"] }), /name="f_PIX_MAQUININHA_IFOOD_inf"/);
  assert.doesNotMatch(can.fechamentoManual(dados, { permissoes: ["financeiro_v2.ver"] }), /data-acao=/);
});

test("operadoras: histórico, versões de taxas e ações só para quem configura", () => {
  const d = { operadoras: [{ codigo: "MAQUININHA_IFOOD", nome: "Maquininha do iFood", processador: "MAQUININHA_IFOOD", inicio: "2026-11-01", encerramento: null, modalidades: ["PIX"], situacao: "ATIVA",
    historico: [{ evento: "CADASTRO", em: "2026-11-17T10:00:00Z", justificativa: "Teste" }], tabelas: [{ vigenciaInicio: "2026-11-01", vigenciaFim: null, fonte: "Fictícia", taxas: [{ modalidade: "PIX", bandeira: "PIX", milesimos: 800 }] }] }] };
  const adm = can.operadorasTaxas(d, { permissoes: ["financeiro_v2.configurar"] });
  assert.match(adm, /0,80%/);
  assert.match(adm, /Histórico \(1\)/);
  assert.match(adm, /operadoras\/situacao/);
  assert.match(adm, /Nova versão das taxas/);
  assert.match(adm, /name="tx\|PIX\|PIX" value="0,80"/, "a grade vem preenchida com a tabela atual");
  assert.doesNotMatch(can.operadorasTaxas(d, { permissoes: ["financeiro_v2.ver"] }), /data-acao=/);
});

test("operadoras (18/11): grade bandeira × modalidade só com as modalidades da operadora; vazio = não configurada", () => {
  const pag = { codigo: "PAGBANK", nome: "PagBank Sintética", processador: "PAGBANK", inicio: "2026-11-17", encerramento: null, modalidades: ["CREDITO_A_VISTA", "DEBITO", "PIX"], situacao: "ATIVA", historico: [], tabelas: [] };
  const html = can.operadorasTaxas({ operadoras: [pag] }, { permissoes: ["financeiro_v2.configurar"] });
  assert.match(html, /Taxas pendentes/);
  assert.match(html, /Informar taxas/);
  assert.match(html, /data-grade-taxas/);
  for (const n of ["tx|DEBITO|MASTERCARD", "tx|CREDITO_A_VISTA|ELO", "tx|PIX|PIX", "tf|DEBITO|VISA"]) assert.ok(html.includes(`name="${n}"`), n);
  assert.ok(!html.includes('name="tx|VOUCHER|'), "voucher não aparece se a operadora não recebe voucher");
  assert.match(html, /value="2026-11-17"/, "sem tabela, a vigência sugerida é o início da operadora");
  assert.match(html, /data-replicar-taxa="DEBITO"/);
  // cadastro: modalidades em caixas de marcar
  assert.match(html, /type="checkbox" name="modalidades" value="DEBITO" checked data-multiplo/);
  assert.match(html, /type="checkbox" name="modalidades" value="VOUCHER" data-multiplo/);
  // com tabela: quadro de leitura mostra "não configurada" onde falta (nunca zero)
  const comTabela = { ...pag, tabelas: [{ vigenciaInicio: "2026-11-17", vigenciaFim: null, fonte: "Sintética", taxas: [{ modalidade: "DEBITO", bandeira: "MASTERCARD", milesimos: 1420 }, { modalidade: "CREDITO_A_VISTA", bandeira: "AMEX", milesimos: 4750, tarifaFixaCentavos: 10 }] }] };
  const h2 = can.operadorasTaxas({ operadoras: [comTabela] }, { permissoes: ["financeiro_v2.ver"] });
  assert.match(h2, /1,42%/);
  assert.match(h2, /4,75% \+ R\$\s?0,10/);
  assert.match(h2, /não configurada/);
  assert.doesNotMatch(h2, /0,00%/);
  // inativa: sem formulário de taxas
  assert.doesNotMatch(can.operadorasTaxas({ operadoras: [{ ...pag, situacao: "INATIVA" }] }, { permissoes: ["financeiro_v2.configurar"] }), /data-grade-taxas/);
});

test("grade de taxas → texto do servidor: só campos preenchidos, vírgula, tarifa opcional, erros sem envio", () => {
  const ok = can.textoDaGradeDeTaxas([["tx|DEBITO|MASTERCARD", "1,42"], ["tx|DEBITO|VISA", "1.42"], ["tx|DEBITO|ELO", ""], ["tx|CREDITO_A_VISTA|AMEX", "4,75"], ["tf|CREDITO_A_VISTA|AMEX", "0,10"], ["tx|PIX|PIX", "0,5"], ["tf|DEBITO|ELO", ""]]);
  assert.deepEqual(ok.erros, []);
  assert.equal(ok.texto, ["DEBITO;MASTERCARD;1,42", "DEBITO;VISA;1,42", "CREDITO_A_VISTA;AMEX;4,75;0,10", "PIX;PIX;0,5"].join("\n"));
  assert.match(can.textoDaGradeDeTaxas([["tx|DEBITO|VISA", "abc"]]).erros[0], /inválida/);
  assert.match(can.textoDaGradeDeTaxas([["tf|DEBITO|VISA", "0,10"]]).erros[0], /tarifa fixa sem taxa/);
  assert.match(can.textoDaGradeDeTaxas([["tx|DEBITO|VISA", "0"]]).erros[0], /taxa 0 só com tarifa fixa/);
  assert.equal(can.textoDaGradeDeTaxas([["tx|DEBITO|VISA", "0"], ["tf|DEBITO|VISA", "0,25"]]).texto, "DEBITO;VISA;0;0,25");
  assert.match(can.textoDaGradeDeTaxas([]).erros[0], /ao menos uma taxa/);
});

test("menu Canais de faturamento e rotas; nenhuma soma de dinheiro nas telas novas", () => {
  const html = arquivo("index.html");
  for (const r of ["saipos", "ifood", "noventa-e-nove-food", "operadoras-taxas"]) assert.match(html, new RegExp(`href="#/${r}" data-rota="${r}"`));
  for (const g of ["Análise", "Faturamento", "Contas e caixa", "Operação", "Conferências", "Administração"]) assert.match(html, new RegExp(`class="nav-titulo" id="nav-[a-z]+">${g}<`), `grupo ${g}`);
  const src = arquivo("telasCanais.js");
  assert.ok(!/reduce\(|Centavos\s*[+-]\s*\w+Centavos/.test(src), "tela calculando dinheiro");
  assert.ok(!/<td(?![^>]*data-rotulo)[^>]*>/.test(src.replace(/const td = [^\n]+/, "").replace(/<tr><td>[^\n]*<\/td><\/tr>/g, "")), "td sem rótulo");
});

test("operadoras (18/11): painel do período por modalidade e operadora, com 'sem taxa configurada' em destaque", () => {
  const linha = (bruto, taxa, semCalc = 0) => ({ quantidade: 1, brutoCentavos: bruto, brutoCalculadoCentavos: bruto - semCalc, taxaCentavos: taxa, liquidoEsperadoCentavos: bruto - semCalc - taxa, percentualEfetivoCentesimos: 142, brutoSemCalculoCentavos: semCalc });
  const painel = { periodoInicio: "2026-11-01", periodoFim: "2026-11-30", natureza: "ESTIMATIVA", observacao: "Estimativa sintética.", total: linha(53000, 1152, 5000),
    porModalidade: [{ modalidade: "DEBITO", ...linha(20000, 242) }, { modalidade: "PIX", ...linha(8000, 40) }],
    operadoras: [{ operadora: "PAGBANK", total: linha(23000, 140, 5000), modalidades: [{ modalidade: "CREDITO_A_VISTA", ...linha(5000, 0, 5000), bandeiras: [{ bandeira: "ELO", ...linha(5000, 0, 5000) }] }] }] };
  const ops = [{ codigo: "PAGBANK", nome: "PagBank Sintética", processador: "PAGBANK", inicio: "2026-11-10", encerramento: null, modalidades: ["DEBITO"], situacao: "ATIVA", historico: [], tabelas: [] }];
  const html = can.operadorasTaxas({ operadoras: ops, painel }, { permissoes: ["financeiro_v2.ver"], filtro: { inicio: "2026-11-01", fim: "2026-11-30" } });
  for (const t of ["Painel do período", "Bruto nas maquininhas", "Taxas estimadas", "Líquido esperado", "Sem taxa configurada", "Por modalidade", "Por operadora", "PagBank Sintética", "Débito", "Pix", "Elo", "não é despesa lançada na DRE"]) assert.ok(html.includes(t), t);
  assert.match(html, /data-filtro-local="operadoras-taxas"/);
  assert.match(html, /value="2026-11-01"/);
  assert.match(html, /R\$\s?530,00/);
  assert.match(html, /R\$\s?11,52/);
  // sem painel (consulta sem período): a tela continua funcionando
  assert.doesNotMatch(can.operadorasTaxas({ operadoras: ops }, { permissoes: ["financeiro_v2.ver"] }), /Painel do período/);
});
