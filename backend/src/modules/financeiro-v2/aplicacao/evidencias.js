// Envio de EVIDÊNCIA pela interface (Execução 08D): arquivo → validação → cofre → ficha + vínculo → reavaliação.
//
// PROTOCOLO (banco e disco não compartilham transação):
//   1. valida formato, tamanho, nome e escopo do destino ANTES de tocar no cofre;
//   2. guarda no cofre (gravação em duas fases, endereçada pelo SHA-256: o mesmo conteúdo é o mesmo arquivo) e LÊ DE
//      VOLTA conferindo o hash — só um arquivo íntegro e completo segue adiante;
//   3. numa ÚNICA transação do banco: confere de novo que o arquivo existe no cofre, grava a ficha (ou reaproveita a do
//      mesmo hash) e o vínculo com o registro da pendência, com histórico;
//   4. se o passo 3 falhar, o arquivo fica no cofre SEM ficha: não é visível, não tem URL e não é evidência de nada.
//      Repetir o envio reaproveita o mesmo arquivo (idempotente). `conferirCofreDocumental` lista arquivos sem ficha e
//      fichas sem arquivo; nada é apagado (evidência usada por decisão nunca é removida).
//
// Anexar NÃO resolve classificação, conciliação nem fechamento: a decisão continua sendo a operação própria, com a
// permissão própria (reclassificar, conciliar, homologar). Permissões separadas: enviar ≠ abrir arquivo ≠ decidir.
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO, TIPO_DOCUMENTO, VINCULAVEIS } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirFormatoDeEvidencia } from "../dominio/evidencias.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

const TIPOS_DE_EVIDENCIA = Object.freeze(["NOTA_FISCAL", "BOLETO", "COMPROVANTE", "CONTRATO", "DEMONSTRATIVO_REPASSE", "EXTRATO_BANCARIO", "RELATORIO_PROCESSADOR", "OUTRO"]);

function validarEnvio(e) {
  semCamposDesconhecidos(e, ["arquivo", "tipo", "descricao", "competencia", "vinculo"], "envio");
  semCamposDesconhecidos(e.arquivo, ["conteudo", "nome", "tipoMime"], "arquivo");
  semCamposDesconhecidos(e.vinculo, ["registroTipo", "registroId"], "vinculo");
  const formato = exigirFormatoDeEvidencia({ conteudo: e.arquivo?.conteudo, tipoMime: e.arquivo?.tipoMime, nomeArquivo: e.arquivo?.nome });
  return {
    conteudo: e.arquivo.conteudo, formato,
    tipo: exigirUmDe(e.tipo, TIPOS_DE_EVIDENCIA.filter((t) => TIPO_DOCUMENTO[t]), "tipo"),
    descricao: exigirTexto(e.descricao, "descricao", { max: 300 }),
    competencia: e.competencia === undefined || e.competencia === null || e.competencia === "" ? null : exigirCompetencia(e.competencia),
    vinculo: { registroTipo: exigirUmDe(e.vinculo?.registroTipo, VINCULAVEIS, "vinculo.registroTipo"), registroId: exigirUuid(e.vinculo?.registroId, "vinculo.registroId") },
  };
}

export function operacoesDeEvidencias(b, { cofre }) {
  const exigirCofrePronto = () => {
    if (!cofre) falhar(CODIGO.COFRE_INDISPONIVEL, "Envio de documentos exige um cofre privado configurado.");
    return cofre;
  };
  const escopoDe = (cx) => ({ organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId });

  return {
    /** Envia e vincula uma evidência ao registro de uma pendência. Idempotente pelo conteúdo. */
    async enviarEvidencia(ctx, entrada) {
      const c = validarEnvio(entrada);
      const co = exigirCofrePronto();
      const cx = b.autorizarContexto(ctx, ACAO.ENVIAR_DOCUMENTO);
      // 1. o destino precisa existir NESTE escopo antes de qualquer arquivo ser guardado
      await b.consultar(ctx, (c2, tx) => b.obterOuFalhar(tx, c2, c.vinculo.registroTipo, c.vinculo.registroId, "Registro da pendência"));
      // 2. cofre: duas fases + leitura conferida
      const g = await co.guardar(escopoDe(cx), { conteudo: c.conteudo, tipoMime: c.formato.tipoMime });
      const lido = await co.ler(escopoDe(cx), g.arquivoId);
      if (lido.hashSha256 !== g.hashSha256) falhar(CODIGO.DOCUMENTO_ADULTERADO, "O arquivo guardado não confere com o enviado.");
      // 3. ficha + vínculo numa transação
      return b.executar(ctx, ACAO.ENVIAR_DOCUMENTO, async (c3, tx) => {
        await b.obterOuFalhar(tx, c3, c.vinculo.registroTipo, c.vinculo.registroId, "Registro da pendência");
        if (!(await co.existe(escopoDe(c3), g.arquivoId))) falhar(CODIGO.COFRE_INDISPONIVEL, "O arquivo não está no cofre: nada foi registrado.");
        const chave = `sha256:${g.hashSha256}`;
        let documento = await tx.buscarPorChave(c3, TIPO.DOCUMENTO, chave);
        const documentoNovo = !documento;
        if (!documento) {
          documento = await b.criar(tx, c3, TIPO.DOCUMENTO, {
            origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: c.tipo, competencia: c.competencia, recebidoEm: b.hoje(),
            substituiId: null, descricao: c.descricao, versaoDocumento: 1, substituidoPorId: null, responsavelId: c3.usuarioId,
            chaveIdempotencia: chave, impressao: null, enviadoPelaInterface: true, nomeOriginalSeguro: c.formato.nome,
            tipoMime: c.formato.tipoMime, tamanhoBytes: c.formato.tamanhoBytes, conteudoAtivo: c.formato.conteudoAtivo,
          }, `Evidência enviada pela interface: ${c.descricao}`);
        }
        const chaveVinculo = `${documento.id}|${c.vinculo.registroTipo}|${c.vinculo.registroId}`;
        let vinculo = await tx.buscarPorChave(c3, TIPO.VINCULO_DOCUMENTAL, chaveVinculo);
        const vinculoNovo = !vinculo;
        if (!vinculo) {
          vinculo = await b.criar(tx, c3, TIPO.VINCULO_DOCUMENTAL, { documentoId: documento.id, registroTipo: c.vinculo.registroTipo, registroId: c.vinculo.registroId, chaveIdempotencia: chaveVinculo, finalidade: c.descricao }, c.descricao);
        }
        return {
          documento: { id: documento.id, tipo: documento.tipo, descricao: documento.descricao, versao: documento.versaoDocumento, recebidoEm: documento.recebidoEm },
          vinculo: { id: vinculo.id, registroTipo: vinculo.registroTipo, registroId: vinculo.registroId },
          repetido: !documentoNovo && !vinculoNovo, documentoReaproveitado: !documentoNovo,
          validacao: { formato: c.formato.formato, tamanhoBytes: c.formato.tamanhoBytes, hashConferido: true, conteudoAtivo: c.formato.conteudoAtivo, nome: c.formato.nome },
          efeito: "Documento guardado e vinculado. Anexar não comprova sozinho a classificação nem a conciliação: a decisão continua sendo da operação própria, com permissão e histórico.",
        };
      });
    },

    /** Conferência cofre × fichas: arquivos sem ficha (envio interrompido) e fichas sem arquivo. Nada é apagado. */
    conferirCofreDocumental(ctx) {
      const co = exigirCofrePronto();
      return b.consultar(ctx, async (cx, tx) => {
        if (!cx.permissoes.includes(ACAO.DOCUMENTOS)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Conferir o cofre exige a permissão de documentos.", { acao: ACAO.DOCUMENTOS });
        const fichas = await tx.listar(cx, TIPO.DOCUMENTO);
        const noCofre = new Set(typeof co.inventario === "function" ? await co.inventario(escopoDe(cx)) : []);
        const comFicha = new Set(fichas.map((d) => d.arquivoId));
        const fichasSemArquivo = [];
        for (const d of fichas) if (!(await co.existe(escopoDe(cx), d.arquivoId))) fichasSemArquivo.push(d.id);
        return {
          arquivosNoCofre: noCofre.size, fichas: fichas.length,
          arquivosSemFicha: [...noCofre].filter((id) => !comFicha.has(id)).length,
          fichasSemArquivo,
          observacao: "Arquivo sem ficha é resto de envio interrompido: não é visível nem evidência. Repetir o envio o reaproveita. Nada é apagado.",
        };
      });
    },
  };
}
