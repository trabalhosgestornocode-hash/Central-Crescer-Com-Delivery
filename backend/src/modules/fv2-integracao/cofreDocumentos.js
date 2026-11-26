// COFRE DE DOCUMENTOS DO FINANCEIRO (comprovantes, cupons, notas, boletos) — bucket PRIVADO do Supabase atrás da porta
// financeiro-v2/contratos/cofre.js, com QUARENTENA e VERIFICAÇÃO ANTIMALWARE. Reaproveita a mesma ideia do cofre das notas de
// entregadores (endereçamento pelo SHA-256, por organização/unidade, sem link e sem sobrescrever), acrescentando:
//
//   1. validação de formato e tamanho ANTES de qualquer gravação (assinatura real do arquivo: PDF/PNG/JPEG/WEBP; PDF com conteúdo
//      ativo é recusado; o tipo declarado não manda — vale o que o arquivo é);
//   2. todo arquivo entra em  quarentena/{org}/{unidade}/{hash}  e SÓ é disponibilizado (liberados/…) depois que o antimalware
//      o declara limpo; infectado vai para infectados/… e nunca é lido; verificador fora do ar ⇒ continua em quarentena;
//   3. `ler` só devolve bytes de arquivo LIBERADO (a visualização autorizada pelo Dashboard passa por aqui);
//      `existe` é verdadeiro também para o que está em quarentena — a ficha e o vínculo com a conta podem existir, o arquivo
//      não é aberto até a liberação;
//   4. `verificarQuarentena(escopos)` revarre a quarentena (rotina/script) e libera o que passar.
//
// A porta pública do cofre NÃO ganha exclusão nem URL: mover quarentena → liberados é interno ao adaptador.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../financeiro-v2/dominio/erros.js";
import { ehUuid } from "../financeiro-v2/dominio/validacao.js";

export const LIMITE_BYTES = 10 * 1024 * 1024; // igual ao limite do bucket privado das notas
export const ESTADO_ARQUIVO = Object.freeze({ LIBERADO: "LIBERADO", QUARENTENA: "QUARENTENA", INFECTADO: "INFECTADO", AUSENTE: "AUSENTE" });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Assinaturas aceitas (o conteúdo manda, não o tipo informado). */
function tipoReal(c) {
  const b = Buffer.from(c.subarray(0, 16));
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const PDF_ATIVO = /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToR|GoToE|XFA)\b/;

/** Valida formato e tamanho. Devolve o tipo real; recusa com código claro. */
export function validarDocumento(conteudo) {
  if (!(conteudo instanceof Uint8Array) || conteudo.byteLength === 0) falhar(CODIGO.DOCUMENTO_INVALIDO, "Documento vazio.");
  if (conteudo.byteLength > LIMITE_BYTES) falhar(CODIGO.DOCUMENTO_INVALIDO, "Documento acima do limite de 10 MiB.");
  const tipo = tipoReal(conteudo);
  if (!tipo) falhar(CODIGO.DOCUMENTO_INVALIDO, "Formato não aceito (somente PDF, PNG, JPEG ou WEBP).");
  if (tipo === "application/pdf" && PDF_ATIVO.test(Buffer.from(conteudo).toString("latin1"))) falhar(CODIGO.DOCUMENTO_INVALIDO, "PDF com conteúdo ativo não é aceito.");
  return tipo;
}

const pasta = (e) => {
  if (!ehUuid(e?.organizacaoId) || !ehUuid(e?.unidadeId)) falhar(CODIGO.CONTEXTO_INVALIDO, "O cofre exige organização e unidade.");
  return `${e.organizacaoId.toLowerCase()}/${e.unidadeId.toLowerCase()}`;
};
const hashDe = (arquivoId) => {
  const m = /^cofre:([0-9a-f]{64})$/.exec(String(arquivoId));
  if (!m) falhar(CODIGO.NAO_ENCONTRADO, "Arquivo não encontrado.");
  return m[1];
};
const ZONAS = Object.freeze({ LIBERADO: "liberados", QUARENTENA: "quarentena", INFECTADO: "infectados" });

/**
 * @param {{supabase:{storage:object}, bucket:string, scanner:{verificar:(c:Uint8Array)=>Promise<{estado:"LIMPO"|"INFECTADO"|"INDISPONIVEL", assinatura?:string}>},
 *          registrar?:(e:object)=>void}} p
 */
export function criarCofreDocumentosSupabase({ supabase, bucket, scanner, registrar = () => {} }) {
  if (!scanner || typeof scanner.verificar !== "function") throw new TypeError("O cofre de documentos exige um verificador antimalware (mesmo que indisponível).");
  let conferido = null;
  const armazenamento = () => supabase.storage.from(bucket);
  const exigirPrivado = () => (conferido ??= (async () => {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (error || !data || data.public !== false) { conferido = null; falhar(CODIGO.COFRE_INDISPONIVEL, "O cofre de documentos não está disponível como armazenamento privado."); }
  })());
  const caminho = (zona, e, hash) => `${ZONAS[zona]}/${pasta(e)}/${hash}`;

  async function noCaminho(zona, e, hash) {
    const dir = `${ZONAS[zona]}/${pasta(e)}`;
    const { data, error } = await armazenamento().list(dir, { search: hash, limit: 1 });
    if (error) falhar(CODIGO.COFRE_INDISPONIVEL, "O cofre de documentos não respondeu.");
    return (data ?? []).some((x) => x.name === hash);
  }
  async function estado(e, arquivoId) {
    await exigirPrivado();
    const hash = hashDe(arquivoId);
    for (const z of ["LIBERADO", "QUARENTENA", "INFECTADO"]) if (await noCaminho(z, e, hash)) return z;
    return ESTADO_ARQUIVO.AUSENTE;
  }
  async function baixar(zona, e, hash) {
    const { data, error } = await armazenamento().download(caminho(zona, e, hash));
    if (error || !data) falhar(CODIGO.COFRE_INDISPONIVEL, "Não foi possível ler o arquivo do cofre.");
    return new Uint8Array(await data.arrayBuffer());
  }
  /** quarentena → liberados (interno): grava no destino, confere o hash e só então tira da quarentena. */
  async function mover(origem, destino, e, hash, conteudo) {
    const { error } = await armazenamento().upload(caminho(destino, e, hash), conteudo, { upsert: false });
    if (error && !/exists|duplicate/i.test(error.message ?? "")) falhar(CODIGO.COFRE_INDISPONIVEL, "Não foi possível mover o arquivo no cofre.");
    const { error: er } = await armazenamento().remove([caminho(origem, e, hash)]);
    if (er) registrar({ tipo: "COFRE_QUARENTENA_NAO_LIMPA", destino });
  }
  /** Verifica um arquivo em quarentena: libera, marca infectado ou deixa onde está. */
  async function verificar(e, arquivoId, conteudoConhecido = null) {
    const hash = hashDe(arquivoId);
    const conteudo = conteudoConhecido ?? (await baixar("QUARENTENA", e, hash));
    if (sha256(conteudo) !== hash) falhar(CODIGO.DOCUMENTO_ADULTERADO, "O arquivo em quarentena não confere com o hash.");
    let r;
    try { r = await scanner.verificar(conteudo); } catch { r = { estado: "INDISPONIVEL" }; }
    if (r.estado === "LIMPO") { await mover("QUARENTENA", "LIBERADO", e, hash, conteudo); registrar({ tipo: "COFRE_DOCUMENTO_LIBERADO" }); return ESTADO_ARQUIVO.LIBERADO; }
    if (r.estado === "INFECTADO") { await mover("QUARENTENA", "INFECTADO", e, hash, conteudo); registrar({ tipo: "COFRE_DOCUMENTO_INFECTADO" }); return ESTADO_ARQUIVO.INFECTADO; }
    registrar({ tipo: "COFRE_VERIFICADOR_INDISPONIVEL" });
    return ESTADO_ARQUIVO.QUARENTENA;
  }

  return Object.freeze({
    estado,
    verificar,
    async existe(e, arquivoId) { const s = await estado(e, arquivoId); return s === ESTADO_ARQUIVO.LIBERADO || s === ESTADO_ARQUIVO.QUARENTENA; },
    /** Grava em quarentena e tenta liberar. Infectado = recusa (nada é gravado como disponível e nada financeiro segue). */
    async guardar(e, { conteudo }) {
      await exigirPrivado();
      const tipoMime = validarDocumento(conteudo);
      const hashSha256 = sha256(conteudo);
      const arquivoId = `cofre:${hashSha256}`;
      const atual = await estado(e, arquivoId);
      if (atual === ESTADO_ARQUIVO.INFECTADO) falhar(CODIGO.DOCUMENTO_INVALIDO, "Este arquivo foi identificado como malicioso e foi recusado.");
      if (atual === ESTADO_ARQUIVO.LIBERADO) return { arquivoId, hashSha256, tamanhoBytes: conteudo.byteLength, repetido: true, estado: atual, tipoMime };
      if (atual === ESTADO_ARQUIVO.AUSENTE) {
        const { error } = await armazenamento().upload(caminho("QUARENTENA", e, hashSha256), conteudo, { contentType: tipoMime, upsert: false });
        if (error && !/exists|duplicate/i.test(error.message ?? "")) falhar(CODIGO.COFRE_INDISPONIVEL, "Não foi possível guardar o arquivo no cofre de documentos.");
      }
      const final = await verificar(e, arquivoId, conteudo);
      if (final === ESTADO_ARQUIVO.INFECTADO) falhar(CODIGO.DOCUMENTO_INVALIDO, "Este arquivo foi identificado como malicioso e foi recusado.");
      return { arquivoId, hashSha256, tamanhoBytes: conteudo.byteLength, repetido: atual !== ESTADO_ARQUIVO.AUSENTE, estado: final, tipoMime };
    },
    /** Confere (sem devolver bytes) o que está em quarentena: o hash gravado tem de ser o do arquivo. */
    async conferirEmQuarentena(e, arquivoId) {
      await exigirPrivado();
      const hash = hashDe(arquivoId);
      const conteudo = await baixar("QUARENTENA", e, hash);
      return { hashSha256: sha256(conteudo), tamanhoBytes: conteudo.byteLength };
    },
    /** Só arquivo LIBERADO é lido (a visualização no Dashboard passa por aqui). Em quarentena: "em verificação". */
    async ler(e, arquivoId) {
      const s = await estado(e, arquivoId);
      if (s === ESTADO_ARQUIVO.QUARENTENA) falhar(CODIGO.DOCUMENTO_INDISPONIVEL, "O documento está em verificação de segurança e ainda não pode ser aberto.");
      if (s !== ESTADO_ARQUIVO.LIBERADO) falhar(CODIGO.NAO_ENCONTRADO, "Arquivo não encontrado no cofre de documentos.");
      const hash = hashDe(arquivoId);
      const conteudo = await baixar("LIBERADO", e, hash);
      const hashSha256 = sha256(conteudo);
      if (hashSha256 !== hash) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo guardado não confere com o hash registrado.");
      return { conteudo, hashSha256, tamanhoBytes: conteudo.byteLength, tipoMime: tipoReal(conteudo) ?? "application/octet-stream" };
    },
    /** Revarre a quarentena das unidades informadas (rotina/script). Devolve contagens; nunca lança por causa de um arquivo. */
    async verificarQuarentena(escopos) {
      await exigirPrivado();
      const total = { liberados: 0, infectados: 0, pendentes: 0 };
      for (const e of escopos) {
        const { data } = await armazenamento().list(`${ZONAS.QUARENTENA}/${pasta(e)}`, { limit: 200 });
        for (const x of data ?? []) {
          if (!/^[0-9a-f]{64}$/.test(x.name)) continue;
          try {
            const r = await verificar(e, `cofre:${x.name}`);
            if (r === ESTADO_ARQUIVO.LIBERADO) total.liberados += 1; else if (r === ESTADO_ARQUIVO.INFECTADO) total.infectados += 1; else total.pendentes += 1;
          } catch { total.pendentes += 1; }
        }
      }
      return total;
    },
  });
}
