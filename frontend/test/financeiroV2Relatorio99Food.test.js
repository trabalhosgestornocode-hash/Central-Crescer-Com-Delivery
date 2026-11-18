// Telas do relatório oficial da 99Food. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previaDoRelatorio99Food, importacoesDoCanal } from "../financeiro-v2/telasImportacoesCanais.js";
import { diaDoCanal } from "../financeiro-v2/telasCalendarioCanais.js";
import { plataforma } from "../financeiro-v2/telasCanais.js";

const dia = { data: "2026-11-01", dias: 1, quantidade: 2, itensCentavos: 10000, processamentoCentavos: 200, comissaoCentavos: 1000, marketingCentavos: 500, recompensasCentavos: 3000, receitaOfertaCentavos: 8000, repasseCentavos: 7000, composicaoCentavos: 8300, diferencaRepasseCentavos: 1300 };
const previa = (extra = {}) => ({
  importacaoId: "aaaaaaaa-0000-4000-8000-000000000001", loja: { id: "100", nome: "Loja Sintética", cidade: "Cidade" }, periodo: { inicio: "2026-11-01", fim: "2026-11-01" }, dias: 1, quantidade: 2,
  valores: { vendasCentavos: 10000, processamentoCentavos: 200, comissoesCentavos: 1000, marketingCentavos: 500, resultadoCentavos: 8300, recompensasCentavos: 3000, receitaOfertaCentavos: 8000, repasseInformadoCentavos: 7000, diferencaRepasseCentavos: 1300 },
  valoresDiarios: [dia], lancamentos: { criar: 4, manter: 0, cancelar: 0 }, conferenciaSaipos: { diasComparados: 1, diasDivergentes: [], diasSemSaipos: [] }, bloqueios: [], avisos: [{ codigo: "VINCULAR_LOJA", mensagem: "Ao aplicar, a loja fica vinculada." }], exigeAceiteDaDiferenca: true, podeAplicar: true, ...extra,
});

test("prévia separa o que entra na DRE do que fica em conferência e exige aceite da diferença", () => {
  const h = previaDoRelatorio99Food(previa(), { podeAplicar: true });
  for (const t of ["Loja Sintética", "Entra na DRE", "Fica em conferência", "Recompensas da plataforma", "Receita de pedidos em oferta", "Diferença a conferir", "nada vira recebível", "Valores por dia", "a loja fica vinculada", "Nada foi gravado ainda"]) assert.ok(h.includes(t), t);
  assert.match(h, /data-acao="\/api\/fv2\/acoes\/importacao\/99food\/aplicar"/);
  assert.match(h, /name="aceitarDiferencaDeRepasse" required/);
  assert.doesNotMatch(previaDoRelatorio99Food(previa(), { podeAplicar: false }), /data-acao=/);
  assert.doesNotMatch(previaDoRelatorio99Food(previa({ podeAplicar: false, bloqueios: [{ mensagem: "Outra loja." }] }), { podeAplicar: true }), /data-acao=/);
});

test("calendário mostra os valores do dia, o repasse sem data e nunca oferece marcar sem operação", () => {
  const d = { data: "2026-11-01", diaDaSemana: 0, estados: ["IMPORTADO"], importacoes: [], pendencias: [], divergencias: [], observacoes: [], noventaOficial: { ...dia, aplicado: true, situacaoConferencia: "AGUARDANDO_CONFERENCIA" } };
  const h = diaDoCanal(d, { canal: "NOVENTA_E_NOVE_FOOD", acoes: { configurarDiasSemOperacao: true } });
  for (const t of ["Relatório oficial da 99Food", "Vendas de itens", "Comissões", "Taxas de processamento", "Marketing", "Recompensas (em conferência)", "Repasse informado", "sem data de pagamento", "Aplicada ao Financeiro", "Pendente de conferência"]) assert.ok(h.includes(t), t);
  assert.doesNotMatch(h, /Este dia não teve operação/);
  assert.doesNotMatch(h, /ainda não importado/);
});

test("área mostra resultado, marketing e recompensas sem chamar o repasse de recebível", () => {
  const t = { brutoCentavos: 10000, comissoesCentavos: 1000, taxasCentavos: 200, mensalidadesCentavos: 0, descontosEPromocoesCentavos: 0, ajustesCentavos: 0, marketingCentavos: 500, recompensasCentavos: 3000, resultadoCentavos: 8300, repassePrevistoCentavos: 7000, repasseRecebidoCentavos: 0, pedidos: 2, cancelamentos: null, observacaoPedidos: "Por dia." };
  const h = plataforma({ canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-11", situacao: "AGUARDANDO_CONFERENCIA", fonteOficial: "Relatório oficial da 99Food", totais: t, historico: [{ periodoInicio: "2026-11-01", periodoFim: "2026-11-01", brutoCentavos: 10000, repassePrevistoCentavos: 7000, repasseRecebidoCentavos: null, situacaoRepasse: "SEM_CICLO" }], pendencias: [] }, {});
  for (const x of ["Marketing", "Resultado do canal", "Recompensas (em conferência)", "Repasse informado", "Aguardando identificação", "Aguardando conferência"]) assert.ok(h.includes(x), x);
  assert.doesNotMatch(h, /undefined|null|NaN/);
});

test("envio aceita XLSX e ZIP e oferece corrigir um relatório já importado", () => {
  const h = importacoesDoCanal({ canal: "NOVENTA_E_NOVE_FOOD", unidade: { nome: "U" }, acoes: { importar: true }, demonstrativos: [], formatos: [{ id: "NOVENTA_E_NOVE_FOOD_RELATORIO", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", nome: "Relatório oficial da 99Food", principal: true, disponivel: true, aceitaArquivo: true, homologado: true, extensoesHomologadas: ["xlsx"], extensoes: ["xlsx"] }],
    historico: [{ id: "ref-1", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", relatorio: "Relatório oficial da 99Food", estado: "IMPORTADO", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", erros: 0, divergencias: 0, jaExistentes: 0 }] });
  assert.match(h, /accept="\.xlsx,\.zip"/);
  assert.match(h, /name="substitui"/);
  assert.match(h, /data-detalhe="relatorio-99food:ref-1"/);
});
