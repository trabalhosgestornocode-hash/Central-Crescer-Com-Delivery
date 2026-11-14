// Cofre de documentos EM MEMÓRIA: referência de comportamento da porta contratos/cofre.js e apoio de testes com
// arquivos sintéticos. Não é armazenamento de produção — nada sobrevive ao processo.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import { ehUuid } from "../dominio/validacao.js";
import { TAMANHO_MAXIMO_BYTES } from "../contratos/cofre.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const TIPO_MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;

function chaveDoEscopo(escopo) {
  if (!ehUuid(escopo?.organizacaoId) || !ehUuid(escopo?.unidadeId)) falhar(CODIGO.CONTEXTO_INVALIDO, "O cofre exige organização e unidade.");
  return `${escopo.organizacaoId.toLowerCase()}|${escopo.unidadeId.toLowerCase()}`;
}

export function criarCofreMemoria() {
  /** escopo → (arquivoId → { conteudo, hashSha256, tipoMime }) */
  const gavetas = new Map();
  const gaveta = (escopo) => {
    const chave = chaveDoEscopo(escopo);
    return gavetas.get(chave) ?? gavetas.set(chave, new Map()).get(chave);
  };

  return Object.freeze({
    async guardar(escopo, entrada) {
      const g = gaveta(escopo);
      const conteudo = entrada?.conteudo;
      if (!(conteudo instanceof Uint8Array) || conteudo.byteLength === 0 || conteudo.byteLength > TAMANHO_MAXIMO_BYTES) {
        falhar(CODIGO.DOCUMENTO_INVALIDO, "Arquivo vazio, grande demais ou em formato inválido.");
      }
      if (typeof entrada.tipoMime !== "string" || !TIPO_MIME.test(entrada.tipoMime)) falhar(CODIGO.DOCUMENTO_INVALIDO, "Tipo de arquivo inválido.");
      const hashSha256 = sha256(conteudo);
      // Endereçado pelo conteúdo: o identificador não carrega nome de arquivo, pessoa nem assunto.
      const arquivoId = `cofre:${hashSha256}`;
      const repetido = g.has(arquivoId);
      if (!repetido) g.set(arquivoId, { conteudo: Uint8Array.from(conteudo), hashSha256, tipoMime: entrada.tipoMime });
      return { arquivoId, hashSha256, tamanhoBytes: conteudo.byteLength, repetido };
    },

    async ler(escopo, arquivoId) {
      const guardado = gaveta(escopo).get(arquivoId);
      // Arquivo de outro escopo e arquivo inexistente respondem igual: não se revela a existência.
      if (!guardado) falhar(CODIGO.NAO_ENCONTRADO, "Documento não encontrado no cofre.");
      if (sha256(guardado.conteudo) !== guardado.hashSha256) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo guardado não confere com o hash registrado.");
      return { conteudo: Uint8Array.from(guardado.conteudo), hashSha256: guardado.hashSha256, tamanhoBytes: guardado.conteudo.byteLength, tipoMime: guardado.tipoMime };
    },

    async existe(escopo, arquivoId) {
      return gaveta(escopo).has(arquivoId);
    },

    /** 08D — identificadores guardados no escopo (para achar arquivo sem ficha no banco). */
    async inventario(escopo) {
      return [...gaveta(escopo).keys()].sort();
    },

    async limparTemporarios() { return 0; },

    /** SOMENTE PARA TESTES: simula adulteração do arquivo guardado, para provar que a leitura a detecta. */
    __adulterarParaTeste(escopo, arquivoId) {
      const guardado = gaveta(escopo).get(arquivoId);
      if (guardado) guardado.conteudo = Uint8Array.from([...guardado.conteudo, 1]);
    },
  });
}
