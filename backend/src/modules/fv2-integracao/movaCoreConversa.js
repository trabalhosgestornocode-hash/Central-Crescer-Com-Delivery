// MOVA CORE — MONTAGEM da conversa no MOVA de produção (só quando MOVA_CORE_CONVERSA=SOMBRA|RESPOSTA e a IA do MOVA está ligada).
//   * Leitura: a MESMA porta do MOVA (lista fechada, identidade de serviço, concessão persistida conferida pelo núcleo), em
//     `portaSomenteLeitura`; a permissão de consulta só existe nas unidades do PILOTO que o MOVA já atende.
//   * IA: o MESMO cliente e o MESMO orçamento persistente do MOVA (`clienteComOrcamento`: reserva, conclusão, controle 'ia').
//     O teto estrito por chamada do motor atual não se aplica (o laço usa blocos de ferramenta); o núcleo tem o próprio limite
//     por mensagem (passos e custo) e o orçamento total/diário continua sendo o do MOVA.
//   * Conhecimento: o corpo da documentação do sistema em memória, PENDENTE (= "documentação em revisão"), nunca regra oficial.
//   * Operações (25/11, MOVA_CORE_OPERACOES, padrão DESLIGADO): o serviço F4 com SÓ a prestação de sangria; propostas no banco
//     do MOVA (migração 0020 — sem ela, nada de operação); políticas = as MESMAS do motor atual (mova.politica_autonomia);
//     execução (EXECUTAR) = a MESMA porta operacional do motor atual (lista fechada, concessão gravada, núcleo revalida tudo).
//     PROPOR prepara e guarda, mas nada executa. Sem a porta operacional implantada, EXECUTAR cai para PROPOR.
import { clienteComOrcamento } from "../mova-financeiro/index.js";
import { criarMovaCore, portaSomenteLeitura } from "../mova-core/index.js";
import { custoRealMicrousd } from "../mova-core/custo.js";
import { criarServicoDeConhecimento } from "../mova-core/conhecimento.js";
import { carregarConhecimentoDoSistema } from "../mova-core/conhecimentoDoSistema.js";
import { MODO_OPERACOES, criarConversaWhatsapp, orcamentoPorMensagem } from "../mova-core/conversaWhatsapp.js";
import { TIPO_OPERACAO, criarServicoDeOperacoes } from "../mova-core/operacoes.js";
import { validarPolitica } from "../mova-financeiro/dominio/autonomia.js";
import { decidirSaidaNoGrupo } from "../mova-financeiro/dominio/participantes.js";

/** Tipos que a conversa pode preparar: a compra paga e o pagamento de conta ficam no fluxo de documentos (um motor por operação). */
export const TIPOS_DA_CONVERSA = Object.freeze([TIPO_OPERACAO.PRESTACAO_DE_SANGRIA]);

/** Serviço de operações da conversa, ou null (desligado / sem repositório). Nunca lança: falha ⇒ conversa só de consulta. */
export function montarOperacoesDaConversa({ modo, repositorio, porta, operacional = null, armazenamento = null, registrar = () => {}, relogio = () => new Date() }) {
  if (!modo || modo === MODO_OPERACOES.DESLIGADO) return null;
  if (!repositorio) { registrar({ tipo: "MOVA_CORE_OPERACOES_SEM_REPOSITORIO", aviso: "migração 0020 ausente: operações pela conversa desligadas" }); return null; }
  const executa = modo === MODO_OPERACOES.EXECUTAR && Boolean(operacional);
  if (modo === MODO_OPERACOES.EXECUTAR && !operacional) registrar({ tipo: "MOVA_CORE_OPERACOES_SEM_PORTA_OPERACIONAL", aviso: "EXECUTAR sem identidade operacional: só propõe" });
  const politicas = async (organizacaoId) => {
    if (typeof armazenamento?.politicas?.listar !== "function") return [];
    const validas = [];
    for (const p of await armazenamento.politicas.listar(organizacaoId)) { try { validas.push(validarPolitica(p)); } catch { registrar({ tipo: "MOVA_POLITICA_INVALIDA_IGNORADA" }); } }
    return validas;
  };
  const servico = criarServicoDeOperacoes({ repositorio, porta, portaOperacional: executa ? operacional : null, tipos: TIPOS_DA_CONVERSA,
    politicas: async (organizacaoId) => (organizacaoId ? politicas(organizacaoId) : []), auditoria: { registrar }, relogio: () => relogio().getTime() });
  return Object.freeze({ ...servico, executa });
}

/**
 * @param {{ conversaCore:{modo:string, unidades:string[], exigirVinculo?:boolean}, servicoUsuarioId:string, configuracao:object,
 *           porta:object, acaoVer:string, orcamento:object, controle?:object, criarClienteIa:() => object,
 *           registrar?:Function, relogio?:() => Date, identidade?:object, modelo?:string }} p
 * @returns {Promise<object|null>} null = nenhuma unidade do piloto está no MOVA (fica tudo no motor atual)
 */
export async function montarConversaCore({ conversaCore, servicoUsuarioId, configuracao, porta, acaoVer, orcamento, controle = null, criarClienteIa, registrar = () => {}, relogio = () => new Date(), identidade = null, modelo = null, operacional = null, armazenamento = null, repositorioDePropostas = null }) {
  const doMova = new Set(configuracao.unidades.map((u) => u.unidadeId));
  const unidades = conversaCore.unidades.filter((u) => doMova.has(u));
  if (!unidades.length) { registrar({ tipo: "MOVA_CORE_CONVERSA_SEM_UNIDADE", aviso: "nenhuma unidade do piloto está configurada no MOVA" }); return null; }
  const piloto = new Set(unidades);
  const leitura = portaSomenteLeitura({
    ler: (op, escopo, entrada) => porta.ler(op, escopo, entrada),
    // consulta só nas unidades do piloto e só pela identidade de serviço (o núcleo confere a concessão persistida dela)
    permissoesDoUsuario: async ({ unidadeId, usuarioId }) => (piloto.has(unidadeId) && usuarioId === servicoUsuarioId ? [acaoVer] : []),
    ehErroDeRegra: (e) => porta.ehErroDeRegra?.(e) ?? false,
  });
  const base = criarClienteIa();
  const comOrcamento = clienteComOrcamento({ beta: { messages: { create: (r) => base.messages.create(r), countTokens: (r) => base.messages.countTokens(r) } } }, { orcamento, controle, teto: null });
  const cliente = { messages: { create: (r) => comOrcamento.beta.messages.create(r) } };
  const conhecimento = criarServicoDeConhecimento();
  await carregarConhecimentoDoSistema(conhecimento);
  const operacoes = montarOperacoesDaConversa({ modo: conversaCore.operacoes, repositorio: repositorioDePropostas, porta: leitura, operacional, armazenamento, registrar, relogio });
  const core = criarMovaCore({ porta: leitura, cliente, orcamento: orcamentoPorMensagem({ custo: custoRealMicrousd }), auditoria: { registrar }, conhecimento,
    opcoes: modelo ? { modelo } : {}, relogio: () => relogio().getTime(), operacoes });
  // valores no grupo: a MESMA decisão do motor atual (grupo financeiro, membros comprovados pelo retrato recente)
  const valoresNoGrupo = async (grupo) => {
    const retrato = typeof armazenamento?.membros?.obter === "function" ? await armazenamento.membros.obter(grupo.grupoId).catch(() => null) : null;
    return decidirSaidaNoGrupo({ grupo, consulta: "MOVA_CORE", unidades: grupo.unidades, retrato, agora: relogio() }).saida === "GRUPO";
  };
  registrar({ tipo: "MOVA_CORE_CONVERSA_MONTADA", modo: conversaCore.modo, unidades: unidades.length, operacoes: operacoes ? (operacoes.executa ? "EXECUTAR" : "PROPOR") : "DESLIGADO", grupos: (conversaCore.grupos ?? []).length });
  return criarConversaWhatsapp({ core, cfg: configuracao, modo: conversaCore.modo, unidadesDoPiloto: unidades, identidadeServico: servicoUsuarioId,
    identidade, exigirVinculo: conversaCore.exigirVinculo === true, registrar, relogio, grupos: conversaCore.grupos ?? [], valoresNoGrupo, escrita: Boolean(operacoes?.executa) });
}
