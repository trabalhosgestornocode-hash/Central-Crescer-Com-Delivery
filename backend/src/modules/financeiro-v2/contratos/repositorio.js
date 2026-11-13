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
//   paginar(escopo, tipo, consulta)              LISTA paginada resolvida NO BANCO (Execução 06C): filtros, ordem, LIMITE e a
//                                                contagem total são calculados pela persistência — nada é carregado inteiro.
//                                                consulta = { onde, desde: {campo: v}, ate: {campo: v}, em: {campo: [v…]},
//                                                ordem: [{ campo, desc }], limite 1–500, deslocamento ≥ 0 } → { itens, total }.
//                                                `desde`/`ate` são inclusivos. Sem predicado em JavaScript: o total é exato.
//   agregar(escopo, tipo, consulta)              TOTAIS no banco, independentes da página: mesmos filtros +
//                                                { agruparPor?: campo, somar?: campo de centavos } → [{ grupo, quantidade, somaCentavos }]
//
// TODA leitura é filtrada por escopo dentro do repositório.
import { CODIGO, falhar } from "../dominio/erros.js";

export const METODOS_DA_TRANSACAO = Object.freeze(["inserir", "atualizar", "obter", "listar", "buscarPorChave", "travar", "anexarHistorico", "listarHistorico", "paginar", "agregar"]);
export const LIMITE_DA_PAGINA = 500;
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

/**
 * Normaliza a consulta de paginar/agregar. Campos fora do formato são recusados (falha fechada): uma consulta mal formada
 * nunca vira "listar tudo".
 */
export function normalizarConsulta(consulta = {}, { paginada = true } = {}) {
  const permitidos = ["onde", "desde", "ate", "em", "ordem", "limite", "deslocamento", "agruparPor", "somar"];
  const desconhecidos = Object.keys(consulta).filter((k) => !permitidos.includes(k));
  if (desconhecidos.length) falhar(CODIGO.REPOSITORIO_INVALIDO, "Consulta com campos desconhecidos.", { campos: desconhecidos });
  const objeto = (v, nome) => {
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) falhar(CODIGO.REPOSITORIO_INVALIDO, `Consulta: ${nome} deve ser objeto.`);
    return v;
  };
  const em = objeto(consulta.em, "em");
  for (const [campo, lista] of Object.entries(em)) if (!Array.isArray(lista) || !lista.length || lista.length > 200) falhar(CODIGO.REPOSITORIO_INVALIDO, "Consulta: `em` exige lista de 1 a 200 valores.", { campo });
  const ordem = consulta.ordem ?? [];
  if (!Array.isArray(ordem) || ordem.some((o) => typeof o?.campo !== "string")) falhar(CODIGO.REPOSITORIO_INVALIDO, "Consulta: ordem inválida.");
  const n = { onde: objeto(consulta.onde, "onde"), desde: objeto(consulta.desde, "desde"), ate: objeto(consulta.ate, "ate"), em, ordem, agruparPor: consulta.agruparPor ?? null, somar: consulta.somar ?? null };
  if (paginada) {
    n.limite = consulta.limite ?? 50;
    n.deslocamento = consulta.deslocamento ?? 0;
    if (!Number.isSafeInteger(n.limite) || n.limite < 1 || n.limite > LIMITE_DA_PAGINA) falhar(CODIGO.REPOSITORIO_INVALIDO, `Consulta: limite entre 1 e ${LIMITE_DA_PAGINA}.`);
    if (!Number.isSafeInteger(n.deslocamento) || n.deslocamento < 0) falhar(CODIGO.REPOSITORIO_INVALIDO, "Consulta: deslocamento inválido.");
  }
  return n;
}

/** Usado nos testes de conformidade de qualquer adaptador. */
export function conferirTransacao(tx) {
  const faltando = METODOS_DA_TRANSACAO.filter((m) => typeof tx?.[m] !== "function");
  const indevidos = PROIBIDOS.filter((m) => m in (tx ?? {}));
  return { faltando, indevidos, ok: faltando.length === 0 && indevidos.length === 0 };
}
