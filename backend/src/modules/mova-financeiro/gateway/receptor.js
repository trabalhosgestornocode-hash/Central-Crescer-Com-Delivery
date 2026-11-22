// RECEPTOR do MOVA — evento do Gateway Baileys → fila persistente → (mídia → evidência → evento validado) → motor.
//
// Ordem pensada para não tocar no que não deve:
//   - payload inválido ou mensagem PRIVADA (não é grupo): recusado sem registrar nada;
//   - grupo NÃO autorizado: descartado antes de guardar evidência ou enfileirar (só um registro de código no histórico);
//   - mensagem da própria conta (inclusive respostas do MOVA): descartada;
//   - reenvio do Gateway / reconexão do Baileys (mesmo eventoId): não entra de novo na fila;
//   - banco fora: devolve INDISPONIVEL (a rota responde 503 e o Gateway reenvia depois) — nada se perde em silêncio.
// Não envia nada ao WhatsApp: as respostas ficam na caixa de saída (estado PENDENTE). Não altera as mensagens automáticas.
import { normalizarGatewayMova } from "../adaptadores/gatewayBaileys.js";
import { normalizarBaileys } from "../adaptadores/baileys.js";
import { CONTRATO_EVENTO_VERSAO, MIDIA_MAX_BYTES, MIMES_ACEITOS, validarEvento } from "../contratos/evento.js";
import { conversaAutorizada, grupoAutorizado, mascarar } from "../dominio/configuracao.js";
import { ErroTransitorio } from "./fila.js";
import { RESPOSTA } from "../aplicacao/respostas.js";
import { ACESSO, foiAcionado, participanteAutorizado } from "../dominio/participantes.js";

/** GATEWAY = payload do Gateway próprio (produção futura); WAMESSAGE = item cru do Baileys (fixtures/simulação). */
const ADAPTADORES = Object.freeze({ GATEWAY: normalizarGatewayMova, WAMESSAGE: normalizarBaileys });

/**
 * @param {{cfg:object, motor:{processar:Function}, fila:object, evidencias:object, armazenamento:object,
 *          obterMidia?:(bruto:object) => Promise<Uint8Array>, relogio?:() => Date, registrar?:Function}} deps
 */
export function criarReceptor({ cfg, motor, fila, evidencias, armazenamento, obterMidia = null, relogio = () => new Date(), registrar = () => {}, controle = null }) {
  async function receber(payload, { formato = "GATEWAY" } = {}) {
    // Interruptor em tempo real (Execução 05): desligado/suspenso ⇒ aceita e descarta (200: o Gateway não re-tenta), sem registro.
    if (controle && !(await controle.ligado("recebimento"))) return { status: "IGNORADO", motivo: "RECEBIMENTO_DESLIGADO" };
    const adaptar = ADAPTADORES[formato];
    if (!adaptar) return { status: "RECUSADO", motivo: "FORMATO_DESCONHECIDO" };
    const n = adaptar(payload);
    if (!n.ok) return { status: n.motivo === "nao_e_grupo" ? "IGNORADO" : "RECUSADO", motivo: n.motivo === "nao_e_grupo" ? "NAO_E_GRUPO" : n.motivo };
    const bruto = n.bruto;
    try {
      // Conversa privada: a autorizada (homologação) admite a forma com/sem nono dígito e segue com o JID CADASTRADO.
      // Não autorizada: descartada SEM registro no banco (decisão 04B: dado de terceiro não fica guardado); só um código no log.
      if (!bruto.grupoId.endsWith("@g.us")) {
        const conversa = conversaAutorizada(cfg, bruto.grupoId);
        if (!conversa) {
          registrar({ tipo: "MOVA_CONVERSA_PRIVADA_NAO_AUTORIZADA" });
          return { status: "IGNORADO", motivo: "NAO_E_GRUPO" };
        }
        if (conversa.grupoId !== bruto.grupoId) { registrar({ tipo: "MOVA_CONVERSA_PRIVADA_NONO_DIGITO" }); bruto.grupoId = conversa.grupoId; }
      }
      if (!grupoAutorizado(cfg, bruto.grupoId)) {
        await armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: bruto.eventoId, decisao: "IGNORADO", motivo: "GRUPO_NAO_AUTORIZADO", provedor: bruto.provedor });
        registrar({ tipo: "MOVA_GRUPO_NAO_AUTORIZADO", grupo: mascarar(bruto.grupoId) });
        return { status: "IGNORADO", motivo: "GRUPO_NAO_AUTORIZADO" };
      }
      if (bruto.fromMe) return { status: "IGNORADO", motivo: "MENSAGEM_PROPRIA" };
      // Agente 2 — grupo por LISTA: quem não está na lista e mensagem que não chama o MOVA são descartados ANTES de guardar
      // qualquer coisa (texto e documento de terceiro não ficam no banco); só um código no log operacional.
      const grupo = grupoAutorizado(cfg, bruto.grupoId);
      if ((grupo.acesso ?? ACESSO.ABERTO) === ACESSO.LISTA) {
        if (!participanteAutorizado(grupo, bruto)) { registrar({ tipo: "MOVA_PARTICIPANTE_NAO_AUTORIZADO", grupo: mascarar(bruto.grupoId) }); return { status: "IGNORADO", motivo: "PARTICIPANTE_NAO_AUTORIZADO" }; }
        const a = await foiAcionado({ grupo, bruto, armazenamento });
        if (!a.acionado) return { status: "IGNORADO", motivo: "NAO_ACIONADO" };
        bruto.acionadoPor = a.por;
      }
      const r = await fila.enfileirar(bruto.eventoId, bruto);
      return r.duplicado ? { status: "DUPLICADO", motivo: "EVENTO_JA_RECEBIDO" } : { status: "ENFILEIRADO" };
    } catch (e) {
      if (e instanceof ErroTransitorio) return { status: "INDISPONIVEL", motivo: e.codigo };
      throw e;
    }
  }

  async function montarEvento(bruto) {
    let midia = null;
    let tipo = bruto.tipo;
    if (bruto.midia) {
      const mime = String(bruto.midia.mime ?? "").split(";")[0].trim();
      if (!MIMES_ACEITOS.includes(mime)) { tipo = "OUTRO"; }
      else {
        let bytes;
        try {
          if (bruto.midia.base64) bytes = Buffer.from(bruto.midia.base64, "base64");
          else if (obterMidia) bytes = await obterMidia(bruto);
        } catch { throw new ErroTransitorio("MIDIA_INDISPONIVEL"); }
        if (!bytes || bytes.length === 0) throw new ErroTransitorio("MIDIA_INDISPONIVEL");
        if (bytes.length > MIDIA_MAX_BYTES) { tipo = "OUTRO"; }
        else {
          const g = await evidencias.guardar(bytes, { mime, nomeArquivo: bruto.midia.nomeArquivo });
          midia = { mime, tamanhoBytes: g.tamanhoBytes, sha256: g.sha256, nomeArquivo: bruto.midia.nomeArquivo ?? null, referencia: g.referencia };
        }
      }
    }
    return validarEvento({
      contrato: CONTRATO_EVENTO_VERSAO, provedor: bruto.provedor, eventoId: bruto.eventoId, mensagemId: bruto.mensagemId, grupoId: bruto.grupoId,
      participanteId: bruto.participanteId, telefoneE164: bruto.telefoneE164 ?? null, nomeExibicao: bruto.nomeExibicao ?? null, fromMe: bruto.fromMe,
      tipo, texto: bruto.texto ?? null, respostaA: bruto.respostaA ?? null, midia, recebidoEm: bruto.recebidoEm ?? relogio().toISOString(),
    });
  }

  /** Processa o que estiver pendente na fila (chamado por um laço/agendador; nos testes, diretamente). */
  async function trabalhar() {
    if (controle && !(await controle.ligado("processamento"))) return 0; // eventos ficam na fila, intactos, até religar
    return fila.processarPendentes(async (bruto) => {
      const v = await montarEvento(bruto);
      if (!v.ok) {
        await armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: bruto.eventoId, decisao: "IGNORADO", motivo: `EVENTO_INVALIDO:${v.erro}` });
        return { decisao: "IGNORADO", motivo: "EVENTO_INVALIDO" };
      }
      return motor.processar(v.evento);
    }, {
      aoDesistir: async ({ carga, codigo }) => {
        try {
          await armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: carga.eventoId, decisao: "FALHOU", motivo: codigo });
          const texto = codigo === "MIDIA_INDISPONIVEL" ? RESPOSTA.falhaLeitura() : codigo === "BANCO_INDISPONIVEL" ? RESPOSTA.bancoIndisponivel() : RESPOSTA.financeiroIndisponivel();
          await armazenamento.saida.enfileirar({ grupoId: carga.grupoId, respostaA: carga.mensagemId, eventoId: carga.eventoId, texto, simulada: true });
        } catch { /* banco ainda fora: o item fica FALHOU na fila (ou volta pelo lease) e aparece no Centro Financeiro */ }
      },
    });
  }

  return Object.freeze({ receber, trabalhar });
}
