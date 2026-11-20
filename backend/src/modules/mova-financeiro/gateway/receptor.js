// RECEPTOR do MOVA — webhook do provedor → fila → (mídia → evidência → evento validado) → motor.
//
// Ordem pensada para não tocar no que não deve:
//   - grupo NÃO autorizado é descartado ANTES de baixar mídia, guardar evidência ou enfileirar (só um registro de código
//     no histórico, sem conteúdo);
//   - mensagem da própria conta (inclusive respostas do MOVA) é descartada;
//   - reenvio do webhook (mesmo eventoId) não entra de novo na fila;
//   - mídia: base64 do webhook (quando a instância manda) ou porta `obterMidia`; falha de obtenção é TRANSITÓRIA (a fila tenta
//     de novo com espera crescente) e, esgotadas as tentativas, o grupo recebe "não consegui ler" — nada é criado.
// Não envia nada ao WhatsApp: a caixa de saída é simulada nesta execução. Não altera o Gateway nem as mensagens automáticas.
import { normalizarEvolution } from "../adaptadores/evolution.js";
import { normalizarBaileys } from "../adaptadores/baileys.js";
import { CONTRATO_EVENTO_VERSAO, MIDIA_MAX_BYTES, MIMES_ACEITOS, validarEvento } from "../contratos/evento.js";
import { grupoAutorizado, mascarar } from "../dominio/configuracao.js";
import { ErroTransitorio } from "./fila.js";
import { RESPOSTA } from "../aplicacao/respostas.js";

const ADAPTADORES = Object.freeze({ EVOLUTION: normalizarEvolution, BAILEYS: normalizarBaileys, SIMULADO: normalizarEvolution });

/**
 * @param {{cfg:object, motor:{processar:Function}, fila:object, evidencias:object, armazenamento:object,
 *          obterMidia?:(bruto:object) => Promise<Uint8Array>, relogio?:() => Date, registrar?:Function}} deps
 */
export function criarReceptor({ cfg, motor, fila, evidencias, armazenamento, obterMidia = null, relogio = () => new Date(), registrar = () => {} }) {
  async function receber(provedor, payload) {
    const adaptar = ADAPTADORES[provedor];
    if (!adaptar) return { status: "RECUSADO", motivo: "PROVEDOR_DESCONHECIDO" };
    const n = adaptar(payload);
    if (!n.ok) return { status: "IGNORADO", motivo: n.motivo };
    const bruto = provedor === "SIMULADO" ? { ...n.bruto, provedor: "SIMULADO" } : n.bruto;
    if (!grupoAutorizado(cfg, bruto.grupoId)) {
      armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: bruto.eventoId, decisao: "IGNORADO", motivo: "GRUPO_NAO_AUTORIZADO", provedor: bruto.provedor });
      registrar({ tipo: "MOVA_GRUPO_NAO_AUTORIZADO", grupo: mascarar(bruto.grupoId) });
      return { status: "IGNORADO", motivo: "GRUPO_NAO_AUTORIZADO" };
    }
    if (bruto.fromMe) return { status: "IGNORADO", motivo: "MENSAGEM_PROPRIA" };
    const r = fila.enfileirar(bruto.eventoId, bruto);
    return r.duplicado ? { status: "DUPLICADO", motivo: "EVENTO_JA_RECEBIDO" } : { status: "ENFILEIRADO" };
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
      participanteId: bruto.participanteId, fromMe: bruto.fromMe, tipo, texto: bruto.texto ?? null, respostaA: bruto.respostaA ?? null,
      midia, recebidoEm: bruto.recebidoEm ?? relogio().toISOString(),
    });
  }

  /** Processa o que estiver pendente na fila (chamado por um laço/agendador; nos testes, diretamente). */
  async function trabalhar() {
    return fila.processarPendentes(async (bruto) => {
      const v = await montarEvento(bruto);
      if (!v.ok) {
        armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: bruto.eventoId, decisao: "IGNORADO", motivo: `EVENTO_INVALIDO:${v.erro}` });
        return { decisao: "IGNORADO", motivo: "EVENTO_INVALIDO" };
      }
      return motor.processar(v.evento);
    }, {
      aoDesistir: ({ carga, codigo }) => {
        armazenamento.historico.registrar({ organizacaoId: null, unidadeId: null, eventoId: carga.eventoId, decisao: "FALHOU", motivo: codigo });
        const texto = codigo === "MIDIA_INDISPONIVEL" ? RESPOSTA.falhaLeitura() : RESPOSTA.financeiroIndisponivel();
        armazenamento.saida.enfileirar({ grupoId: carga.grupoId, respostaA: carga.mensagemId, texto, simulada: true });
      },
    });
  }

  return Object.freeze({ receber, trabalhar });
}
