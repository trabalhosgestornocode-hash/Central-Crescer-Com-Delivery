// Telas da conciliação oficial do iFood. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previaDaConciliacaoIfood } from "../financeiro-v2/telasImportacoesCanais.js";
import { diaDoCanal } from "../financeiro-v2/telasCalendarioCanais.js";
import { importacoesDoCanal } from "../financeiro-v2/telasImportacoesCanais.js";
import { plataforma } from "../financeiro-v2/telasCanais.js";

const previa = (extra = {}) => ({
  importacaoId: "aaaaaaaa-0000-4000-8000-000000000001", periodo: { inicio: "2026-11-01", fim: "2026-11-17" }, pedidos: 3, movimentos: 12,
  valores: { produtosCentavos: 10000, entregasCentavos: 2000, faturamentoCentavos: 12000, promocoesLojaCentavos: 500, comissoesCentavos: 1200, taxaTransacaoCentavos: 300, entregaSobDemandaCentavos: 100, anunciosCentavos: 400, liquidoCentavos: 9500, repassePrevistoCentavos: 8000, recebidoDiretoCentavos: 1500 },
  lancamentos: { criar: 7, manter: 0, cancelar: 0 }, repasses: { itens: [{ apuracaoInicio: "2026-11-02", apuracaoFim: "2026-11-08", dataPrevista: "2026-12-02", previstoCentavos: 8000, situacao: "PREVISTO" }] },
  conferenciaSaipos: { diasComparados: 2, diferencaCentavos: -119 }, bloqueios: [], avisos: [], podeAplicar: true, ...extra,
});

test("prévia separa produtos e entregas, mostra o pago direto e só oferece aplicar a quem pode", () => {
  const h = previaDaConciliacaoIfood(previa(), { podeAplicar: true });
  for (const t of ["Produtos", "Entregas da loja", "Faturamento", "Pago direto à loja (já no faturamento)", "Repasses previstos", "pendente de conferência", "Nada foi gravado ainda"]) assert.ok(h.includes(t), t);
  assert.match(h, /data-acao="\/api\/fv2\/acoes\/importacao\/ifood-conciliacao\/aplicar"/);
  assert.match(h, /name="justificativa"[^>]*required/);
  assert.match(h, /name="confirmar" required/);
  assert.doesNotMatch(previaDaConciliacaoIfood(previa(), { podeAplicar: false }), /data-acao=/);
});

test("bloqueio aparece com o motivo e retira o botão de aplicar", () => {
  const h = previaDaConciliacaoIfood(previa({ podeAplicar: false, bloqueios: [{ codigo: "X", mensagem: "Já existe demonstrativo <oficial> nestes dias." }] }), { podeAplicar: true });
  assert.match(h, /O que impede aplicar/);
  assert.match(h, /&lt;oficial&gt;/);
  assert.doesNotMatch(h, /data-acao=/);
});

test("calendário mostra os valores do dia pelo relatório oficial", () => {
  const dia = { data: "2026-11-03", diaDaSemana: 2, estados: ["IMPORTADO", "DIVERGENCIA"], importacoes: [], pendencias: [], divergencias: [{ mensagem: "Diferença com a SAIPOS.", diferencaCentavos: -200 }], observacoes: [],
    ifoodOficial: { pedidos: 2, pedidosCancelados: 1, faturamentoCentavos: 5700, produtosCentavos: 5000, entregasCentavos: 700, descontosCentavos: 500, comissoesCentavos: 800, taxasCentavos: 250, ajustesCentavos: 0, liquidoCentavos: 4150, situacaoConferencia: "DIVERGENTE", repasses: [{ dataPrevista: "2026-12-02", situacao: "PREVISTO" }] } };
  const h = diaDoCanal(dia, { canal: "IFOOD", acoes: {} });
  for (const t of ["Relatório de Conciliação Financeira do iFood", "Pedidos", "Faturamento", "Produtos", "Entregas da loja", "Descontos da loja", "Comissões", "Taxas", "Valor líquido", "Divergente: diferença pendente", "02/12/2026 (Previsto)"]) assert.ok(h.includes(t), t);
  assert.doesNotMatch(h, /Valores do PERÍODO inteiro/);
  assert.match(h, /2, sendo 1 cancelado/);
  assert.doesNotMatch(diaDoCanal(dia, { canal: "IFOOD", acoes: { configurarDiasSemOperacao: true } }), /Este dia não teve operação/);
});

test("pendência de classificação mostra o valor, só oferece categoria compatível e os avisos aparecem", () => {
  const p = previa({ podeAplicar: false, bloqueios: [{ codigo: "LANCAMENTO_DESCONHECIDO", mensagem: "Lançamento novo sem classificação." }], avisos: [{ codigo: "REPASSE_SEM_SALDO", mensagem: "Ciclo sem saldo positivo." }],
    pendenciasDeClassificacao: [{ chave: "descricao:novo", descricao: "Lançamento novo", quantidade: 2, valorCentavos: -1000 }], categoriasPermitidas: [{ codigo: "OUTRAS_DESPESAS", nome: "Outras despesas", natureza: "DESPESA" }, { codigo: "OUTRAS_RECEITAS", nome: "Outras receitas", natureza: "RECEITA" }] });
  const h = previaDaConciliacaoIfood(p, { podeAplicar: true, podeClassificar: true });
  assert.match(h, /ifood-conciliacao\/classificar/);
  assert.match(h, /value="OUTRAS_DESPESAS"/);
  assert.doesNotMatch(h, /value="OUTRAS_RECEITAS"/);
  assert.match(h, /Ciclo sem saldo positivo/);
  assert.doesNotMatch(h, /ifood-conciliacao\/aplicar/);
  assert.doesNotMatch(previaDaConciliacaoIfood(p, { podeClassificar: false }), /ifood-conciliacao\/classificar/);
});

test("área do iFood mostra o estado real e a busca no extrato não baixa nada", () => {
  const d = { canal: "IFOOD", competencia: "2026-11", situacao: "DIVERGENTE", fonteOficial: "Relatório", totais: null, historico: [], pendencias: [], conciliacao: {} };
  const h = plataforma(d, { permissoes: ["financeiro_v2.conciliar"] });
  assert.match(h, /Divergente/);
  assert.match(h, /conciliacoes\/gerar-repasses-ifood/);
  assert.match(h, /Nada é baixado aqui/);
  assert.doesNotMatch(plataforma(d, { permissoes: [] }), /gerar-repasses-ifood/);
  assert.match(plataforma({ ...d, situacao: "CONCILIADO" }, {}), /Conciliado/);
});

test("correção é escolha explícita no envio do relatório", () => {
  const d = { canal: "IFOOD", unidade: { nome: "U" }, acoes: { importar: true, registrarDemonstrativo: false }, demonstrativos: [], formatos: [{ id: "IFOOD_CONCILIACAO", tipoRelatorio: "IFOOD_CONCILIACAO", nome: "Conciliação", principal: true, disponivel: true, aceitaArquivo: true, homologado: true, extensoesHomologadas: ["xlsx"], extensoes: ["xlsx"] }],
    historico: [{ id: "ref-1", tipoRelatorio: "IFOOD_CONCILIACAO", relatorio: "Conciliação", estado: "IMPORTADO", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", erros: 0, divergencias: 0, jaExistentes: 0 }] };
  const h = importacoesDoCanal(d);
  assert.match(h, /name="substitui"/);
  assert.match(h, /<option value="">Não: é um relatório novo ou complementar/);
});
