// Telas do relatório oficial da 99Food. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previaDoRelatorio99Food, importacoesDoCanal } from "../financeiro-v2/telasImportacoesCanais.js";
import { diaDoCanal } from "../financeiro-v2/telasCalendarioCanais.js";
import { plataforma } from "../financeiro-v2/telasCanais.js";
import { dre } from "../financeiro-v2/telas.js";

const dia = { data: "2026-11-01", dias: 1, quantidade: 2, itensCentavos: 10000, processamentoCentavos: 200, comissaoCentavos: 1000, marketingCentavos: 500, recompensasCentavos: 3000, receitaOfertaCentavos: 8000, repasseCentavos: 7000, composicaoCentavos: 8300, diferencaRepasseCentavos: 1300 };
const previa = (extra = {}) => ({
  importacaoId: "aaaaaaaa-0000-4000-8000-000000000001", loja: { id: "100", nome: "Loja Sintética", cidade: "Cidade" }, periodo: { inicio: "2026-11-01", fim: "2026-11-01" }, dias: 1, quantidade: 2,
  lojaVinculada: { id: "100", nome: "Loja Sintética" }, correcoesPendentes: [], divergencias: { diasDivergentes: 1, somaAlgebricaCentavos: 1300, somaAbsolutaCentavos: 1300, situacao: "PENDENTE_DE_CONFERENCIA" },
  valores: { vendasCentavos: 10000, processamentoCentavos: 200, comissoesCentavos: 1000, marketingCentavos: 500, resultadoPreliminarCentavos: 8300, recompensasCentavos: 3000, receitaOfertaCentavos: 8000, repasseInformadoCentavos: 7000, diferencaRepasseCentavos: 1300 },
  valoresDiarios: [dia], lancamentos: { criar: 4, manter: 0, cancelar: 0 }, conferenciaSaipos: { diasComparados: 1, diasDivergentes: [], diasSemSaipos: [], diasSoNaSaipos: [] }, bloqueios: [], avisos: [{ codigo: "VINCULAR_LOJA", mensagem: "Ao aplicar, a loja fica vinculada." }], exigeAceiteDaDiferenca: true, podeAplicar: true, ...extra,
});

test("prévia separa o que entra na DRE do que fica em conferência e exige aceite da diferença", () => {
  const h = previaDoRelatorio99Food(previa(), { podeAplicar: true });
  for (const t of ["Loja Sintética", "Entra na DRE", "Fica em conferência", "Resultado gerencial preliminar", "Recompensas da plataforma", "Receita de pedidos em oferta", "Dias divergentes", "Soma algébrica das diferenças", "Soma dos valores absolutos", "Pendente de conferência", "não é receita nem despesa", "nada vira recebível", "Valores por dia", "a loja fica vinculada", "Nada foi gravado ainda"]) assert.ok(h.includes(t), t);
  assert.match(h, /data-acao="\/api\/fv2\/acoes\/importacao\/99food\/aplicar"/);
  assert.match(h, /name="aceitarDiferencaDeRepasse" required/);
  assert.doesNotMatch(previaDoRelatorio99Food(previa(), { podeAplicar: false }), /data-acao=/);
  assert.doesNotMatch(previaDoRelatorio99Food(previa({ podeAplicar: false, bloqueios: [{ mensagem: "Outra loja." }] }), { podeAplicar: true }), /data-acao=/);
});

test("calendário mostra os valores do dia, o repasse sem data e nunca oferece marcar sem operação", () => {
  const d = { data: "2026-11-01", diaDaSemana: 0, estados: ["IMPORTADO"], importacoes: [], pendencias: [], divergencias: [], observacoes: [], noventaOficial: { ...dia, aplicado: true, situacaoConferencia: "AGUARDANDO_CONFERENCIA" } };
  const h = diaDoCanal(d, { canal: "NOVENTA_E_NOVE_FOOD", acoes: { configurarDiasSemOperacao: true } });
  for (const t of ["Relatório oficial da 99Food", "Vendas de itens", "Comissões", "Taxas de processamento", "Marketing", "Recompensas (em conferência)", "Resultado preliminar", "Repasse informado", "sem data de pagamento", "Diferença do dia", "Aplicada ao Financeiro", "Pendente de conferência"]) assert.ok(h.includes(t), t);
  assert.doesNotMatch(h, /Este dia não teve operação/);
  assert.doesNotMatch(h, /ainda não importado/);
});

test("área mostra resultado, marketing e recompensas sem chamar o repasse de recebível", () => {
  const t = { brutoCentavos: 10000, comissoesCentavos: 1000, taxasCentavos: 200, mensalidadesCentavos: null, descontosEPromocoesCentavos: null, ajustesCentavos: null, marketingCentavos: 500, recompensasCentavos: 3000, resultadoPreliminarCentavos: 8300, diferencaRepasseCentavos: 1300, diasDivergentes: 1, repassePrevistoCentavos: 7000, repasseRecebidoCentavos: 0, pedidos: 2, cancelamentos: null, observacaoPedidos: "Por dia." };
  const h = plataforma({ canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-11", situacao: "AGUARDANDO_CONFERENCIA", fonteOficial: "Relatório oficial da 99Food", totais: t, historico: [{ periodoInicio: "2026-11-01", periodoFim: "2026-11-01", brutoCentavos: 10000, repassePrevistoCentavos: 7000, repasseRecebidoCentavos: null, situacaoRepasse: "SEM_CICLO" }], pendencias: [] }, {});
  for (const x of ["Marketing", "Resultado gerencial preliminar", "Diferença em conferência", "Não informado no relatório", "Recompensas (em conferência)", "Repasse informado", "Aguardando identificação", "Aguardando conferência"]) assert.ok(h.includes(x), x);
  assert.doesNotMatch(h, /undefined|null|NaN/);
});

test("envio aceita XLSX e ZIP e oferece corrigir um relatório já importado", () => {
  const h = importacoesDoCanal({ canal: "NOVENTA_E_NOVE_FOOD", unidade: { nome: "U" }, acoes: { importar: true }, demonstrativos: [], formatos: [{ id: "NOVENTA_E_NOVE_FOOD_RELATORIO", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", nome: "Relatório oficial da 99Food", principal: true, disponivel: true, aceitaArquivo: true, homologado: true, extensoesHomologadas: ["xlsx"], extensoes: ["xlsx"] }],
    historico: [{ id: "ref-1", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", relatorio: "Relatório oficial da 99Food", estado: "IMPORTADO", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", erros: 0, divergencias: 0, jaExistentes: 0 }] });
  assert.match(h, /accept="\.xlsx,\.zip"/);
  assert.match(h, /name="substitui"/);
  assert.match(h, /data-detalhe="relatorio-99food:ref-1"/);
});

test("sem vínculo a prévia pede o ID oficial; correção pendente mostra as duas versões e as decisões", () => {
  const p = previa({ lojaVinculada: null, podeAplicar: false, bloqueios: [{ mensagem: "A loja ainda não foi vinculada." }], correcoesPendentes: [{ importacaoId: "ref-2", data: "2026-11-01", vigente: { itensCentavos: 10000, processamentoCentavos: 200, comissaoCentavos: 1000, marketingCentavos: 500, repasseCentavos: 7000 }, informado: { itensCentavos: 12000, processamentoCentavos: 200, comissaoCentavos: 1000, marketingCentavos: 500, repasseCentavos: 7000 } }] });
  const h = previaDoRelatorio99Food(p, { podeAplicar: true, podeVincular: true, podeDecidir: true });
  assert.match(h, /99food\/vincular-loja/);
  assert.match(h, /name="lojaId"[^>]*required/);
  assert.doesNotMatch(h, /name="lojaId"[^>]*value=/, "o ID é digitado, nunca pré-preenchido");
  for (const t of ["Versão efetiva", "Versão recebida", "R$ 100,00", "R$ 120,00", "Adotar a versão recebida", "Manter a versão efetiva"]) assert.ok(h.includes(t), t);
  const leitor = previaDoRelatorio99Food(p, {});
  assert.doesNotMatch(leitor, /vincular-loja|decidir-correcao/);
  assert.match(leitor, /exige a permissão "Configurar"/);
});

test("DRE mostra a pendência da 99Food separada do resultado e só quando ela existe", () => {
  const linha = (codigo, nome, valorCentavos) => ({ codigo, nome, valorCentavos, percentualDoBruto: 10000, situacao: "PARCIAL", componentes: [], pendencias: [] });
  const r = (pendencias) => ({ competencia: "2026-11", pendencias, impressao: "abc", cadaCem: null, dre: { estadoDaCompetencia: "ABERTA", metodologia: { nome: "M", versao: "v1" }, linhas: [linha("FATURAMENTO_BRUTO_PROPRIO", "(+) Faturamento", 10000), linha("RECEITA_LIQUIDA_COMERCIAL", "(=) Receita", 10000), linha("RESULTADO_GERENCIAL", "(=) Resultado", 8300)] } });
  const h = dre(r([{ tipo: "REPASSE_99FOOD_EM_CONFERENCIA", mensagem: "m", valorCentavos: 1300, resultadoPreliminarCentavos: 8300, repasseInformadoCentavos: 7000, diasDivergentes: 1, somaAbsolutaCentavos: 1300 }]));
  for (const t of ["99Food: resultado gerencial preliminar", "Resultado preliminar", "R$ 83,00", "Repasse informado", "R$ 70,00", "Diferença líquida", "R$ 13,00", "Dias divergentes", "Pendente de conferência", "não é receita nem despesa"]) assert.ok(h.includes(t), t);
  assert.doesNotMatch(dre(r([])), /data-pendencia-99food/);
});
