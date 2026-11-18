// COFRE DURÁVEL das notas de entregadores: bucket PRIVADO do Supabase já usado pela plataforma, atrás da porta contratos/cofre.js.
// Recusa funcionar se o bucket estiver público. Não gera link, não apaga e não sobrescreve. Arquivo endereçado pelo SHA-256, por unidade.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../financeiro-v2/dominio/erros.js";
import { ehUuid } from "../financeiro-v2/dominio/validacao.js";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const pasta = (e) => {
  if (!ehUuid(e?.organizacaoId) || !ehUuid(e?.unidadeId)) falhar(CODIGO.CONTEXTO_INVALIDO, "O cofre exige organização e unidade.");
  return `${e.organizacaoId.toLowerCase()}/${e.unidadeId.toLowerCase()}`;
};
const caminho = (e, arquivoId) => {
  const m = /^cofre:([0-9a-f]{64})$/.exec(String(arquivoId));
  if (!m) falhar(CODIGO.NAO_ENCONTRADO, "Arquivo não encontrado.");
  return `${pasta(e)}/${m[1]}`;
};

/** @param {{supabase:{storage:object}, bucket:string}} p */
export function criarCofreNotasSupabase({ supabase, bucket }) {
  let conferido = null;
  const armazenamento = () => supabase.storage.from(bucket);
  const exigirPrivado = () => (conferido ??= (async () => {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (error || !data || data.public !== false) { conferido = null; falhar(CODIGO.COFRE_INDISPONIVEL, "O cofre de notas não está disponível como armazenamento privado."); }
  })());
  async function existe(e, arquivoId) {
    await exigirPrivado();
    const c = caminho(e, arquivoId);
    const nome = c.split("/").pop();
    const { data, error } = await armazenamento().list(pasta(e), { search: nome, limit: 1 });
    if (error) falhar(CODIGO.COFRE_INDISPONIVEL, "O cofre de notas não respondeu.");
    return (data ?? []).some((x) => x.name === nome);
  }
  return Object.freeze({
    existe,
    async guardar(e, { conteudo, tipoMime }) {
      await exigirPrivado();
      const hashSha256 = sha256(conteudo);
      const arquivoId = `cofre:${hashSha256}`;
      const repetido = await existe(e, arquivoId);
      if (!repetido) {
        const { error } = await armazenamento().upload(caminho(e, arquivoId), conteudo, { contentType: tipoMime, upsert: false });
        if (error && !/exists|duplicate/i.test(error.message ?? "")) falhar(CODIGO.COFRE_INDISPONIVEL, "Não foi possível guardar o arquivo no cofre de notas.");
      }
      return { arquivoId, hashSha256, tamanhoBytes: conteudo.byteLength, repetido };
    },
    async ler(e, arquivoId) {
      await exigirPrivado();
      const { data, error } = await armazenamento().download(caminho(e, arquivoId));
      if (error || !data) falhar(CODIGO.NAO_ENCONTRADO, "Arquivo não encontrado no cofre de notas.");
      const conteudo = new Uint8Array(await data.arrayBuffer());
      const hashSha256 = sha256(conteudo);
      if (`cofre:${hashSha256}` !== arquivoId) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo guardado não confere com o hash registrado.");
      return { conteudo, hashSha256, tamanhoBytes: conteudo.byteLength, tipoMime: data.type || "application/octet-stream" };
    },
  });
}
