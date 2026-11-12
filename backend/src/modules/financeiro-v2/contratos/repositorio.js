// PORTA de persistência do Financeiro v2. O domínio depende só deste contrato; há dois adaptadores que o cumprem:
// memória (infra/repositorioMemoria.js) e PostgreSQL (infra/postgres/repositorioPostgres.js).
// O contrato NÃO tem operação de exclusão: registro financeiro não se apaga.
//
// repositorio.transacao(fn, { escopo })  → executa fn(tx) de forma ATÔMICA: ou tudo é gravado, ou nada. Devolve o retorno de fn.
//                                          O adaptador pode REEXECUTAR fn inteira quando perde uma disputa de concorrência
//                                          (por isso fn não pode ter efeito fora do tx).
// repositorio.leitura(fn, { escopo })    → executa fn(tx) sobre um retrato consistente; nenhuma escrita é mantida.
//
// `escopo` = { organizacaoId, unidadeId } da operação. O adaptador o usa para isolar a transação também no banco.
//
// tx (todas podem ser assíncronas; o núcleo sempre usa await):
//   inserir(tipo, registro)                      registro com id, organizacaoId, unidadeId; falha se o id existir ou se a
//                                                chaveIdempotencia já existir para o mesmo escopo+tipo
//   atualizar(tipo, registro, versaoEsperada)    falha se a versão gravada for outra (concorrência otimista) ou se o
//                                                registro não pertencer ao mesmo escopo
//   obter(escopo, tipo, id)                      null quando não existe OU pertence a outro escopo (não revela existência);
//                                                dentro de transacao() o registro fica reservado até o fim da transação
//   listar(escopo, tipo, filtro?)                somente registros do escopo. filtro = função predicado OU
//                                                { onde: { campo: valor, ... }, predicado } — `onde` é igualdade simples,
//                                                que o adaptador pode resolver no banco
//   buscarPorChave(escopo, tipo, chave)          busca pela chaveIdempotencia dentro do escopo
//   travar(escopo, recurso, modo)                trava nomeada até o fim da transação; modo "COMPARTILHADA" | "EXCLUSIVA"
//   anexarHistorico(evento)                      somente acréscimo
//   listarHistorico(escopo, filtro?)             filtro como em listar; devolve na ordem em que os eventos foram gravados
//
// TODA leitura é filtrada por escopo dentro do repositório.
import { CODIGO, falhar } from "../dominio/erros.js";

export const METODOS_DA_TRANSACAO = Object.freeze(["inserir", "atualizar", "obter", "listar", "buscarPorChave", "travar", "anexarHistorico", "listarHistorico"]);
const PROIBIDOS = Object.freeze(["remover", "excluir", "apagar", "deletar", "delete", "remove"]);

export function exigirRepositorio(repositorio) {
  if (!repositorio || typeof repositorio.transacao !== "function" || typeof repositorio.leitura !== "function") {
    falhar(CODIGO.REPOSITORIO_INVALIDO, "O repositório deve oferecer transacao(fn) e leitura(fn).");
  }
  return repositorio;
}

/** Normaliza o filtro de listar/listarHistorico em { onde, predicado }. */
export function normalizarFiltro(filtro) {
  if (filtro === undefined || filtro === null) return { onde: {}, predicado: () => true };
  if (typeof filtro === "function") return { onde: {}, predicado: filtro };
  return { onde: filtro.onde ?? {}, predicado: filtro.predicado ?? (() => true) };
}

/** Usado nos testes de conformidade de qualquer adaptador. */
export function conferirTransacao(tx) {
  const faltando = METODOS_DA_TRANSACAO.filter((m) => typeof tx?.[m] !== "function");
  const indevidos = PROIBIDOS.filter((m) => m in (tx ?? {}));
  return { faltando, indevidos, ok: faltando.length === 0 && indevidos.length === 0 };
}
