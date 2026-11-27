// MOVA (27/11/2026): documento de loja da MESMA empresa que está no cadastro da plataforma e NÃO está habilitada no MOVA.
// Achado real: a legenda "<serviço> <marca> <outra loja>" virou documento da loja habilitada da mesma marca, com a despesa
// documental em APLICAR_AUTOMATICO. Aqui, com a política AUTOMÁTICA ligada (pior caso): nada é gravado, nenhuma proposta é
// criada e a resposta diz qual loja é. Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL isolado, IA SIMULADA.
// Tudo sintético ("Loja Alfa Norte Shopping" é fictícia).
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { FINANCEIRO, ALFA, CONFIG, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const NORTE = "dddddddd-0000-4000-8000-0000000a2c01";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 35000, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: "Dedetizadora Sintética", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", idTransacao: `E0000000020261010SINTNH${String(++seq).padStart(9, "0")}`,
  situacaoTransacao: "CONCLUIDA", categoriaSugerida: "MANUTENCAO", ...x });
const CRIAR = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
const ESCRITAS = ["registrarDespesaPagaPorComprovante", "enviarEvidencia", "registrarObrigacaoDocumental", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar"];
const ESPERADA = "Identifiquei que este documento pertence à Loja Alfa Norte Shopping. Essa unidade ainda não está habilitada no Financeiro do MOVA. Nenhum lançamento foi realizado.";

async function montar({ responder = () => PIX(), politica = true } = {}) {
  const s = await cenario({
    responder,
    config: { ...CONFIG, cadastroDeUnidades: "CONSULTADO", unidadesNaoHabilitadas: [{ organizacaoId: ORG, unidadeId: NORTE, nome: "Loja Alfa Norte Shopping" }] },
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: CRIAR }]) }),
    }),
  });
  // Política AUTOMÁTICA na loja habilitada (o cenário do achado): se a unidade fosse trocada, a despesa seria gravada.
  if (politica) await s.mova.armazenamento.politicas.criar({ operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100000,
    responsavel: "Administrador Sintético", motivo: "Despesa paga por comprovante até R$ 1.000,00 (sintético)", vigenteDe: "2026-10-01" }, { criadaPor: HUMANO });
  const escritas = () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome));
  const textos = async () => (await s.saida()).map((r) => r.texto);
  const propostas = async () => s.contar("proposta");
  return { ...s, escritas, textos, propostas };
}

t("NH-1 legenda cita a loja NÃO habilitada (marca + local): bloqueado, nenhuma escrita, nenhuma proposta, resposta com o nome da loja", async () => {
  const s = await montar();
  await s.enviar(gw({ texto: "MOVA controle de pragas alfa norte shopping", doc: pdf("NH1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "UNIDADE_NAO_HABILITADA"]);
  assert.equal(h.unidadeId ?? null, null, "nenhuma unidade atribuída");
  assert.deepEqual([s.escritas().length, await s.propostas()], [0, 0]);
  assert.ok((await s.textos()).includes(ESPERADA), "resposta aprovada pelo proprietário");
});

t("NH-2 só a leitura do DOCUMENTO aponta a loja não habilitada (legenda neutra): bloqueado, nada gravado", async () => {
  const s = await montar({ responder: () => PIX({ unidadeSugerida: "Loja Alfa Norte Shopping" }) });
  await s.enviar(gw({ texto: "MOVA comprovante pago", doc: pdf("NH2") }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_NAO_HABILITADA");
  assert.deepEqual([s.escritas().length, await s.propostas()], [0, 0]);
});

t("NH-3 só a MARCA ('alfa', que outra loja do cadastro também carrega): pergunta a unidade — nada gravado; a resposta 'alfa' resolve", async () => {
  const s = await montar();
  const original = gw({ texto: "MOVA paguei a dedetização da alfa", doc: pdf("NH3") });
  await s.enviar(original);
  assert.deepEqual([(await s.ultima()).decisao, s.escritas().length, await s.propostas()], ["PEDIR_INFORMACAO", 0, 0]);
  // Resposta à pergunta "de qual unidade?": aí a marca basta (a pessoa escolheu entre as unidades oferecidas).
  await s.enviar(gw({ texto: "loja alfa", respostaA: original.mensagemId }));
  assert.notEqual((await s.ultima()).motivo, "UNIDADE_NAO_HABILITADA");
  assert.ok(["EXECUTADO", "PROPOSTA"].includes((await s.ultima()).decisao), (await s.ultima()).decisao);
});

t("NH-4 a loja HABILITADA pelo nome completo continua funcionando (despesa automática dentro do limite)", async () => {
  const s = await montar();
  await s.enviar(gw({ texto: "MOVA paguei a dedetização da loja alfa", doc: pdf("NH4") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.ok(s.escritas().every((x) => x.unidadeId === ALFA));
});

t("NH-5 a resposta a 'de qual unidade?' citando a loja não habilitada também bloqueia", async () => {
  const s = await montar();
  const original = gw({ texto: "MOVA paguei a dedetização", doc: pdf("NH5") });
  await s.enviar(original);
  assert.equal((await s.ultima()).decisao, "PEDIR_INFORMACAO");
  await s.enviar(gw({ texto: "alfa norte shopping", respostaA: original.mensagemId }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_NAO_HABILITADA");
  assert.deepEqual([s.escritas().length, await s.propostas()], [0, 0]);
});

t("NH-6 proposta ANTIGA (criada antes da trava) cuja mensagem cita a loja não habilitada: a aprovação humana é RECUSADA e nada é gravado", async () => {
  const s = await montar({ politica: false });
  const m = gw({ texto: "MOVA paguei a dedetização da loja alfa", doc: pdf("NH6") });
  await s.enviar(m);
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  const { rows: [p] } = await s.banco.pool.query("select id from mova.proposta order by criada_em desc limit 1");
  // simula a proposta criada pela regra antiga: a mensagem original citava a outra loja da rede
  await s.banco.pool.query("update mova.evento set texto = $1 where evento_id = $2", ["MOVA paguei a dedetização da alfa norte shopping", m.eventoId]);
  await assert.rejects(s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id }), /UNIDADE_NAO_CONFIRMADA/);
  assert.equal(s.escritas().length, 0);
  const { rows: [q] } = await s.banco.pool.query("select estado from mova.proposta where id = $1", [p.id]);
  assert.equal(q.estado, "AGUARDANDO_REVISAO", "continua para revisão; nunca aplicada");
});
