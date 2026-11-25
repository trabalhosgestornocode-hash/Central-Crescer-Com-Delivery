// MOVA CORE — MONTAGEM da conversa no MOVA de produção (só quando MOVA_CORE_CONVERSA=SOMBRA|RESPOSTA e a IA do MOVA está ligada).
//   * Leitura: a MESMA porta do MOVA (lista fechada, identidade de serviço, concessão persistida conferida pelo núcleo), em
//     `portaSomenteLeitura`; a permissão de consulta só existe nas unidades do PILOTO que o MOVA já atende.
//   * IA: o MESMO cliente e o MESMO orçamento persistente do MOVA (`clienteComOrcamento`: reserva, conclusão, controle 'ia').
//     O teto estrito por chamada do motor atual não se aplica (o laço usa blocos de ferramenta); o núcleo tem o próprio limite
//     por mensagem (passos e custo) e o orçamento total/diário continua sendo o do MOVA.
//   * Conhecimento: o corpo da documentação do sistema em memória, PENDENTE (= "documentação em revisão"), nunca regra oficial.
//   * Sem operações: nenhuma escrita financeira existe nesta montagem.
import { clienteComOrcamento } from "../mova-financeiro/index.js";
import { criarMovaCore, portaSomenteLeitura } from "../mova-core/index.js";
import { custoRealMicrousd } from "../mova-core/custo.js";
import { criarServicoDeConhecimento } from "../mova-core/conhecimento.js";
import { carregarConhecimentoDoSistema } from "../mova-core/conhecimentoDoSistema.js";
import { criarConversaWhatsapp, orcamentoPorMensagem } from "../mova-core/conversaWhatsapp.js";

/**
 * @param {{ conversaCore:{modo:string, unidades:string[], exigirVinculo?:boolean}, servicoUsuarioId:string, configuracao:object,
 *           porta:object, acaoVer:string, orcamento:object, controle?:object, criarClienteIa:() => object,
 *           registrar?:Function, relogio?:() => Date, identidade?:object, modelo?:string }} p
 * @returns {Promise<object|null>} null = nenhuma unidade do piloto está no MOVA (fica tudo no motor atual)
 */
export async function montarConversaCore({ conversaCore, servicoUsuarioId, configuracao, porta, acaoVer, orcamento, controle = null, criarClienteIa, registrar = () => {}, relogio = () => new Date(), identidade = null, modelo = null }) {
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
  const core = criarMovaCore({ porta: leitura, cliente, orcamento: orcamentoPorMensagem({ custo: custoRealMicrousd }), auditoria: { registrar }, conhecimento,
    opcoes: modelo ? { modelo } : {}, relogio: () => relogio().getTime() });
  registrar({ tipo: "MOVA_CORE_CONVERSA_MONTADA", modo: conversaCore.modo, unidades: unidades.length });
  return criarConversaWhatsapp({ core, cfg: configuracao, modo: conversaCore.modo, unidadesDoPiloto: unidades, identidadeServico: servicoUsuarioId,
    identidade, exigirVinculo: conversaCore.exigirVinculo === true, registrar, relogio });
}
