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
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Temporários (gravações em andamento) com mais desta idade são restos de falha e podem ser limpos. */
export const IDADE_DE_TEMPORARIO_ABANDONADO_MS = 15 * 60 * 1000;

export function criarCofreDisco({ raiz, agora = () => Date.now() }) {
  const pasta = exigirPastaPrivada(raiz);
  mkdirSync(pasta, { recursive: true });
  const marca = join(pasta, MARCA_DO_COFRE);
  if (!existsSync(marca)) writeFileSync(marca, "Cofre local do Financeiro v2. Não versionar. Não sincronizar.\n", { flag: "wx" });
  // 08D: gravação em DUAS FASES. O conteúdo é escrito numa área temporária, conferido pelo hash e só então publicado no
  // endereço definitivo por LIGAÇÃO atômica (link: falha se já existir, nunca sobrescreve). Um arquivo pela metade
  // (queda no meio da escrita) fica só na área temporária e nunca é tomado por válido.
  const temporarios = join(pasta, "temporarios");
  mkdirSync(temporarios, { recursive: true });

  /** Limpeza CONTROLADA: só a área temporária, só arquivos abandonados (nunca evidências publicadas). */
  function limparTemporarios(idadeMinimaMs = IDADE_DE_TEMPORARIO_ABANDONADO_MS) {
    let removidos = 0;
    for (const nome of readdirSync(temporarios)) {
      if (!/^g-[0-9a-f]{32}$/.test(nome)) continue;
      const p = join(temporarios, nome);
      if (agora() - statSync(p).mtimeMs >= idadeMinimaMs) { unlinkSync(p); removidos += 1; }
    }
    return removidos;
  }
  limparTemporarios();

  /** Escreve na área temporária e publica por ligação atômica; devolve false se o destino já existia. */
  function publicar(destino, bytes) {
    const tmp = join(temporarios, `g-${randomBytes(16).toString("hex")}`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    try {
      linkSync(tmp, destino);
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      return false;
    } finally {
      unlinkSync(tmp);
    }
  }

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
      const novo = publicar(arquivo, conteudo);
      // Existente precisa ser íntegro: nunca é sobrescrito. Publicado agora: confere o que ficou no disco.
      lerConferido(arquivo, hashSha256);
      if (!existsSync(`${arquivo}.json`)) publicar(`${arquivo}.json`, JSON.stringify({ tipoMime: entrada.tipoMime, tamanhoBytes: conteudo.byteLength }));
      return { arquivoId: `cofre:${hashSha256}`, hashSha256, tamanhoBytes: conteudo.byteLength, repetido: !novo };
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

    /** 08D — identificadores guardados no escopo (para achar arquivo sem ficha no banco). Nunca devolve caminho. */
    async inventario(escopo) {
      const g = gavetaDe(pasta, escopo);
      if (!existsSync(g)) return [];
      const ids = [];
      for (const sub of readdirSync(g)) for (const nome of readdirSync(join(g, sub))) if (/^[0-9a-f]{64}$/.test(nome)) ids.push(`cofre:${nome}`);
      return ids.sort();
    },

    /** 08D — limpeza controlada da área temporária (restos de gravação interrompida). */
    async limparTemporarios(idadeMinimaMs) { return limparTemporarios(idadeMinimaMs); },
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
