// Adaptador POSTGRESQL da porta de persistência (contratos/repositorio.js).
//
// - Não importa driver: recebe um `pool` compatível com node-postgres ({ connect() → { query(texto, valores), release() } }).
//   Quem monta decide a conexão — e é obrigado a passar pela guarda de destino (destinoSeguro.js) antes.
// - Nenhuma fórmula financeira aqui: o adaptador grava o que o núcleo calculou; o banco confere (restrições e gatilhos).
// - Cada transação declara um TOKEN de sessão de banco emitido pela autoridade (07B). Organização, unidade e usuário vêm
//   do registro dessa sessão no banco — a aplicação não escolhe escopo por variável. O RLS isola organização + unidade.
// - Concorrência: `obter` dentro de transação reserva a linha (FOR UPDATE); toda alteração confere a versão; disputas
//   perdidas (linha alterada por outro, chave única já gravada, deadlock) fazem a operação inteira ser REEXECUTADA sobre
//   o estado novo — daí sai o resultado correto: registro repetido devolvido, saldo insuficiente recusado, etc.
// - Não existe método de exclusão, e o papel de banco da aplicação nem tem esse privilégio.
import { CODIGO, ErroFinanceiro, falhar } from "../../dominio/erros.js";
import { congelar } from "../../dominio/validacao.js";
import { normalizarConsulta, normalizarFiltro } from "../../contratos/repositorio.js";
import { ESQUEMA, HISTORICO } from "./esquema.js";

const INSTANTE = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Expressão SELECT de uma coluna, já no formato que o núcleo usa. */
function leituraDe(campo, { coluna, tipo }) {
  if (tipo === "centavos") return `${coluna}::text as "${campo}"`;
  if (tipo === "data") return `to_char(${coluna}, 'YYYY-MM-DD') as "${campo}"`;
  if (tipo === "instante") return `to_char(${coluna} at time zone 'UTC', ${INSTANTE}) as "${campo}"`;
  if (tipo === "uuids") return `${coluna}::text[] as "${campo}"`;
  if (tipo === "fonte") {
    return `case when ${coluna}_sistema is null then null else jsonb_build_object('sistema', ${coluna}_sistema, 'idExterno', ${coluna}_id_externo) end as "${campo}"`;
  }
  return `${coluna} as "${campo}"`;
}

const CONVERSAO = { centavos: "::bigint", data: "::date", instante: "::timestamptz", uuids: "::uuid[]", json: "::jsonb", uuid: "::uuid", inteiro: "::integer", bool: "::boolean", texto: "::text" };

function centavosParaBanco(v, campo) {
  if (!Number.isSafeInteger(v)) falhar(CODIGO.VALOR_INVALIDO, "Valor monetário deve ser um inteiro de centavos.", { campo });
  return String(v);
}

function centavosDoBanco(texto, campo) {
  const n = Number(texto);
  if (!/^-?\d+$/.test(texto) || !Number.isSafeInteger(n)) falhar(CODIGO.VALOR_INVALIDO, "Valor monetário gravado fora da faixa segura.", { campo });
  return n;
}

/** Pares coluna/valor de gravação para um registro. Campos fora do mapa vão para `extras`. */
const IMUTAVEIS = Object.freeze(["id", "organizacaoId", "unidadeId", "criadoEm", "criadoPor"]);

function gravacaoDe(def, registro, { comExtras, semImutaveis = false }) {
  const colunas = [];
  const marcas = [];
  const valores = [];
  const por = (coluna, valor, conversao) => {
    valores.push(valor);
    colunas.push(coluna);
    marcas.push(`$${valores.length}${conversao}`);
  };
  for (const [campo, { coluna, tipo }] of Object.entries(def.campos)) {
    if (semImutaveis && IMUTAVEIS.includes(campo)) continue;
    const v = registro[campo] ?? null;
    if (tipo === "fonte") {
      por(`${coluna}_sistema`, v?.sistema ?? null, "::text");
      por(`${coluna}_id_externo`, v?.idExterno ?? null, "::text");
    } else if (v === null) por(coluna, null, CONVERSAO[tipo]);
    else if (tipo === "centavos") por(coluna, centavosParaBanco(v, campo), CONVERSAO[tipo]);
    else if (tipo === "json") por(coluna, JSON.stringify(v), CONVERSAO[tipo]);
    else por(coluna, v, CONVERSAO[tipo]);
  }
  if (comExtras) {
    const extras = Object.fromEntries(Object.entries(registro).filter(([k, v]) => !(k in def.campos) && v !== undefined));
    por("extras", JSON.stringify(extras), "::jsonb");
  }
  return { colunas, marcas, valores };
}

function registroDe(def, linha, { comExtras }) {
  const { extras, ...campos } = linha;
  const registro = comExtras ? { ...(extras ?? {}) } : {};
  for (const [campo, { tipo }] of Object.entries(def.campos)) {
    const v = campos[campo];
    registro[campo] = v === null || v === undefined ? null : tipo === "centavos" ? centavosDoBanco(v, campo) : v;
  }
  return congelar(registro);
}

const selecao = (def, comExtras) => [...Object.entries(def.campos).map(([campo, col]) => leituraDe(campo, col)), ...(comExtras ? ["extras"] : [])].join(", ");

/** Condições SQL de escopo + igualdades simples (`onde`). Campo fora do mapa é procurado em `extras`. */
function condicoes(def, escopo, onde, comExtras) {
  const valores = [escopo.organizacaoId, escopo.unidadeId];
  const partes = ["organizacao_id = $1::uuid", "unidade_id = $2::uuid"];
  for (const [campo, valor] of Object.entries(onde)) {
    const col = def.campos[campo];
    if (valor === null || valor === undefined) {
      partes.push(col ? `${col.coluna} is null` : `extras->>'${campo.replace(/[^A-Za-z0-9_]/g, "")}' is null`);
      continue;
    }
    if (col && ["json", "uuids", "fonte"].includes(col.tipo)) falhar(CODIGO.REPOSITORIO_INVALIDO, "Filtro de igualdade não suportado para este campo.", { campo });
    valores.push(col?.tipo === "centavos" ? centavosParaBanco(valor, campo) : !col ? String(valor) : valor);
    partes.push(col ? `${col.coluna} = $${valores.length}${CONVERSAO[col.tipo]}` : `extras->>'${campo.replace(/[^A-Za-z0-9_]/g, "")}' = $${valores.length}::text`);
  }
  return { sql: partes.join(" and "), valores, comExtras };
}

/**
 * Condições de paginar/agregar: escopo + `onde` (como em listar) + faixas (`desde`/`ate`) e listas (`em`). Faixa e ordem só
 * em colunas mapeadas e comparáveis; `em` também aceita campo de `extras` (comparado como texto).
 */
function condicoesDaConsulta(def, escopo, q) {
  const base = condicoes(def, escopo, q.onde, true);
  const valores = [...base.valores];
  const partes = [base.sql];
  const marca = (v, conv) => { valores.push(v); return `$${valores.length}${conv}`; };
  const paraBanco = (col, v, campo) => (col.tipo === "centavos" ? centavosParaBanco(v, campo) : v);
  for (const [chave, op] of [["desde", ">="], ["ate", "<="]]) {
    for (const [campo, v] of Object.entries(q[chave])) {
      const col = colunaComparavel(def, campo);
      partes.push(`${col.coluna} ${op} ${marca(paraBanco(col, v, campo), CONVERSAO[col.tipo])}`);
    }
  }
  for (const [campo, lista] of Object.entries(q.em)) {
    const col = def.campos[campo];
    if (!col) { partes.push(`extras->>'${campo.replace(/[^A-Za-z0-9_]/g, "")}' = any(${marca(lista.map(String), "::text[]")})`); continue; }
    const c = colunaComparavel(def, campo);
    partes.push(`${c.coluna} = any(${marca(lista.map((v) => paraBanco(c, v, campo)), `${CONVERSAO[c.tipo]}[]`)})`);
  }
  return { sql: partes.join(" and "), valores };
}

function colunaComparavel(def, campo) {
  const col = def.campos[campo];
  if (!col || ["json", "uuids", "fonte", "bool"].includes(col.tipo)) falhar(CODIGO.REPOSITORIO_INVALIDO, "Campo sem coluna comparável para faixa, lista ou ordem.", { campo });
  return col;
}

/** Registro de concessão como objeto coluna → valor, para a função guardada do banco (jsonb_populate_record). */
function concessaoParaBanco(def, registro) {
  const linha = {};
  for (const [campo, { coluna }] of Object.entries(def.campos)) linha[coluna] = registro[campo] ?? null;
  linha.extras = Object.fromEntries(Object.entries(registro).filter(([k, v]) => !(k in def.campos) && v !== undefined));
  return linha;
}

/** Erros do banco que significam "perdi uma disputa de concorrência": a operação pode ser refeita do zero. */
const DISPUTA = new Set(["23505", "40001", "40P01"]);
const SQLSTATE_DO_DOMINIO = { FV001: CODIGO.COMPETENCIA_HOMOLOGADA };
/** 07B: recusas de concessão e de sessão decididas NO BANCO. */
const RECUSAS_DE_ACESSO = {
  FV020: [CODIGO.PERMISSAO_INSUFICIENTE, "Sem concessão ativa do Financeiro v2 nesta unidade (conferido no banco)."],
  FV021: [CODIGO.PROVISIONAMENTO_RECUSADO, "O banco recusou o provisionamento inicial."],
  FV030: [CODIGO.PERMISSAO_INSUFICIENTE, "Ninguém concede nem revoga o próprio acesso (conferido no banco)."],
  FV031: [CODIGO.PERMISSAO_INSUFICIENTE, "A autoria da concessão precisa ser a do usuário da sessão."],
  FV032: [CODIGO.PERMISSAO_INSUFICIENTE, "Sem concessão para conceder nesta unidade (conferido no banco)."],
  FV034: [CODIGO.PERMISSAO_INSUFICIENTE, "Não é possível conceder uma ação que você não possui (conferido no banco)."],
  FV036: [CODIGO.PERMISSAO_INSUFICIENTE, "Sem concessão para revogar nesta unidade (conferido no banco)."],
  FV035: [CODIGO.PROVISIONAMENTO_RECUSADO, "O provisionamento só grava o que foi atestado, numa unidade sem administrador."],
  // 08C — regras da reclassificação conferidas no banco (gatilho de fv2_lancamento).
  FV037: [CODIGO.OPERACAO_INVALIDA, "A reclassificação muda só a categoria de um lançamento ativo (conferido no banco)."],
  FV038: [CODIGO.CATEGORIA_INVALIDA, "Categoria de destino incompatível com o lançamento (conferido no banco)."],
};

function traduzir(e) {
  if (e instanceof ErroFinanceiro || typeof e?.code !== "string") return e;
  const detalhes = { sqlstate: e.code, restricao: e.constraint ?? null, tabela: e.table ?? null };
  if (RECUSAS_DE_ACESSO[e.code]) return new ErroFinanceiro(RECUSAS_DE_ACESSO[e.code][0], RECUSAS_DE_ACESSO[e.code][1], detalhes);
  if (e.code === "23505") {
    const chave = /chave_uq$/.test(e.constraint ?? "");
    return Object.assign(new ErroFinanceiro(chave ? CODIGO.CONFLITO_IDEMPOTENCIA : CODIGO.INTEGRIDADE_VIOLADA, chave ? "Já existe um registro com a mesma origem externa." : "Registro duplicado recusado pelo banco.", detalhes), { repetivel: true });
  }
  if (e.code === "40001" || e.code === "40P01") {
    return Object.assign(new ErroFinanceiro(CODIGO.CONFLITO_VERSAO, "A operação concorreu com outra e não pôde ser concluída. Tente de novo.", detalhes), { repetivel: true });
  }
  if (SQLSTATE_DO_DOMINIO[e.code]) return new ErroFinanceiro(SQLSTATE_DO_DOMINIO[e.code], "A competência está homologada. Alterações exigem revisão formal com justificativa.", detalhes);
  // Classe 23 = violação de integridade; FV0xx = gatilhos do Financeiro v2; 42501 = privilégio/RLS.
  if (e.code.startsWith("23") || e.code.startsWith("FV") || e.code === "42501") {
    return new ErroFinanceiro(CODIGO.INTEGRIDADE_VIOLADA, "O banco recusou a gravação por violar uma regra de integridade do Financeiro v2.", detalhes);
  }
  return e;
}

const esperar = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });

function criarTx(cliente, { somenteLeitura }) {
  const definicao = (tipo) => ESQUEMA[tipo] ?? falhar(CODIGO.REPOSITORIO_INVALIDO, "Tipo de registro sem tabela.", { tipo });
  const exigirEscrita = () => {
    if (somenteLeitura) falhar(CODIGO.REPOSITORIO_INVALIDO, "Escrita fora de transação.");
  };
  const exigirEscopoDoRegistro = (r) => {
    if (!r?.id || !r.organizacaoId || !r.unidadeId) falhar(CODIGO.REPOSITORIO_INVALIDO, "Registro sem id/organização/unidade.");
  };
  const consulta = async (texto, valores) => {
    try {
      return await cliente.query(texto, valores);
    } catch (e) {
      throw traduzir(e);
    }
  };

  async function selecionar(def, escopo, filtro, { comExtras, sufixo = "" }) {
    const f = normalizarFiltro(filtro);
    const cond = condicoes(def, escopo, f.onde, comExtras);
    const { rows } = await consulta(`select ${selecao(def, comExtras)} from ${def.tabela} where ${cond.sql} order by seq${sufixo}`, cond.valores);
    return rows.map((linha) => registroDe(def, linha, { comExtras })).filter(f.predicado);
  }

  return {
    async inserir(tipo, registro) {
      exigirEscrita();
      exigirEscopoDoRegistro(registro);
      const def = definicao(tipo);
      // 07B: concessão só pela função guardada do banco (a aplicação não tem INSERT/UPDATE na tabela).
      if (tipo === "CONCESSAO") {
        await consulta("select fv2_gravar_concessao($1::jsonb, null) as n", [JSON.stringify(concessaoParaBanco(def, registro))]);
        return;
      }
      const g = gravacaoDe(def, registro, { comExtras: true });
      await consulta(`insert into ${def.tabela} (${g.colunas.join(", ")}) values (${g.marcas.join(", ")})`, g.valores);
    },

    async atualizar(tipo, registro, versaoEsperada) {
      exigirEscrita();
      exigirEscopoDoRegistro(registro);
      const def = definicao(tipo);
      if (registro.versao !== versaoEsperada + 1) falhar(CODIGO.CONFLITO_VERSAO, "O registro foi alterado por outra operação. Recarregue e tente de novo.", { tipo });
      let rowCount;
      if (tipo === "CONCESSAO") {
        const { rows: [r] } = await consulta("select fv2_gravar_concessao($1::jsonb, $2::integer) as n", [JSON.stringify(concessaoParaBanco(def, registro)), versaoEsperada]);
        rowCount = r.n;
      } else {
        const g = gravacaoDe(def, registro, { comExtras: true, semImutaveis: true });
        const n = g.valores.length;
        const atribuicoes = g.colunas.map((coluna, i) => `${coluna} = ${g.marcas[i]}`);
        ({ rowCount } = await consulta(
          `update ${def.tabela} set ${atribuicoes.join(", ")} where organizacao_id = $${n + 1}::uuid and unidade_id = $${n + 2}::uuid and id = $${n + 3}::uuid and versao = $${n + 4}::integer`,
          [...g.valores, registro.organizacaoId, registro.unidadeId, registro.id, versaoEsperada],
        ));
      }
      if (rowCount === 1) return;
      const { rows: vistos } = await consulta(`select versao from ${def.tabela} where organizacao_id = $1::uuid and unidade_id = $2::uuid and id = $3::uuid`, [registro.organizacaoId, registro.unidadeId, registro.id]);
      if (!vistos.length) falhar(CODIGO.NAO_ENCONTRADO, "Registro não encontrado.", { tipo });
      // 08B: a linha existe, é visível e está na versão esperada, mas o UPDATE não a alcançou → a autorização POR AÇÃO do
      // banco barrou (o RLS barra UPDATE em silêncio). Nunca é sucesso nem disputa a repetir: é acesso negado.
      if (Number(vistos[0].versao) === versaoEsperada) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "O banco recusou a alteração: a sessão não tem a ação exigida para esta operação.", { tipo });
      throw Object.assign(new ErroFinanceiro(CODIGO.CONFLITO_VERSAO, "O registro foi alterado por outra operação. Recarregue e tente de novo.", { tipo }), { repetivel: true });
    },

    async obter(escopo, tipo, id) {
      const [r] = await selecionar(definicao(tipo), escopo, { onde: { id } }, { comExtras: true, sufixo: somenteLeitura ? "" : " for update" });
      return r ?? null;
    },

    listar(escopo, tipo, filtro) {
      return selecionar(definicao(tipo), escopo, filtro, { comExtras: true });
    },

    async buscarPorChave(escopo, tipo, chave) {
      const [r] = await selecionar(definicao(tipo), escopo, { onde: { chaveIdempotencia: chave } }, { comExtras: true });
      return r ?? null;
    },

    /** Trava consultiva do PostgreSQL, liberada sozinha no fim da transação. Em leitura não há o que travar. */
    async travar(escopo, recurso, modo) {
      if (somenteLeitura) return;
      const funcao = modo === "EXCLUSIVA" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
      await consulta(`select ${funcao}(hashtextextended($1::text, 0))`, [`fv2|${escopo.organizacaoId}|${escopo.unidadeId}|${recurso}`]);
    },

    async anexarHistorico(evento) {
      exigirEscrita();
      exigirEscopoDoRegistro(evento);
      const g = gravacaoDe(HISTORICO, evento, { comExtras: false });
      await consulta(`insert into ${HISTORICO.tabela} (${g.colunas.join(", ")}) values (${g.marcas.join(", ")})`, g.valores);
    },

    listarHistorico(escopo, filtro) {
      return selecionar(HISTORICO, escopo, filtro, { comExtras: false });
    },

    /** Página + total, ambos calculados no banco (LIMIT/OFFSET e COUNT). */
    async paginar(escopo, tipo, pedido) {
      const def = definicao(tipo);
      const q = normalizarConsulta(pedido);
      const cond = condicoesDaConsulta(def, escopo, q);
      const ordem = [...q.ordem.map((o) => `${colunaComparavel(def, o.campo).coluna} ${o.desc ? "desc" : "asc"} nulls last`), "seq asc"].join(", ");
      const n = cond.valores.length;
      const { rows } = await consulta(`select ${selecao(def, true)} from ${def.tabela} where ${cond.sql} order by ${ordem} limit $${n + 1}::integer offset $${n + 2}::integer`, [...cond.valores, q.limite, q.deslocamento]);
      const { rows: [contagem] } = await consulta(`select count(*)::int as total from ${def.tabela} where ${cond.sql}`, cond.valores);
      return { itens: rows.map((linha) => registroDe(def, linha, { comExtras: true })), total: contagem.total };
    },

    /** Contagem e soma agrupadas, no banco. Independem de qualquer paginação. */
    async agregar(escopo, tipo, pedido) {
      const def = definicao(tipo);
      const q = normalizarConsulta(pedido, { paginada: false });
      const cond = condicoesDaConsulta(def, escopo, q);
      let grupo = "null::text";
      if (q.agruparPor) {
        const col = def.campos[q.agruparPor];
        grupo = !col ? `extras->>'${q.agruparPor.replace(/[^A-Za-z0-9_]/g, "")}'` : col.tipo === "data" ? `to_char(${colunaComparavel(def, q.agruparPor).coluna}, 'YYYY-MM-DD')` : `${colunaComparavel(def, q.agruparPor).coluna}::text`;
      }
      let soma = "0";
      if (q.somar) {
        const col = def.campos[q.somar];
        if (col?.tipo !== "centavos") falhar(CODIGO.REPOSITORIO_INVALIDO, "Só campos de centavos podem ser somados.", { campo: q.somar });
        soma = `coalesce(sum(${col.coluna}), 0)`;
      }
      const { rows } = await consulta(`select ${grupo} as grupo, count(*)::int as quantidade, (${soma})::text as soma from ${def.tabela} where ${cond.sql} group by 1 order by 1 nulls first`, cond.valores);
      return rows.map((r) => ({ grupo: r.grupo, quantidade: r.quantidade, somaCentavos: q.somar ? centavosDoBanco(r.soma, q.somar) : null }));
    },
  };
}

/**
 * @param {object} deps
 * @param {{connect: () => Promise<{query: Function, release: Function}>}} deps.pool conexões JÁ conferidas pela guarda de destino
 * @param {{emitir: (escopo:{organizacaoId:string, unidadeId:string, usuarioId:string}) => Promise<string>,
 *          emitirProvisionamento?: (ato:object) => Promise<string>}} deps.sessoes
 *        AUTORIDADE de sessões (07B): emite o token de sessão de banco de um usuário numa unidade. Fica FORA da aplicação
 *        (credencial própria). Sem ela não há transação: a aplicação não escolhe escopo por variável.
 * @param {number} [deps.tentativas] quantas vezes uma transação é refeita ao perder uma disputa de concorrência
 * @param {number} [deps.reusoDoTokenMs] por quanto tempo um token emitido é reaproveitado antes de pedir outro
 */
export function criarRepositorioPostgres({ pool, sessoes, tentativas = 5, reusoDoTokenMs = 5 * 60 * 1000, relogio = () => Date.now() }) {
  if (!pool || typeof pool.connect !== "function") falhar(CODIGO.REPOSITORIO_INVALIDO, "O adaptador PostgreSQL exige um pool de conexões.");
  if (!sessoes || typeof sessoes.emitir !== "function") falhar(CODIGO.REPOSITORIO_INVALIDO, "O adaptador PostgreSQL exige a autoridade de sessões de banco.");

  /** Tokens já emitidos, por usuário + unidade (só em memória do processo; o banco guarda apenas o hash). */
  const tokens = new Map();
  const chaveDoToken = (e) => `${e.usuarioId}|${e.organizacaoId}|${e.unidadeId}`;
  async function emitir(e) {
    try {
      return await sessoes.emitir({ organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId, permissoes: e.permissoes ?? [] });
    } catch (erro) {
      throw traduzir(erro);
    }
  }
  function tokenDe(e, { renovar = false } = {}) {
    const k = chaveDoToken(e);
    const guardado = tokens.get(k);
    if (!renovar && guardado && guardado.ate > relogio()) return guardado.promessa;
    const promessa = emitir(e);
    tokens.set(k, { promessa, ate: relogio() + reusoDoTokenMs });
    promessa.catch(() => { if (tokens.get(k)?.promessa === promessa) tokens.set(k, { promessa, ate: 0 }); }); // recusa não fica guardada
    return promessa;
  }

  /** Declara o token na transação e confere, NO BANCO, que ele é deste usuário nesta unidade. */
  async function assumir(cliente, e, token) {
    const { rows: [v] } = await cliente.query("select usuario_id::text as u, organizacao_id::text as o, unidade_id::text as n from fv2_assumir_sessao($1)", [token]);
    return v?.u === e.usuarioId && v?.o === e.organizacaoId && v?.n === e.unidadeId;
  }
  async function declararSessao(cliente, e, provisionamento, reiniciar = null) {
    if (provisionamento) {
      if (await assumir(cliente, e, await provisionamento())) return;
      falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "A sessão de provisionamento não foi aceita pelo banco.");
    }
    if (await assumir(cliente, e, await tokenDe(e))) return;
    // Token expirado ou revogado (concessão alterada, logout): pede outro uma vez. Sem concessão, a autoridade recusa.
    const novo = await tokenDe(e, { renovar: true });
    // Leitura em retrato fixo (repeatable read) não enxergaria a sessão recém-emitida: recomeça a transação.
    if (reiniciar) await reiniciar();
    if (await assumir(cliente, e, novo)) return;
    falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Sessão de banco recusada para este usuário nesta unidade.");
  }

  async function comCliente(fn) {
    const cliente = await pool.connect();
    // 08: conexão perdida no meio (servidor encerrou, rede caiu) NUNCA volta ao pool — é descartada. E o erro emitido
    // pela conexão enquanto estava conosco não derruba o processo.
    let perdida = false;
    const aoErro = () => { perdida = true; };
    cliente.on?.("error", aoErro);
    try {
      return await fn(cliente, () => { perdida = true; });
    } finally {
      cliente.removeListener?.("error", aoErro);
      cliente.release(perdida ? new Error("Financeiro v2: conexão perdida descartada do pool.") : undefined);
    }
  }

  function exigirEscopo(opcoes) {
    const e = opcoes?.escopo;
    // Sem escopo e usuário declarados não há transação: no banco, sem sessão válida, nada é visto nem gravado.
    if (!e?.organizacaoId || !e?.unidadeId || !e?.usuarioId) falhar(CODIGO.REPOSITORIO_INVALIDO, "Toda transação do Financeiro v2 declara organização, unidade e usuário.");
    return e;
  }

  /** Provisionamento inicial: UMA sessão especial por chamada (reaproveitada nas novas tentativas da mesma chamada). */
  function sessaoDeProvisionamento(ato) {
    if (!ato) return null;
    if (typeof sessoes.emitirProvisionamento !== "function") falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "Não há autoridade de provisionamento no banco.");
    let promessa;
    return () => (promessa ??= sessoes.emitirProvisionamento(ato).catch((erro) => { throw traduzir(erro); }));
  }

  async function umaTentativa(fn, escopo, provisionamento) {
    return comCliente(async (cliente, descartar) => {
      await cliente.query("begin");
      try {
        await declararSessao(cliente, escopo, provisionamento);
        const resultado = await fn(criarTx(cliente, { somenteLeitura: false }));
        await cliente.query("commit"); // as conferências adiadas (integridade, conservação, histórico) rodam aqui
        return resultado;
      } catch (e) {
        try {
          await cliente.query("rollback");
        } catch {
          // a conexão já caiu; o banco desfaz a transação sozinho — e a conexão é descartada (não volta ao pool)
          descartar();
        }
        throw traduzir(e);
      }
    });
  }

  async function transacao(fn, opcoes) {
    const escopo = exigirEscopo(opcoes);
    const provisionamento = sessaoDeProvisionamento(opcoes.provisionamento);
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await umaTentativa(fn, escopo, provisionamento);
      } catch (e) {
        if (!(e?.repetivel || DISPUTA.has(e?.code)) || tentativa >= tentativas) throw e;
        await esperar(5 * tentativa);
      }
    }
  }

  function leitura(fn, opcoes) {
    const escopo = exigirEscopo(opcoes);
    return comCliente(async (cliente) => {
      const iniciar = () => cliente.query("begin transaction isolation level repeatable read read only");
      await iniciar();
      try {
        await declararSessao(cliente, escopo, null, async () => { await cliente.query("rollback"); await iniciar(); });
        return await fn(criarTx(cliente, { somenteLeitura: true }));
      } catch (e) {
        throw traduzir(e);
      } finally {
        await cliente.query("rollback");
      }
    });
  }

  return Object.freeze({ transacao, leitura });
}
