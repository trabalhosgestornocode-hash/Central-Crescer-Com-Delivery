// COFRE DE DOCUMENTOS EM DISCO LOCAL — desenvolvimento e testes. Cumpre a porta contratos/cofre.js.
//
// Garantias:
//   - a pasta raiz precisa ser ABSOLUTA, ficar FORA de qualquer repositório Git e fora de pastas sincronizadas com a
//     nuvem (OneDrive, Dropbox, Google Drive, iCloud) — senão o cofre nem é criado;
//   - um escopo (organização + unidade) é uma gaveta própria; o nome da gaveta é um hash (não revela ids);
//   - endereçado pelo conteúdo (SHA-256): o mesmo arquivo devolve o mesmo id; NUNCA sobrescreve (gravação exclusiva);
//     um arquivo corrompido existente não é trocado em silêncio — a operação falha;
//   - leitura confere o hash; não existe exclusão nem URL pública;
//   - o registro de acessos negados guarda só metadados (quem, quando, qual documento, por quê) — nunca conteúdo.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CODIGO, falhar } from "../dominio/erros.js";
import { ehUuid } from "../dominio/validacao.js";
import { TAMANHO_MAXIMO_BYTES } from "../contratos/cofre.js";

const sha256 = (dados) => createHash("sha256").update(dados).digest("hex");
const TIPO_MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;
const ID = /^cofre:([0-9a-f]{64})$/;
const SINCRONIZADAS = /onedrive|dropbox|google ?drive|icloud/i;
export const MARCA_DO_COFRE = "FV2_COFRE_LOCAL";

/** Recusa raiz relativa, sincronizada com a nuvem ou dentro de repositório Git. */
export function exigirPastaPrivada(raiz) {
  if (typeof raiz !== "string" || !isAbsolute(raiz)) falhar(CODIGO.COFRE_INDISPONIVEL, "A pasta do cofre precisa ser um caminho absoluto.");
  const pasta = resolve(raiz);
  if (SINCRONIZADAS.test(pasta)) falhar(CODIGO.COFRE_INDISPONIVEL, "A pasta do cofre não pode ficar em pasta sincronizada com serviço de nuvem.");
  for (let d = pasta; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) falhar(CODIGO.COFRE_INDISPONIVEL, "A pasta do cofre não pode ficar dentro de um repositório Git.");
    if (dirname(d) === d) break;
  }
  return pasta;
}

function gavetaDe(raiz, escopo) {
  if (!ehUuid(escopo?.organizacaoId) || !ehUuid(escopo?.unidadeId)) falhar(CODIGO.CONTEXTO_INVALIDO, "O cofre exige organização e unidade.");
  return join(raiz, "escopos", sha256(`${escopo.organizacaoId.toLowerCase()}|${escopo.unidadeId.toLowerCase()}`).slice(0, 32));
}

export function criarCofreDisco({ raiz }) {
  const pasta = exigirPastaPrivada(raiz);
  mkdirSync(pasta, { recursive: true });
  const marca = join(pasta, MARCA_DO_COFRE);
  if (!existsSync(marca)) writeFileSync(marca, "Cofre local do Financeiro v2. Não versionar. Não sincronizar.\n", { flag: "wx" });

  const caminho = (escopo, hash) => {
    const p = join(gavetaDe(pasta, escopo), hash.slice(0, 2), hash);
    if (!p.startsWith(pasta + sep)) falhar(CODIGO.DOCUMENTO_INVALIDO, "Identificador de arquivo inválido.");
    return p;
  };

  function lerConferido(arquivo, hash) {
    const conteudo = readFileSync(arquivo);
    if (sha256(conteudo) !== hash) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo guardado não confere com o hash registrado.");
    return new Uint8Array(conteudo);
  }

  return Object.freeze({
    async guardar(escopo, entrada) {
      const conteudo = entrada?.conteudo;
      if (!(conteudo instanceof Uint8Array) || conteudo.byteLength === 0 || conteudo.byteLength > TAMANHO_MAXIMO_BYTES) {
        falhar(CODIGO.DOCUMENTO_INVALIDO, "Arquivo vazio, grande demais ou em formato inválido.");
      }
      if (typeof entrada.tipoMime !== "string" || !TIPO_MIME.test(entrada.tipoMime)) falhar(CODIGO.DOCUMENTO_INVALIDO, "Tipo de arquivo inválido.");
      const hashSha256 = sha256(conteudo);
      const arquivo = caminho(escopo, hashSha256);
      mkdirSync(dirname(arquivo), { recursive: true });
      let repetido = false;
      try {
        writeFileSync(arquivo, conteudo, { flag: "wx" });
        writeFileSync(`${arquivo}.json`, JSON.stringify({ tipoMime: entrada.tipoMime, tamanhoBytes: conteudo.byteLength }), { flag: "wx" });
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        lerConferido(arquivo, hashSha256); // existente precisa ser íntegro: nunca é sobrescrito
        repetido = true;
      }
      return { arquivoId: `cofre:${hashSha256}`, hashSha256, tamanhoBytes: conteudo.byteLength, repetido };
    },

    async ler(escopo, arquivoId) {
      const m = typeof arquivoId === "string" ? ID.exec(arquivoId) : null;
      if (!m) falhar(CODIGO.NAO_ENCONTRADO, "Documento não encontrado no cofre.");
      const arquivo = caminho(escopo, m[1]);
      if (!existsSync(arquivo)) falhar(CODIGO.NAO_ENCONTRADO, "Documento não encontrado no cofre.");
      const conteudo = lerConferido(arquivo, m[1]);
      let tipoMime = "application/octet-stream";
      try {
        tipoMime = JSON.parse(readFileSync(`${arquivo}.json`, "utf8")).tipoMime ?? tipoMime;
      } catch {
        // metadado ausente não impede a leitura do original íntegro
      }
      return { conteudo, hashSha256: m[1], tamanhoBytes: conteudo.byteLength, tipoMime };
    },

    async existe(escopo, arquivoId) {
      const m = typeof arquivoId === "string" ? ID.exec(arquivoId) : null;
      return !!m && existsSync(caminho(escopo, m[1]));
    },
  });
}

const CAMPOS_DO_ACESSO = Object.freeze(["em", "evento", "codigo", "documentoId", "usuarioId", "organizacaoId", "unidadeId"]);
const soMetadados = (evento) => Object.fromEntries(CAMPOS_DO_ACESSO.map((k) => [k, typeof evento?.[k] === "string" ? evento[k].slice(0, 120) : null]));

/** Tentativas de acesso negadas, em arquivo JSONL na pasta privada do cofre (só metadados). */
export function criarRegistroDeAcessosNegadosEmDisco({ raiz }) {
  const pasta = join(exigirPastaPrivada(raiz), "auditoria");
  mkdirSync(pasta, { recursive: true });
  const arquivo = join(pasta, "acessos-negados.jsonl");
  return Object.freeze({
    async registrar(evento) {
      appendFileSync(arquivo, `${JSON.stringify(soMetadados(evento))}\n`);
    },
    async listar() {
      if (!existsSync(arquivo)) return [];
      return readFileSync(arquivo, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  });
}

/** Mesmo registro, em memória (testes). */
export function criarRegistroDeAcessosNegadosMemoria() {
  const eventos = [];
  return Object.freeze({
    async registrar(evento) { eventos.push(soMetadados(evento)); },
    async listar() { return eventos.map((e) => ({ ...e })); },
  });
}
