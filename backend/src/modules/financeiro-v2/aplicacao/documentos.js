// Documentos e evidências. O núcleo guarda apenas a FICHA do documento (onde está, hash, tipo, versão) —
// o arquivo original fica em armazenamento privado e imutável, fora do repositório Git e fora deste módulo.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { validarDocumento, validarVinculoDocumental } from "../contratos/comandos.js";

export function operacoesDeDocumentos(b) {
  return {
    /** O mesmo arquivo (mesmo SHA-256) nunca é registrado duas vezes no escopo. Nova versão aponta para a anterior. */
    registrarDocumento(ctx, entrada) {
      const c = validarDocumento(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = `sha256:${c.hashSha256}`;
        const existente = await b.jaRegistrado(tx, cx, TIPO.DOCUMENTO, chave, impressao);
        if (existente) return { documento: existente, repetido: true };
        let versaoDocumento = 1;
        let anterior = null;
        if (c.substituiId) {
          anterior = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.substituiId, "Documento anterior");
          if (anterior.substituidoPorId) falhar(CODIGO.DOCUMENTO_INVALIDO, "O documento anterior já foi substituído por outra versão.");
          versaoDocumento = anterior.versaoDocumento + 1;
        }
        const documento = await b.criar(tx, cx, TIPO.DOCUMENTO, { ...c, versaoDocumento, substituidoPorId: null, responsavelId: cx.usuarioId, chaveIdempotencia: chave, impressao });
        if (anterior) await b.alterar(tx, cx, TIPO.DOCUMENTO, anterior, { substituidoPorId: documento.id }, EVENTO_HISTORICO.SUBSTITUICAO);
        return { documento, repetido: false };
      });
    },

    /** Vínculo só existe entre um documento e um registro que EXISTEM no mesmo escopo. */
    vincularDocumento(ctx, entrada) {
      const c = validarVinculoDocumental(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        await b.obterOuFalhar(tx, cx, c.registroTipo, c.registroId, "Registro financeiro");
        const chave = `${c.documentoId}|${c.registroTipo}|${c.registroId}`;
        const existente = await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chave);
        if (existente) return { vinculo: existente, repetido: true };
        return { vinculo: await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { ...c, chaveIdempotencia: chave }), repetido: false };
      });
    },
  };
}
