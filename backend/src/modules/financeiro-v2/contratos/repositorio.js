// PORTA de persistência do Financeiro v2. O domínio depende só deste contrato; a implementação definitiva (PostgreSQL)
// será um adaptador que o cumpre. O contrato NÃO tem operação de exclusão: registro financeiro não se apaga.
//
// repositorio.transacao(fn)  → executa fn(tx) de forma ATÔMICA: ou tudo é gravado, ou nada. Devolve o retorno de fn.
// repositorio.leitura(fn)    → executa fn(tx) sobre um retrato consistente; nenhuma escrita é mantida.
//
// tx (todas podem ser assíncronas; o núcleo sempre usa await):
//   inserir(tipo, registro)                      registro com id, organizacaoId, unidadeId; falha se o id existir ou se a
//                                                chaveIdempotencia já existir para o mesmo escopo+tipo
//   atualizar(tipo, registro, versaoEsperada)    falha se a versão gravada for outra (concorrência otimista) ou se o
//                                                registro não pertencer ao mesmo escopo
//   obter(escopo, tipo, id)                      null quando não existe OU pertence a outro escopo (não revela existência)
//   listar(escopo, tipo, predicado?)             somente registros do escopo
//   buscarPorChave(escopo, tipo, chave)          busca pela chaveIdempotencia dentro do escopo
//   anexarHistorico(evento)                      somente acréscimo
//   listarHistorico(escopo, predicado?)
//
// escopo = { organizacaoId, unidadeId }. TODA leitura é filtrada por escopo dentro do repositório.
import { CODIGO, falhar } from "../dominio/erros.js";

export const METODOS_DA_TRANSACAO = Object.freeze(["inserir", "atualizar", "obter", "listar", "buscarPorChave", "anexarHistorico", "listarHistorico"]);
const PROIBIDOS = Object.freeze(["remover", "excluir", "apagar", "deletar", "delete", "remove"]);

export function exigirRepositorio(repositorio) {
  if (!repositorio || typeof repositorio.transacao !== "function" || typeof repositorio.leitura !== "function") {
    falhar(CODIGO.REPOSITORIO_INVALIDO, "O repositório deve oferecer transacao(fn) e leitura(fn).");
  }
  return repositorio;
}

/** Usado nos testes de conformidade de qualquer adaptador. */
export function conferirTransacao(tx) {
  const faltando = METODOS_DA_TRANSACAO.filter((m) => typeof tx?.[m] !== "function");
  const indevidos = PROIBIDOS.filter((m) => m in (tx ?? {}));
  return { faltando, indevidos, ok: faltando.length === 0 && indevidos.length === 0 };
}
