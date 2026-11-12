// Adaptador POSTGRESQL da porta de persistência (contratos/repositorio.js).
//
// - Não importa driver: recebe um `pool` compatível com node-postgres ({ connect() → { query(texto, valores), release() } }).
//   Quem monta decide a conexão — e é obrigado a passar pela guarda de destino (destinoSeguro.js) antes.
// - Nenhuma fórmula financeira aqui: o adaptador grava o que o núcleo calculou; o banco confere (restrições e gatilhos).
// - Cada transação declara o escopo na sessão; as políticas de RLS do banco isolam organização + unidade.
// - Concorrência: `obter` dentro de transação reserva a linha (FOR UPDATE); toda alteração confere a versão; disputas
//   perdidas (linha alterada por outro, chave única já gravada, deadlock) fazem a operação inteira ser REEXECUTADA sobre
//   o estado novo — daí sai o resultado correto: registro repetido devolvido, saldo insuficiente recusado, etc.
// - Não existe método de exclusão, e o papel de banco da aplicação nem tem esse privilégio.
import { CODIGO, ErroFinanceiro, falhar } from "../../dominio/erros.js";
import { congelar } from "../../dominio/validacao.js";
import { normalizarFiltro } from "../../contratos/repositorio.js";
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

/** Erros do banco que significam "perdi uma disputa de concorrência": a operação pode ser refeita do zero. */
const DISPUTA = new Set(["23505", "40001", "40P01"]);
const SQLSTATE_DO_DOMINIO = { FV001: CODIGO.COMPETENCIA_HOMOLOGADA };

function traduzir(e) {
  if (e instanceof ErroFinanceiro || typeof e?.code !== "string") return e;
  const detalhes = { sqlstate: e.code, restricao: e.constraint ?? null, tabela: e.table ?? null };
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
      const g = gravacaoDe(def, registro, { comExtras: true });
      await consulta(`insert into ${def.tabela} (${g.colunas.join(", ")}) values (${g.marcas.join(", ")})`, g.valores);
    },

    async atualizar(tipo, registro, versaoEsperada) {
      exigirEscrita();
      exigirEscopoDoRegistro(registro);
      const def = definicao(tipo);
      if (registro.versao !== versaoEsperada + 1) falhar(CODIGO.CONFLITO_VERSAO, "O registro foi alterado por outra operação. Recarregue e tente de novo.", { tipo });
      const g = gravacaoDe(def, registro, { comExtras: true, semImutaveis: true });
      const n = g.valores.length;
      const atribuicoes = g.colunas.map((coluna, i) => `${coluna} = ${g.marcas[i]}`);
      const { rowCount } = await consulta(
        `update ${def.tabela} set ${atribuicoes.join(", ")} where organizacao_id = $${n + 1}::uuid and unidade_id = $${n + 2}::uuid and id = $${n + 3}::uuid and versao = $${n + 4}::integer`,
        [...g.valores, registro.organizacaoId, registro.unidadeId, registro.id, versaoEsperada],
      );
      if (rowCount === 1) return;
      const { rowCount: existe } = await consulta(`select 1 from ${def.tabela} where organizacao_id = $1::uuid and unidade_id = $2::uuid and id = $3::uuid`, [registro.organizacaoId, registro.unidadeId, registro.id]);
      if (!existe) falhar(CODIGO.NAO_ENCONTRADO, "Registro não encontrado.", { tipo });
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
  };
}

/**
 * @param {object} deps
 * @param {{connect: () => Promise<{query: Function, release: Function}>}} deps.pool conexões JÁ conferidas pela guarda de destino
 * @param {number} [deps.tentativas] quantas vezes uma transação é refeita ao perder uma disputa de concorrência
 */
export function criarRepositorioPostgres({ pool, tentativas = 5 }) {
  if (!pool || typeof pool.connect !== "function") falhar(CODIGO.REPOSITORIO_INVALIDO, "O adaptador PostgreSQL exige um pool de conexões.");

  async function comCliente(fn) {
    const cliente = await pool.connect();
    try {
      return await fn(cliente);
    } finally {
      cliente.release();
    }
  }

  function exigirEscopo(opcoes) {
    const e = opcoes?.escopo;
    // Sem escopo declarado não há transação: no banco, sessão sem escopo não enxerga nem grava linha alguma.
    if (!e?.organizacaoId || !e?.unidadeId) falhar(CODIGO.REPOSITORIO_INVALIDO, "Toda transação do Financeiro v2 declara organização e unidade.");
    return e;
  }

  const declararEscopo = (cliente, e) => cliente.query("select set_config('fv2.organizacao_id', $1, true), set_config('fv2.unidade_id', $2, true)", [e.organizacaoId, e.unidadeId]);

  async function umaTentativa(fn, escopo) {
    return comCliente(async (cliente) => {
      await cliente.query("begin");
      try {
        await declararEscopo(cliente, escopo);
        const resultado = await fn(criarTx(cliente, { somenteLeitura: false }));
        await cliente.query("commit"); // as conferências adiadas (integridade, conservação, histórico) rodam aqui
        return resultado;
      } catch (e) {
        try {
          await cliente.query("rollback");
        } catch {
          // a conexão já caiu; o banco desfaz a transação sozinho
        }
        throw traduzir(e);
      }
    });
  }

  async function transacao(fn, opcoes) {
    const escopo = exigirEscopo(opcoes);
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await umaTentativa(fn, escopo);
      } catch (e) {
        if (!(e?.repetivel || DISPUTA.has(e?.code)) || tentativa >= tentativas) throw e;
        await esperar(5 * tentativa);
      }
    }
  }

  function leitura(fn, opcoes) {
    const escopo = exigirEscopo(opcoes);
    return comCliente(async (cliente) => {
      await cliente.query("begin transaction isolation level repeatable read read only");
      try {
        await declararEscopo(cliente, escopo);
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
