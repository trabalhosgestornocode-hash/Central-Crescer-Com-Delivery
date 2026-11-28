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
import { createHash } from "node:crypto";
import { CONTRATO_EVENTO_VERSAO, MIDIA_MAX_BYTES, MIDIA_RECUSADA, MIMES_ACEITOS, mimeEfetivo, validarEvento } from "../contratos/evento.js";
import { referenciaDoConteudo } from "./evidencias.js";
import { MIMES_SEM_LEITURA } from "../aplicacao/recebimentoDocumental.js";
import { conversaAutorizada, grupoAutorizado, mascarar } from "../dominio/configuracao.js";
import { ErroTransitorio } from "./fila.js";
import { RESPOSTA } from "../aplicacao/respostas.js";
import { ACESSO, CAPACIDADES, RETRATO_VALIDADE_MS, algumaUnidadePermite, foiAcionado, identificarParticipante, participanteAutorizado } from "../dominio/participantes.js";

/** Tamanho real do conteúdo em base64 (sem decodificar). */
const bytesDoBase64 = (b64) => { const s = String(b64).replace(/\s/g, ""); return Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0); };

/** GATEWAY = payload do Gateway próprio (produção futura); WAMESSAGE = item cru do Baileys (fixtures/simulação). */
const ADAPTADORES = Object.freeze({ GATEWAY: normalizarGatewayMova, WAMESSAGE: normalizarBaileys });

/**
 * @param {{cfg:object, motor:{processar:Function}, fila:object, evidencias:object, armazenamento:object,
 *          obterMidia?:(bruto:object) => Promise<Uint8Array>, relogio?:() => Date, registrar?:Function}} deps
 */
export function criarReceptor({ cfg, motor, fila, evidencias, armazenamento, obterMidia = null, relogio = () => new Date(), registrar = () => {}, controle = null, recebimentoDocumental = false }) {
  /**
   * Agente 2 — AUTORIZAÇÃO DO ARQUIVO antes de qualquer gravação (fila, evidência, documento): remetente da lista com perfil que
   * envia documentos em alguma unidade, cadastro AINDA ativo no banco (revogação vale sem reiniciar), formato e tamanho.
   * Devolve o motivo da recusa (o conteúdo é descartado) ou null. Grupo ABERTO (legado) não envia documento sem leitura.
   */
  async function recusaDoArquivo(grupo, bruto) {
    const entregador = Boolean(grupo.entregador); // conversa de entregador: cadastro próprio, conferido pelo fluxo dele (desligado em produção)
    const p = entregador ? null : participanteAutorizado(grupo, bruto);
    if (!entregador && (!p || (recebimentoDocumental && p.aberto) || !algumaUnidadePermite(p, (c) => c.documentos))) return MIDIA_RECUSADA.PERFIL_SEM_DOCUMENTOS;
    const mime = mimeEfetivo(bruto.midia.mime, bruto.midia.nomeArquivo);
    if (!MIMES_ACEITOS.includes(mime)) return MIDIA_RECUSADA.FORMATO_NAO_ACEITO;
    if (mime === "application/xml" && !entregador) return MIDIA_RECUSADA.FORMATO_NAO_ACEITO; // XML só vale como NFS-e do entregador
    if (recebimentoDocumental && !entregador && !MIMES_SEM_LEITURA.includes(mime)) return MIDIA_RECUSADA.FORMATO_NAO_ACEITO_SEM_LEITURA;
    const tamanho = bruto.midia.base64 ? bytesDoBase64(bruto.midia.base64) : Number(bruto.midia.tamanhoBytes ?? 0);
    if (tamanho > MIDIA_MAX_BYTES) return MIDIA_RECUSADA.ARQUIVO_GRANDE;
    if (recebimentoDocumental && !entregador) {
      if (typeof armazenamento.autorizacoes?.vigentes !== "function") return MIDIA_RECUSADA.PERFIL_SEM_DOCUMENTOS; // sem como conferir ⇒ não guarda
      const v = await armazenamento.autorizacoes.vigentes({ grupoId: bruto.grupoId, participanteId: bruto.participanteId, telefoneE164: bruto.telefoneE164 ?? null });
      if (!v.some((r) => CAPACIDADES[r.perfil]?.documentos)) return MIDIA_RECUSADA.PERFIL_SEM_DOCUMENTOS;
    }
    return null;
  }

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
      // Retrato dos membros (Gateway, canal HMAC) do grupo AUTORIZADO: gravado com a hora da verificação, nunca no futuro e nunca
      // vencido (o motor exige no máximo 15 min). Sai da carga antes da fila: a lista de membros não fica guardada no evento.
      if (bruto.membrosGrupo) {
        const r = bruto.membrosGrupo;
        delete bruto.membrosGrupo;
        const agora = relogio().getTime();
        const em = Date.parse(r.verificadoEm);
        if (typeof armazenamento.membros?.registrar === "function" && bruto.grupoId.endsWith("@g.us") && em <= agora + 60_000 && agora - em <= RETRATO_VALIDADE_MS) {
          await armazenamento.membros.registrar({ grupoId: bruto.grupoId, membros: r.membros, verificadoEm: new Date(Math.min(em, agora)).toISOString(), fonte: "GATEWAY" });
        } else registrar({ tipo: "MOVA_RETRATO_DESCARTADO", grupo: mascarar(bruto.grupoId) });
      }
      // Agente 2 — grupo por LISTA: quem não está na lista e mensagem que não chama o MOVA são descartados ANTES de guardar
      // qualquer coisa (texto e documento de terceiro não ficam no banco); só um código no log operacional.
      const grupo = grupoAutorizado(cfg, bruto.grupoId);
      if ((grupo.acesso ?? ACESSO.ABERTO) === ACESSO.LISTA) {
        // 27/11: identificador e telefone autenticado de PESSOAS DIFERENTES ⇒ bloqueia e registra a inconsistência (sem conteúdo)
        if (identificarParticipante(grupo, bruto).conflito) {
          registrar({ tipo: "MOVA_IDENTIDADE_CONFLITANTE", grupo: mascarar(bruto.grupoId) });
          await armazenamento?.auditoria?.registrar?.({ acao: "IDENTIDADE_CONFLITANTE", atorTipo: "SISTEMA", atorRef: "receptor", alvo: mascarar(bruto.grupoId), dados: { motivo: "IDENTIFICADOR_E_TELEFONE_DE_PESSOAS_DIFERENTES", mensagemId: bruto.mensagemId ?? null } });
          return { status: "IGNORADO", motivo: "IDENTIDADE_CONFLITANTE" };
        }
        if (!participanteAutorizado(grupo, bruto)) { registrar({ tipo: "MOVA_PARTICIPANTE_NAO_AUTORIZADO", grupo: mascarar(bruto.grupoId) }); return { status: "IGNORADO", motivo: "PARTICIPANTE_NAO_AUTORIZADO" }; }
        const a = await foiAcionado({ grupo, bruto, armazenamento });
        if (!a.acionado) {
          // 25/11: arquivo de participante autorizado descartado (sem legenda ou formato fora de imagem/PDF) deixa rastro no log (sem conteúdo).
          if (bruto.midia) registrar({ tipo: "MOVA_DOCUMENTO_NAO_ACIONADO", grupo: mascarar(bruto.grupoId) });
          return { status: "IGNORADO", motivo: "NAO_ACIONADO" };
        }
        bruto.acionadoPor = a.por;
      }
      if (bruto.midia) {
        const motivo = await recusaDoArquivo(grupo, bruto);
        if (motivo) {
          registrar({ tipo: "MOVA_ARQUIVO_RECUSADO_ANTES_DE_GUARDAR", motivo, grupo: mascarar(bruto.grupoId) });
          // Com o recebimento ligado o motor responde o motivo; no legado (com leitura), formato/tamanho seguem como antes (OUTRO, sem resposta própria).
          const avisar = recebimentoDocumental || motivo === MIDIA_RECUSADA.PERFIL_SEM_DOCUMENTOS;
          bruto.midia = null;
          bruto.tipo = "OUTRO";
          if (avisar) bruto.midiaRecusada = motivo;
        }
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
    let midiaLocal = null;
    let tipo = bruto.tipo;
    if (bruto.midia) {
      const mime = mimeEfetivo(bruto.midia.mime, bruto.midia.nomeArquivo);
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
          // Nada é gravado aqui: o motor confere os bytes em memória e chama `guardar` SÓ depois de autorizar (perfil na unidade,
          // formato, assinatura, conteúdo ativo).
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          midia = { mime, tamanhoBytes: bytes.length, sha256, nomeArquivo: bruto.midia.nomeArquivo ?? null, referencia: referenciaDoConteudo(sha256) };
          midiaLocal = Object.freeze({ bytes, guardar: () => evidencias.guardar(bytes, { mime, nomeArquivo: bruto.midia.nomeArquivo ?? null }) });
        }
      }
    }
    const v = validarEvento({
      ...(bruto.midiaRecusada ? { midiaRecusada: bruto.midiaRecusada } : {}),
      contrato: CONTRATO_EVENTO_VERSAO, provedor: bruto.provedor, eventoId: bruto.eventoId, mensagemId: bruto.mensagemId, grupoId: bruto.grupoId,
      participanteId: bruto.participanteId, telefoneE164: bruto.telefoneE164 ?? null, nomeExibicao: bruto.nomeExibicao ?? null, fromMe: bruto.fromMe,
      tipo, texto: bruto.texto ?? null, respostaA: bruto.respostaA ?? null, midia, recebidoEm: bruto.recebidoEm ?? relogio().toISOString(),
    });
    return v.ok ? { ...v, midiaLocal } : v;
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
      return motor.processar(v.evento, { midiaLocal: v.midiaLocal });
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
