// Cenário SINTÉTICO do modo OPERACAO (Agente 2): Financeiro v2 real em memória, banco do MOVA no PostgreSQL local isolado, IA
// SIMULADA. Nenhum identificador, nome ou valor aqui é real (DDD 00 não existe; grupos 120363000000000xxx são fictícios).
import { after, test } from "node:test";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../../src/modules/financeiro-v2/index.js";
import { AGORA, TODAS, ctx, montar } from "../../financeiro-v2/helpers/cenario.js";
import { criarExtratorAnthropic, criarMova, instalarConfiguracao, validarConfiguracao } from "../../../src/modules/mova-financeiro/index.js";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "./banco.js";

export const PULAR = motivoParaPularMova();
// Disco reduzido: os bancos criados por ESTE arquivo de teste são apagados ao final (só eles; nunca bancos existentes).
const criados = [];
after(async () => { for (const b of criados.splice(0)) await descartarBancoMova(b).catch(() => {}); });
export const t = (nome, fn) => test(nome, { skip: PULAR }, fn);

export const ORG = "dddddddd-0000-4000-8000-0000000000a2";
export const ALFA = "dddddddd-0000-4000-8000-0000000a2a01";
export const BETA = "dddddddd-0000-4000-8000-0000000a2b01";
export const ORG_X = "dddddddd-0000-4000-8000-0000000000f9"; // OUTRA empresa
export const XIS = "dddddddd-0000-4000-8000-0000000f9a01";
export const GRUPO = "120363000000000201@g.us";
export const GRUPO_X = "120363000000000299@g.us";
export const FIN = "5500000000201@s.whatsapp.net"; // financeiro: JID de telefone (a própria conversa privada)
export const LID = "88000000000201@lid"; // identidade LID com privado cadastrado
export const LID_PRIVADO = "5500000000202@s.whatsapp.net";
export const SEM_PRIVADO = "88000000000203@lid"; // LID sem número privado
export const OPER = "5500000000204@s.whatsapp.net"; // operacional: documentos, sem valores
export const CONS = "5500000000205@s.whatsapp.net"; // só consultas
export const SO_ALFA = "5500000000206@s.whatsapp.net"; // financeiro só da Alfa
export const DUAS_EMPRESAS = "5500000000207@s.whatsapp.net"; // está em grupos de duas organizações
export const ESTRANHO = "5500000000299@s.whatsapp.net";
export const ESCOPOS = [{ organizacaoId: ORG, unidadeId: ALFA }, { organizacaoId: ORG, unidadeId: BETA }, { organizacaoId: ORG_X, unidadeId: XIS }];
const fontes = { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"], anotaAiPelaSaipos: false };
export const CONFIG = {
  modo: "OPERACAO", identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000a2" },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Alfa", apelidos: ["alfa"], fontes },
    { organizacaoId: ORG, unidadeId: BETA, nome: "Loja Beta", apelidos: ["beta"], fontes },
    { organizacaoId: ORG_X, unidadeId: XIS, nome: "Loja Xis", apelidos: ["xis"], fontes },
  ],
  gruposAutorizados: [
    { grupoId: GRUPO, unidades: [ALFA, BETA], acesso: "LISTA", participantes: [
      { ids: [FIN], perfil: "FINANCEIRO", nome: "Financeiro" },
      { ids: [LID], perfil: "FINANCEIRO", privado: LID_PRIVADO },
      { ids: [SEM_PRIVADO], perfil: "FINANCEIRO" },
      { ids: [OPER], perfil: "OPERACIONAL" },
      { ids: [CONS], perfil: "CONSULTA" },
      { ids: [SO_ALFA], perfil: "FINANCEIRO", unidades: [ALFA] },
      { ids: [DUAS_EMPRESAS], perfil: "FINANCEIRO" },
    ] },
    { grupoId: GRUPO_X, unidades: [XIS], acesso: "LISTA", participantes: [{ ids: [DUAS_EMPRESAS], perfil: "FINANCEIRO" }] },
  ],
};
export const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
export const base = (extra) => ({
  legivel: true, tipoDocumento: "OUTRO", intencao: "OUTRA", unidadeSugerida: null, documentoDestinatario: null, valorCentavos: null, dataPagamento: null, dataEmissao: null,
  vencimento: null, competencia: null, favorecido: null, identificadorDocumento: null, categoriaSugerida: null, natureza: null, consulta: null, confianca: "ALTA",
  camposAusentes: [], incertezas: [], justificativa: "sintético", referenciasDocumentais: [], periodoInicio: null, periodoFim: null, todasUnidades: false, transcricao: null, ...extra,
});

let seq = 0;
export const gw = ({ texto = null, de = FIN, grupo = GRUPO, respostaA = null, doc = null, telefone = null } = {}) => {
  const id = `EA2${String(++seq).padStart(6, "0")}`;
  return {
    contratoMova: 1, eventoId: `bly:${id}`, mensagemId: id, grupoId: grupo, participanteId: de, telefoneE164: telefone, nomeExibicao: "Pessoa Sintética", fromMe: false,
    tipo: doc ? "DOCUMENTO" : "TEXTO", texto, respostaA, midia: doc ? { mime: "application/pdf", nomeArquivo: null, tamanhoBytes: doc.length, base64: Buffer.from(doc).toString("base64") } : null,
    recebidoEm: AGORA.toISOString(), origemTipo: "LIVE",
  };
};
export function clienteSimulado(responder) {
  const pedidos = [];
  return { pedidos, beta: { messages: { async create(req) { pedidos.push(req); const r = await responder(req, pedidos.length); return { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }] }; } } } };
}

export async function cenario({ responder = () => base({}), comandosDeterministicos = true, config = CONFIG, extras = {} } = {}) {
  const m = montar({ escopos: ESCOPOS });
  const c = (org, u) => ctx(org, u, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  const forn = await m.nucleo.registrarContraparte(c(ORG, ALFA), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const conta = async (vencimento, valor = 12345, u = ALFA, f = forn) => m.nucleo.registrarObrigacao(c(ORG, u), { contraparteId: f.id, valorOriginalCentavos: valor, categoria: "INSUMOS", descricao: "Compra sintética", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento });
  const banco = await criarBancoMova();
  criados.push(banco);
  const cfg = validarConfiguracao(config);
  await instalarConfiguracao(banco.pool, cfg);
  const cliente = clienteSimulado(responder);
  const chamadas = [];
  const nucleo = Object.fromEntries(Object.entries(m.nucleo).map(([nome, op]) => [nome, async (cx, ...a) => { chamadas.push({ nome, organizacaoId: cx?.organizacaoId, unidadeId: cx?.unidadeId, permissoes: cx?.permissoes }); return op(cx, ...a); }]));
  const ref = {};
  const extrator = criarExtratorAnthropic({ cliente, obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio: () => AGORA });
  const montarMova = () => criarMova({ configuracao: config, nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, extrator, pool: banco.pool, relogio: () => AGORA, comandosDeterministicos, ...(typeof extras === "function" ? extras({ nucleo, m, c }) : extras) });
  ref.mova = montarMova();
  let mova = ref.mova;
  const enviar = async (p) => { const r = await mova.receptor.receber(p); await mova.receptor.trabalhar(); return r; };
  // 25/11: REINÍCIO do processo — um MOVA novo sobre o MESMO banco (nada em memória sobrevive; só o que está no PostgreSQL).
  const reiniciar = () => { ref.mova = montarMova(); mova = ref.mova; resultado.mova = mova; return mova; };
  const saida = async () => (await banco.pool.query("select grupo_jid as destino, texto from mova.resposta order by seq")).rows;
  const ultima = async () => (await mova.armazenamento.historico.todos()).at(-1);
  const contar = async (tabela) => Number((await banco.pool.query(`select count(*)::int n from mova.${tabela}`)).rows[0].n);
  const ultimaDoMova = async () => (await mova.armazenamento.historico.todos()).at(-1);
  const resultado = { m, c, forn, conta, banco, cliente, chamadas, mova, enviar, saida, ultima: ultimaDoMova, contar, cfg, reiniciar };
  return resultado;
}

