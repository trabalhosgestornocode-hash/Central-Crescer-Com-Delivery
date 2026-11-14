// PORTA do COFRE DE DOCUMENTOS (extratos, relatórios de processador, notas, comprovantes).
//
// O núcleo guarda só a FICHA do documento (aplicacao/documentos.js): onde está, hash, tipo, versão, vínculos.
// O ARQUIVO fica num cofre privado, fora do Git e fora do banco financeiro. Este contrato define o que qualquer cofre
// (disco privado, bucket privado...) precisa cumprir. Nesta execução existe apenas o adaptador em memória, para testes
// com arquivos SINTÉTICOS; nenhum serviço de armazenamento foi integrado.
//
// Requisitos que todo adaptador deve atender (detalhados em docs/financeiro-v2/04-persistencia-e-seguranca.md):
//   - controle de acesso: toda operação recebe o escopo (organização + unidade) de um contexto já autorizado;
//   - isolamento: o arquivo de um escopo é invisível para outro (pedir arquivo alheio = "não existe");
//   - integridade: o cofre calcula o SHA-256 do conteúdo ao guardar e CONFERE ao ler; conteúdo adulterado é recusado;
//   - imutabilidade: guardar não sobrescreve; o mesmo conteúdo no mesmo escopo devolve o mesmo identificador;
//   - sem exclusão e sem URL pública: o contrato não tem como apagar, nem como gerar link — a leitura devolve bytes
//     a quem já passou pela autorização; link temporário, se um dia existir, será decisão explícita e auditada;
//   - o identificador do arquivo não revela nome original, pessoa nem conteúdo.
//
// cofre.guardar(escopo, { conteudo: Uint8Array, tipoMime: string })
//        → { arquivoId, hashSha256, tamanhoBytes, repetido }
// cofre.ler(escopo, arquivoId)      → { conteudo: Uint8Array, hashSha256, tamanhoBytes, tipoMime }  (falha se não existir no escopo ou se o hash não conferir)
// cofre.existe(escopo, arquivoId)   → boolean
import { CODIGO, falhar } from "../dominio/erros.js";

export const METODOS_DO_COFRE = Object.freeze(["guardar", "ler", "existe"]);
const PROIBIDOS = Object.freeze(["remover", "excluir", "apagar", "deletar", "delete", "remove", "urlPublica", "gerarUrl", "publicar", "link"]);
export const TAMANHO_MAXIMO_BYTES = 26214400; // 25 MiB por documento

export function exigirCofre(cofre) {
  if (METODOS_DO_COFRE.some((m) => typeof cofre?.[m] !== "function")) falhar(CODIGO.DOCUMENTO_INVALIDO, "O cofre de documentos deve oferecer guardar, ler e existe.");
  return cofre;
}

/** Usado nos testes de conformidade de qualquer adaptador de cofre. */
export function conferirCofre(cofre) {
  const faltando = METODOS_DO_COFRE.filter((m) => typeof cofre?.[m] !== "function");
  const indevidos = PROIBIDOS.filter((m) => m in (cofre ?? {}));
  return { faltando, indevidos, ok: faltando.length === 0 && indevidos.length === 0 };
}
