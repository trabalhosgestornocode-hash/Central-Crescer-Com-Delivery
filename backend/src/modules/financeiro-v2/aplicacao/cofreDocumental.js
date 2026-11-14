// Execução 06D — acesso AUTORIZADO aos documentos do cofre.
//
// A ficha (metadados) é vista com financeiro_v2.ver. O ARQUIVO (visualizar, baixar, conferir integridade) exige a ação
// própria financeiro_v2.documentos e é revalidado a cada pedido, dentro de uma transação que registra o acesso.
// Regras:
//   - o cliente informa só o identificador OPACO da ficha (UUID); o arquivo é localizado pela ficha, no escopo do contexto
//     — nunca por caminho, nome ou id do cofre vindo do cliente (sem path traversal possível);
//   - ficha de outra unidade/organização não existe para quem pergunta (NAO_ENCONTRADO), e a tentativa fica registrada;
//   - integridade conferida DUAS vezes: o cofre confere o próprio hash e o núcleo recalcula o SHA-256 contra a ficha;
//   - visualização em linha só para PDF sem conteúdo ativo (JavaScript, ações automáticas, anexos, mídia); o resto só é
//     entregue como ANEXO (download) com tipo neutro — nada é interpretado pelo navegador;
//   - limite de tamanho; nenhum conteúdo de arquivo vai para histórico ou log (só metadados do acesso).
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { exigirInteiro, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { TAMANHO_MAXIMO_BYTES } from "../contratos/cofre.js";

export const FINALIDADE_DOCUMENTO = Object.freeze({ VISUALIZAR: "VISUALIZAR", BAIXAR: "BAIXAR", VERIFICAR: "VERIFICAR" });

/** Tipos de arquivo que o cofre entrega (sempre como anexo, exceto PDF limpo, que pode ser visualizado). */
export const TIPOS_SUPORTADOS = Object.freeze({
  "application/pdf": { extensao: "pdf", visualizavel: true },
  "text/csv": { extensao: "csv", visualizavel: false },
  "text/plain": { extensao: "txt", visualizavel: false },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extensao: "xlsx", visualizavel: false },
  "application/x-ofx": { extensao: "ofx", visualizavel: false },
  "application/octet-stream": { extensao: "bin", visualizavel: false },
});

/** Marcadores de conteúdo ATIVO num PDF: com qualquer um deles, o arquivo NÃO é exibido em linha. */
const PDF_ATIVO = /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToR|GoToE|XFA)\b/;

/** Diz se um conteúdo é PDF de verdade e sem conteúdo ativo (varredura dos bytes como texto latin-1, sem interpretar). */
export function pdfSemConteudoAtivo(conteudo) {
  const inicio = Buffer.from(conteudo.subarray(0, 5)).toString("latin1");
  if (inicio !== "%PDF-") return false;
  return !PDF_ATIVO.test(Buffer.from(conteudo).toString("latin1"));
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pagina = (e) => ({ pagina: e.pagina === undefined ? 1 : exigirInteiro(e.pagina, "pagina", { min: 1, max: 10000 }), tamanho: e.tamanho === undefined ? 50 : exigirInteiro(e.tamanho, "tamanho", { min: 1, max: 100 }) });

export function operacoesDeCofreDocumental(b, { cofre, acessosNegados }) {
  const ficha = (d, eu) => ({
    id: d.id, tipo: d.tipo, descricao: d.descricao ?? null, origem: d.origem, competencia: d.competencia ?? null, recebidoEm: d.recebidoEm,
    versao: d.versaoDocumento, substituiId: d.substituiId ?? null, substituidoPorId: d.substituidoPorId ?? null, vigente: !d.substituidoPorId,
    hashSha256: d.hashSha256, registradoPor: d.responsavelId === eu ? "Você" : "Usuário registrado", registradoEm: d.criadoEm,
  });

  /** Ficha no escopo do contexto. Outra unidade/organização = "não existe" (e a tentativa é registrada). */
  async function fichaDoEscopo(tx, cx, id, finalidade) {
    const d = await tx.obter(cx, TIPO.DOCUMENTO, id);
    if (!d) {
      await acessosNegados?.registrar?.({ evento: `DOCUMENTO_${finalidade}`, codigo: "DOCUMENTO_FORA_DO_ESCOPO", documentoId: id, usuarioId: cx.usuarioId, organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId, em: b.agora() });
      falhar(CODIGO.NAO_ENCONTRADO, "Documento não encontrado.");
    }
    return d;
  }

  /** Lê o arquivo do cofre e confere o hash contra a FICHA (além da conferência do próprio cofre). */
  async function arquivoConferido(cx, d) {
    if (!cofre) falhar(CODIGO.COFRE_INDISPONIVEL, "O cofre de documentos não está configurado neste ambiente.");
    if (!(await cofre.existe(cx, d.arquivoId))) falhar(CODIGO.DOCUMENTO_INDISPONIVEL, "O arquivo original deste documento não está no cofre deste ambiente: só a ficha está disponível.");
    let lido;
    try {
      lido = await cofre.ler(cx, d.arquivoId);
    } catch (e) {
      if (e?.codigo === CODIGO.DOCUMENTO_INVALIDO) falhar(CODIGO.DOCUMENTO_ADULTERADO, "O arquivo guardado não confere com o hash registrado: acesso bloqueado.");
      throw e;
    }
    if (lido.tamanhoBytes > TAMANHO_MAXIMO_BYTES) falhar(CODIGO.DOCUMENTO_INDISPONIVEL, "Arquivo acima do limite de tamanho.");
    const hash = sha256(lido.conteudo);
    if (hash !== d.hashSha256 || lido.hashSha256 !== d.hashSha256) falhar(CODIGO.DOCUMENTO_ADULTERADO, "O arquivo guardado não confere com o hash registrado na ficha: acesso bloqueado.");
    return lido;
  }

  const registrarAcesso = (tx, cx, d, finalidade, resultado) => b.historico(tx, cx, TIPO.DOCUMENTO, d.id, EVENTO_HISTORICO.ACESSO_DOCUMENTO, null, { finalidade, resultado, versao: d.versao }, null);

  return {
    /** Fichas da unidade (metadados). Diz se o arquivo pode ser aberto por quem pergunta — sem abrir nada. */
    consultarDocumentos(ctx, e = {}) {
      semCamposDesconhecidos(e, ["competencia", "tipo", "situacao", "pagina", "tamanho"], "documentos");
      const competencia = e.competencia ? exigirCompetencia(e.competencia) : null;
      const tipo = e.tipo ? String(e.tipo).slice(0, 40) : null;
      const situacao = e.situacao ? exigirUmDe(e.situacao, ["VIGENTE", "SUBSTITUIDO"], "situacao") : null;
      const { pagina: pg, tamanho } = pagina(e);
      return b.consultar(ctx, async (cx, tx) => {
        const todos = (await tx.listar(cx, TIPO.DOCUMENTO)).filter((d) => (!competencia || d.competencia === competencia) && (!tipo || d.tipo === tipo) && (!situacao || (situacao === "VIGENTE") === !d.substituidoPorId));
        todos.sort((a, x) => (a.recebidoEm < x.recebidoEm ? 1 : a.recebidoEm > x.recebidoEm ? -1 : a.id < x.id ? -1 : 1));
        const fatia = todos.slice((pg - 1) * tamanho, pg * tamanho);
        const podeAbrir = cx.permissoes.includes(ACAO.DOCUMENTOS);
        const itens = [];
        for (const d of fatia) itens.push({ ...ficha(d, cx.usuarioId), arquivoNoCofre: cofre ? await cofre.existe(cx, d.arquivoId) : false, podeAbrir });
        return { itens, paginacao: { pagina: pg, tamanho, total: todos.length, paginas: Math.max(1, Math.ceil(todos.length / tamanho)) }, podeAbrir, tiposSuportados: Object.keys(TIPOS_SUPORTADOS) };
      });
    },

    /** Ficha + cadeia de versões + vínculos + histórico de decisões e acessos. */
    detalharDocumento(ctx, e = {}) {
      semCamposDesconhecidos(e, ["id"], "documento");
      const id = exigirUuid(e.id, "id");
      return b.consultar(ctx, async (cx, tx) => {
        const d = await fichaDoEscopo(tx, cx, id, "DETALHAR");
        const versoes = [];
        let atual = d;
        while (atual?.substituiId) { atual = await tx.obter(cx, TIPO.DOCUMENTO, atual.substituiId); if (atual) versoes.push(atual); }
        let seguinte = d;
        const posteriores = [];
        while (seguinte?.substituidoPorId) { seguinte = await tx.obter(cx, TIPO.DOCUMENTO, seguinte.substituidoPorId); if (seguinte) posteriores.push(seguinte); }
        const vinculos = await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { documentoId: d.id } });
        const historico = await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.DOCUMENTO, registroId: d.id } });
        return {
          ...ficha(d, cx.usuarioId), arquivoNoCofre: cofre ? await cofre.existe(cx, d.arquivoId) : false, podeAbrir: cx.permissoes.includes(ACAO.DOCUMENTOS),
          versoes: [...posteriores.reverse(), d, ...versoes].map((v) => ({ id: v.id, versao: v.versaoDocumento, vigente: !v.substituidoPorId, recebidoEm: v.recebidoEm, atual: v.id === d.id })),
          vinculos: vinculos.map((v) => ({ registroTipo: v.registroTipo, registroId: v.registroId })),
          historico: historico.map((h) => ({ evento: h.evento, em: h.em, porVoce: h.usuarioId === cx.usuarioId, finalidade: h.depois?.finalidade ?? null, resultado: h.depois?.resultado ?? null })),
        };
      });
    },

    /** Recalcula o hash do arquivo e compara com a ficha. O resultado (e só ele) fica no histórico. */
    verificarIntegridadeDoDocumento(ctx, e = {}) {
      semCamposDesconhecidos(e, ["id"], "integridade");
      const id = exigirUuid(e.id, "id");
      return b.executar(ctx, ACAO.DOCUMENTOS, async (cx, tx) => {
        const d = await fichaDoEscopo(tx, cx, id, FINALIDADE_DOCUMENTO.VERIFICAR);
        try {
          const lido = await arquivoConferido(cx, d);
          await registrarAcesso(tx, cx, d, FINALIDADE_DOCUMENTO.VERIFICAR, "INTEGRO");
          return { id: d.id, conferido: true, hashSha256: d.hashSha256, tamanhoBytes: lido.tamanhoBytes };
        } catch (erro) {
          if (erro?.codigo === CODIGO.DOCUMENTO_ADULTERADO) return { id: d.id, conferido: false, hashSha256: d.hashSha256, motivo: "O arquivo guardado não confere com o hash registrado." };
          throw erro;
        }
      });
    },

    /**
     * Entrega o ARQUIVO a quem tem financeiro_v2.documentos. VISUALIZAR só para PDF sem conteúdo ativo; o resto é BAIXAR,
     * sempre como anexo e com tipo neutro. Devolve também os cabeçalhos seguros que o servidor deve aplicar.
     */
    obterArquivoDoDocumento(ctx, e = {}) {
      semCamposDesconhecidos(e, ["id", "finalidade"], "arquivo");
      const id = exigirUuid(e.id, "id");
      const finalidade = exigirUmDe(e.finalidade, [FINALIDADE_DOCUMENTO.VISUALIZAR, FINALIDADE_DOCUMENTO.BAIXAR], "finalidade");
      return b.executar(ctx, ACAO.DOCUMENTOS, async (cx, tx) => {
        const d = await fichaDoEscopo(tx, cx, id, finalidade);
        const lido = await arquivoConferido(cx, d);
        const tipo = TIPOS_SUPORTADOS[lido.tipoMime] ? lido.tipoMime : "application/octet-stream";
        const visualizavel = TIPOS_SUPORTADOS[tipo].visualizavel && pdfSemConteudoAtivo(lido.conteudo);
        if (finalidade === FINALIDADE_DOCUMENTO.VISUALIZAR && !visualizavel) {
          falhar(CODIGO.DOCUMENTO_INDISPONIVEL, "Este arquivo não pode ser exibido com segurança na tela (não é PDF ou tem conteúdo ativo). Baixe-o para abrir num programa próprio.");
        }
        await registrarAcesso(tx, cx, d, finalidade, "ENTREGUE");
        const nome = `documento-v${d.versaoDocumento}.${TIPOS_SUPORTADOS[tipo].extensao}`;
        const emLinha = finalidade === FINALIDADE_DOCUMENTO.VISUALIZAR;
        return {
          conteudo: lido.conteudo, tamanhoBytes: lido.tamanhoBytes, hashSha256: d.hashSha256, nomeSeguro: nome, modo: emLinha ? "EM_LINHA" : "ANEXO",
          cabecalhos: {
            "content-type": emLinha ? "application/pdf" : "application/octet-stream",
            "content-disposition": `${emLinha ? "inline" : "attachment"}; filename="${nome}"`,
            "content-security-policy": "sandbox; default-src 'none'; object-src 'none'; script-src 'none'",
            "x-content-type-options": "nosniff", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer", "content-length": String(lido.tamanhoBytes),
          },
        };
      });
    },
  };
}
