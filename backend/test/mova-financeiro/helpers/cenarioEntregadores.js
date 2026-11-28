// Cenario compartilhado dos testes de entregadores do MOVA (27/11/2026): Financeiro v2 REAL em memoria + banco do MOVA no PostgreSQL isolado.
// Duas empresas (Alfa = Acai, Beta = Subway), semanas 02/11 e 09/11 fechadas, entregadores sinteticos. Nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { after } from "node:test";
import { criarCofreMemoria, criarConcessoesMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../../src/modules/financeiro-v2/index.js";
import { TODAS, ctx } from "../../financeiro-v2/helpers/cenario.js";
import { AUTOMACAO_PAGAMENTO, criarMova, validarConfiguracao, instalarConfiguracao } from "../../../src/modules/mova-financeiro/index.js";
import { ALFA, BETA, CONFIG, ESCOPOS, FIN, FINANCEIRO, ORG } from "./operacao.js";
import { criarBancoMova, descartarBancoMova } from "./banco.js";

export const SEG = "2026-11-02", S2 = "2026-11-09";
export const AGORA = "2026-11-18T15:00:00.000Z"; // quarta 12:00 em Fortaleza (vencimento da semana 2)
export const ADM = "eeeeeeee-0000-4000-8000-000000000001";
export const MAURICIO = "5500000000301@s.whatsapp.net", MAURICIO_LID = "88000000000301@lid", RAFAEL = "5500000000302@s.whatsapp.net", SEM_FONE = "5500000000399@s.whatsapp.net";
export const GRUPO_ALFA = "120363000000000401@g.us", GRUPO_BETA = "120363000000000402@g.us";
const TUDO = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };
export const ENTREGADORES = [
  { unidadeId: ALFA, chave: "mauricio", telefoneE164: "+5500000000301", privado: MAURICIO, ids: [MAURICIO_LID], nome: "Mauricio Sintetico" },
  { unidadeId: BETA, chave: "mauricio", telefoneE164: "+5500000000301", privado: MAURICIO, ids: [MAURICIO_LID], nome: "Mauricio Sintetico" },
  { unidadeId: ALFA, chave: "rafael", telefoneE164: "+5500000000302", privado: RAFAEL, nome: "Rafael Sintetico" },
  // "zeca" tem fechamento e baixa, mas NÃO tem telefone cadastrado (não está na lista).
];
const dia = (inicio, i) => new Date(Date.parse(`${inicio}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
const entrega = (id, chave, nome, data, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: chave, entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
const ENTREGAS = {
  [ALFA]: [entrega(1, "mauricio", "Mauricio Sintetico", "2026-11-02", 700), entrega(2, "mauricio", "Mauricio Sintetico", "2026-11-08", 800), entrega(3, "mauricio", "Mauricio Sintetico", "2026-11-10", 600),
    entrega(4, "rafael", "Rafael Sintetico", "2026-11-05", 900), entrega(5, "zeca", "Zeca Sintetico", "2026-11-05", 400),
    // semana de 23/11 a 29/11 (auditoria da rotina de 30/11): só entra em testes que a fecham (`semanas`)
    entrega(7, "mauricio", "Mauricio Sintetico", "2026-11-24", 650), entrega(8, "mauricio", "Mauricio Sintetico", "2026-11-29", 750), entrega(9, "rafael", "Rafael Sintetico", "2026-11-25", 1000)],
  [BETA]: [entrega(6, "mauricio", "Mauricio Sintetico", "2026-11-03", 500), entrega(10, "mauricio", "Mauricio Sintetico", "2026-11-27", 1200)],
};
const apurar = async ({ unidadeId, inicio, fim }) => ({ disponivel: true, dias: Array.from({ length: 7 }, (_, i) => ({ data: dia(inicio, i), fonte: "foody", provisorio: false, aberto: false, triagem: 0 })),
  entregas: (ENTREGAS[unidadeId] ?? []).filter((e) => e.data >= inicio && e.data <= fim) });

const criados = [];
after(async () => { for (const b of criados.splice(0)) await descartarBancoMova(b).catch(() => {}); });

export async function cenario({ entregadores = ENTREGADORES, interpretador = null, semanas = [SEG, S2], agora = AGORA, leitorDeNota = null, documentos = {} } = {}) {
  const estado = { agora };
  const relogio = () => new Date(estado.agora);
  const cofre = criarCofreMemoria();
  const real = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS, relogio, cofre, entregadores: { fonte: { apurar }, inicioDaOperacao: SEG, cofreDeNotas: cofre } });
  const adm = (u) => ctx(ORG, u, TODAS, ADM);
  const contas = {};
  for (const u of [ALFA, BETA]) {
    await real.implantarPlanoDeContas(adm(u), { modelo: "ACAITERIA" });
    for (const s of semanas) await real.fecharSemanaDeEntregadores(adm(u), { inicio: s });
    contas[u] = (await real.configurarContaFinanceira(adm(u), { tipo: "BANCARIA", nome: "Banco Sintetico", instituicao: "Teste" })).id;
  }
  const banco = await criarBancoMova();
  criados.push(banco);
  const config = { ...CONFIG, entregadores, unidades: CONFIG.unidades.map((u) => ({ ...u, ...(documentos[u.unidadeId] ? { documentos: documentos[u.unidadeId] } : {}), empresa: u.unidadeId === ALFA ? "Acai Alfa Sintetico" : u.unidadeId === BETA ? "Subway Beta Sintetico" : null })),
    gruposAutorizados: [...CONFIG.gruposAutorizados,
      { grupoId: GRUPO_ALFA, unidades: [ALFA], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }] },
      { grupoId: GRUPO_BETA, unidades: [BETA], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }] }] };
  await instalarConfiguracao(banco.pool, validarConfiguracao(config));
  const ia = { beta: { messages: { async create() { throw new Error("IA nao pode ser chamada na notificacao de pagamento"); } } } };
  const montarMova = () => criarMova({ configuracao: config, nucleo: real, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool: banco.pool, relogio, comandosDeterministicos: true,
    extrator: { extrair: ia.beta.messages.create }, entregadores: true, interpretadorEntregador: interpretador, leitorDeNota });
  let mova = montarMova();
  const s = { estado, real, adm, contas, banco, get mova() { return mova; }, reiniciar() { mova = montarMova(); return mova; } };
  s.passada = () => s.mova.pagamentos.passada();
  s.ligar = (unidadeId = ALFA, extra = {}) => s.mova.armazenamento.automacoes.definir({ nome: AUTOMACAO_PAGAMENTO, organizacaoId: ORG, unidadeId, ativa: true, horario: "00:00", ...extra });
  s.saida = async (destino) => (await banco.pool.query("select id, grupo_jid as destino, texto, estado from mova.resposta where ($1::text is null or grupo_jid = $1) order by seq", [destino ?? null])).rows;
  s.marcar = async (destino, como) => { // retorno do Gateway simulado
    for (const r of (await s.saida(destino)).filter((x) => x.estado === "PENDENTE")) {
      if (como === "ENVIADA") await s.mova.armazenamento.saida.marcarEnviada(r.id, `WA-${r.id.slice(0, 8)}`);
      else await s.mova.armazenamento.saida.marcarFalhaDeEnvio(r.id, "GATEWAY_FORA", { final: true });
    }
  };
  s.eventos = async (unidadeId = ALFA) => (await banco.pool.query("select * from mova.notificacao_pagamento where unidade_id = $1 order by criado_em, id", [unidadeId])).rows;
  /** nota + conferência + liberação (o pré-requisito do Financeiro para qualquer baixa) */
  s.liberar = async (unidadeId, inicio, chave, nome, valorCentavos) => {
    const c = adm(unidadeId);
    await real.anexarDocumentoDoEntregador(c, { inicio, entregador: chave, tipoAnexo: "NOTA_FISCAL", numero: `N${inicio}${chave}${unidadeId.slice(-2)}`, emitente: `${nome} ME`, tomador: "Unidade Teste", valorCentavos, arquivo: { conteudo: new Uint8Array(Buffer.from(`%PDF-1.4 nota sintetica ${unidadeId} ${inicio} ${chave}`)), nome: "nf.pdf", tipoMime: "application/pdf" } });
    await real.iniciarConferenciaDaNota(c, { inicio, entregador: chave });
    await real.decidirNotaDoEntregador(c, { inicio, entregador: chave, decisao: "APROVAR", conferido: TUDO, justificativa: "Conferida." });
    await real.liberarPagamentoDoEntregador(c, { inicio, entregador: chave, demonstrativoConferido: true, justificativa: "Conferido." });
    return (await real.detalharFechamentoDoEntregador(c, { inicio, entregador: chave })).obrigacaoId;
  };
  s.pagar = (unidadeId, obrigacaoId, valorCentavos, dataEfetiva = "2026-11-18") => real.pagarContaAPagar(adm(unidadeId), { obrigacaoId, contaId: contas[unidadeId], dataEfetiva, valorCentavos });
  return s;
}
/** Liga a automação e faz a 1ª passada (só fixa o marco); avança o relógio 1 min para que o pagamento seguinte seja posterior ao marco. */
export async function ativar(s, unidadeId = ALFA) {
  await s.ligar(unidadeId);
  const r = await s.passada();
  assert.ok(r.pulados.includes("MARCO_FIXADO"), "1ª passada só fixa o marco");
  s.estado.agora = new Date(Date.parse(s.estado.agora) + 60_000).toISOString();
}

