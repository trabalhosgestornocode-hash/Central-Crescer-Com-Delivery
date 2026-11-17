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
  assert.match(can.plataforma({ faturamentoBruto: { porCanal: [{ canal: "IFOOD", valorCentavos: 0, registros: [] }] } }, "IFOOD"), /Sem dados da fonte oficial/);
  assert.match(can.plataforma({ faturamentoBruto: { porCanal: [] } }, "NOVENTA_E_NOVE_FOOD"), /da 99Food/);
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
  assert.match(adm, /Nova tabela de taxas/);
  assert.doesNotMatch(can.operadorasTaxas(d, { permissoes: ["financeiro_v2.ver"] }), /data-acao=/);
});

test("menu Canais de faturamento e rotas; nenhuma soma de dinheiro nas telas novas", () => {
  const html = arquivo("index.html");
  for (const r of ["saipos", "ifood", "noventa-e-nove-food", "operadoras-taxas"]) assert.match(html, new RegExp(`href="#/${r}" data-rota="${r}"`));
  assert.match(html, /Canais de faturamento/);
  const src = arquivo("telasCanais.js");
  assert.ok(!/reduce\(|Centavos\s*[+-]\s*\w+Centavos/.test(src), "tela calculando dinheiro");
  assert.ok(!/<td(?![^>]*data-rotulo)[^>]*>/.test(src.replace(/const td = [^\n]+/, "").replace(/<tr><td>[^\n]*<\/td><\/tr>/g, "")), "td sem rótulo");
});
