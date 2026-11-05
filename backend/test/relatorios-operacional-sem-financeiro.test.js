// Segurança dos relatórios do Checklist: destinatário SEM papel financeiro (operacional, gerente, secundário, sem papel) nunca recebe
// INDICADORES FINANCEIROS nem qualquer valor em R$ — nem do Checklist (descontos financiados pela loja), nem do bloco Foody.
// Papéis com acesso financeiro (principal, financeiro) continuam recebendo tudo. Só enfileiramento em memória: nada é enviado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "ficticio_service_role_key_0123456789abcdef";
process.env.SUPABASE_ANON_KEY ??= "ficticio_anon_key_0123456789abcdef0123";

const { enfileirarRelatoriosDaUnidade } = await import("../src/modules/notificacoes/notificacoes.relatorios.servico.js");
const { gerarMensagem, validarMensagem, ACHADOS_FINANCEIROS } = await import("../src/modules/checklist-operacional/checklistOperacional.whatsapp.js");

const ORG = "11111111-1111-4111-8111-111111111111", UNI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ON = { FOODY_CENTRAL_RELATORIO_ENABLED: "true", FOODY_CENTRAL_RELATORIO_UNIDADES: UNI, NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO: "true" };
const FINANCEIRO = /R\$|INDICADORES FINANCEIROS|Descontos financiados|Pedidos com desconto|Taxa válida|Custo atribuído/;

const ACHADO_DESCONTO = { codigo: "DESCONTO_LOJA_ELEVADO", severidade: "informativa", titulo: "Descontos financiados pela loja elevados",
  fato: "Descontos pagos pela loja somaram R$ 785,90", acao: "Conferir as campanhas com desconto financiado pela loja ativas no dia." };
const ACHADO_PREPARO = { codigo: "PREPARO_ACIMA_META", severidade: "alta", titulo: "Preparo acima da meta", acao: "Revisar a escala da cozinha." };

const fechChecklist = (competencia, { principalFinanceiro = false } = {}) => ({
  id: `f-${competencia}`, competencia, versao: 1, status: "CONSOLIDADO", hash_conteudo: "h", cobertura: {},
  diagnostico: principalFinanceiro
    ? { principal: ACHADO_DESCONTO, achados: [ACHADO_DESCONTO, ACHADO_PREPARO], texto: { acao: ACHADO_DESCONTO.acao } }
    : { principal: ACHADO_PREPARO, achados: [ACHADO_PREPARO, ACHADO_DESCONTO], texto: { acao: ACHADO_PREPARO.acao } },
  indicadores: { pedidos: { recebidos: 112, concluidosNoDia: 107, canceladosNoDia: 5 }, preparo: { estado: "calculado", media: 23.4, amostras: 100, meta: 15 },
    entrega: { estado: "calculado", media: 10.9, amostras: 100, meta: 15 }, vida: { estado: "calculado", media: 36.8, amostras: 100, meta: 30 },
    atrasos: { pedidosAvaliados: 104, pedidosAtrasados: 77, pct: 74 }, movimento: { picos: [{ hora: 21, pedidos: 12 }] }, cancelamentos: { total: 5, motivos: [] },
    disputas: { abertasNoDia: 3, expiradasNoDia: 0, pendentesAgora: 0 },
    descontos: { pedidosNaBase: 112, loja: 785.9, pedidosComDescontoLoja: 95, pctLojaSobreItens: 25 },
    clientes: { base: 112, novos: 22, recorrentes: 90 } },
});
const fechFoody = (competencia) => ({ organizacao_id: ORG, unidade_id: UNI, competencia, versao: 1, status: "CONSOLIDADO", estado_valores: "SINCRONIZADO",
  indicadores: { operacao: "subway", subway: { total: { pedidos: 54, entregues: 54, cancelados: 0, taxasBrutas: 506, taxasValidas: 506 }, custoLogisticoProprio: 506 } } });

const DIAS = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
const TIPOS = [["dPrin", "principal"], ["dFin", "financeiro"], ["dOp", "operacional"], ["dGer", "gerente"], ["dSec", "secundario"], ["dNull", null]];
const COM_FINANCEIRO = new Set(["dPrin", "dFin"]);

function deps({ principalFinanceiro = false } = {}) {
  const fech = DIAS.map((d) => fechChecklist(d, { principalFinanceiro }));
  const itens = [];
  const destinatarios = TIPOS.map(([id, tipo]) => ({ id, ativo: true, tipo }));
  const cats = ["fechamento_operacional_diario", "resumo_semanal"];
  return { itens, deps: {
    relatorios: { fechamentosEntre: async ({ de, ate }) => fech.filter((f) => f.competencia >= de && f.competencia <= ate), registrarResumoSemanal: async () => "r1",
      enfileirar: async (linhas) => { itens.push(...linhas); return linhas.length; } },
    notificacoes: {
      listarDestinatarios: async () => ({ destinatarios, escopos: destinatarios.flatMap((d) => cats.map((categoria) => ({ contato_empresa_id: d.id, unidade_escopo_id: UNI, categoria,
        origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: false }))) }),
      listarConsentimentos: async () => destinatarios.flatMap((d) => cats.map((categoria) => ({ contato_empresa_id: d.id, categoria, acao: "CONCEDIDO" }))),
    },
    lerFoody: async ({ de, ate }) => DIAS.filter((d) => d >= de && d <= ate).map(fechFoody),
  } };
}
const unidade = { organizacaoId: ORG, unidadeId: UNI, unidadeNome: "Subway Teste", fusoUnidade: null, integracao: { estado: "ao_vivo" }, modulosEfetivos: ["checklist_operacional"] };
const AGORA_SEG = () => new Date("2026-11-02T12:00:00.000Z"); // diário de 01/11 + semanal 26/10–01/11

describe("geradores do Checklist: seção financeira opcional", () => {
  test("padrão inalterado (incluirFinanceiro=true): seção e valor presentes", () => {
    const f = fechChecklist("2026-11-04");
    const t = gerarMensagem({ fechamento: f });
    assert.equal(t, gerarMensagem({ fechamento: f, incluirFinanceiro: true }));
    assert.match(t, /\*INDICADORES FINANCEIROS\*\n• Descontos financiados pela loja: R\$\s?785,90\n• Pedidos com desconto: 95/);
    assert.match(t, /Descontos financiados pela loja elevados\./);
  });
  test("incluirFinanceiro=false: sem seção, sem R$, sem ponto de atenção financeiro; resto idêntico e válido", () => {
    const f = fechChecklist("2026-11-04");
    const com = gerarMensagem({ fechamento: f }), sem = gerarMensagem({ fechamento: f, incluirFinanceiro: false });
    assert.doesNotMatch(sem, FINANCEIRO);
    assert.doesNotMatch(sem, /Descontos financiados pela loja elevados/);
    assert.match(sem, /Preparo acima da meta\./);
    assert.match(sem, /\*CLIENTES\*\n• Novos: 22\n• Recorrentes: 90\n\n\*CHAMADOS\*/, "a seção some sem deixar linha em branco dupla");
    const semFin = (s) => s.split("\n").filter((l) => !/INDICADORES FINANCEIROS|Descontos financiados|Pedidos com desconto/.test(l)).join("\n").replace(/\n\n\n/g, "\n\n");
    assert.equal(sem, semFin(com));
    assert.equal(validarMensagem(sem, { fechamento: f }).ok, true);
  });
  test("achado principal financeiro: recomendação vem do próximo achado não financeiro", () => {
    const f = fechChecklist("2026-11-04", { principalFinanceiro: true });
    assert.match(gerarMensagem({ fechamento: f }), /\*RECOMENDAÇÃO\*\nConferir as campanhas com desconto/);
    const sem = gerarMensagem({ fechamento: f, incluirFinanceiro: false });
    assert.match(sem, /\*RECOMENDAÇÃO\*\nRevisar a escala da cozinha\./);
    assert.doesNotMatch(sem, /desconto/i);
    assert.deepEqual([...ACHADOS_FINANCEIROS], ["DESCONTO_LOJA_ELEVADO"]);
  });
});

describe("enfileiramento: texto por papel", () => {
  test("diário + semanal: só principal/financeiro recebem valores (Checklist e Foody); demais papéis nunca", async () => {
    const { itens, deps: d } = deps();
    const saida = await enfileirarRelatoriosDaUnidade(unidade, { agora: AGORA_SEG, env: ON, deps: d });
    assert.equal(saida.diario.enfileirados, TIPOS.length);
    assert.equal(saida.semanal.enfileirados, TIPOS.length);
    for (const i of itens) {
      if (COM_FINANCEIRO.has(i.contato_empresa_id)) {
        assert.match(i.mensagem, /INDICADORES FINANCEIROS/, `${i.tipo}/${i.contato_empresa_id}`);
        assert.match(i.mensagem, /Custo atribuído a entregadores próprios: R\$/, `${i.tipo}/${i.contato_empresa_id}`);
      } else {
        assert.doesNotMatch(i.mensagem, FINANCEIRO, `${i.tipo}/${i.contato_empresa_id} não pode receber valor financeiro`);
        assert.match(i.mensagem, /\*Logística \(Foody\)\*/, "o bloco logístico continua, só com contagens");
      }
      assert.equal(i.tamanho, i.mensagem.length);
    }
    for (const i of itens.filter((x) => x.tipo === "diario")) assert.equal(validarMensagem(i.mensagem, { fechamento: fechChecklist("2026-11-01") }).ok, true);
    for (const i of itens.filter((x) => x.tipo === "semanal")) assert.match(i.mensagem, /Cobertura: \d de 7 dias/);
  });
  test("chave de idempotência não depende do texto (igual com e sem a regra financeira)", async () => {
    const { itens, deps: d } = deps();
    await enfileirarRelatoriosDaUnidade(unidade, { agora: AGORA_SEG, env: ON, deps: d });
    const diario = itens.filter((i) => i.tipo === "diario");
    for (const i of diario) assert.equal(i.chave_idempotencia, `wa:rel:diario:f-2026-11-01:${i.contato_empresa_id}:inicial`);
    assert.equal(new Set(itens.map((i) => i.chave_idempotencia)).size, itens.length);
  });
  test("flags Foody desligadas: operacional também sem financeiro do Checklist", async () => {
    const { itens, deps: d } = deps();
    await enfileirarRelatoriosDaUnidade(unidade, { agora: AGORA_SEG, env: { NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO: "true" }, deps: d });
    const op = itens.filter((i) => i.contato_empresa_id === "dOp");
    assert.equal(op.length, 2);
    for (const i of op) { assert.doesNotMatch(i.mensagem, FINANCEIRO); assert.doesNotMatch(i.mensagem, /Foody/); }
    assert.match(itens.find((i) => i.contato_empresa_id === "dPrin" && i.tipo === "diario").mensagem, /Descontos financiados pela loja: R\$/);
  });
});
