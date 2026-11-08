// Busca FINANCEIRA: categorias, fornecedores, obrigações, pagamentos e movimentos (livro-caixa) da organização/unidade do CONTEXTO.
// O escopo vem só do contexto autenticado (os repositórios já filtram organização e unidade): não existe parâmetro para trocar de empresa.
// Indicadores, relatórios e funcionalidades são catálogo estático e ficam no frontend. Nenhum valor é calculado aqui — só localizado.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { bad } from "./validacao.js";
import { planoParaExibicao } from "../../../financeiro-calculos/rotulosCategorias.js";

const padrao = { repo: repositorio, db: undefined };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const LIMITE = 8;

export async function buscar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const termo = String(q?.q ?? "").trim();
  if (termo.length < 2) throw bad("Digite ao menos 2 caracteres para buscar.", "BUSCA_CURTA");
  if (termo.length > 80) throw bad("Busca longa demais (máximo 80 caracteres).", "BUSCA_LONGA");
  const t = norm(termo);
  const acha = (...campos) => campos.some((x) => norm(x).includes(t));
  const doze = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [plano, forn, obrs, pags, lancs, contas] = await Promise.all([deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarFornecedores(c, deps.db), deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarPagamentos(c, deps.db),
    deps.repo.listarTodosLancamentos(c, { de: doze }, deps.db), deps.repo.listarContas(c, deps.db)]);
  const exib = planoParaExibicao(c.organizacaoId, plano, deps.env ?? process.env);
  const catNome = new Map(exib.map((x) => [x.id, x.nome])), fornNome = new Map(forn.map((f) => [f.id, f.nome])), contaNome = new Map(contas.map((x) => [x.id, x.nome]));
  const obrPorId = new Map(obrs.map((o) => [o.id, o]));
  const mesDe = (d) => String(d ?? "").slice(0, 7);
  const corta = (xs) => ({ total: xs.length, itens: xs.slice(0, LIMITE) });
  const categorias = corta(exib.filter((x) => x.ativo !== false && acha(x.nome, plano.find((p) => p.id === x.id)?.nome)).map((x) => ({ tipo: "categoria", id: x.id, titulo: x.nome, subtitulo: x.nomeOriginal ? `no plano de contas: ${x.nomeOriginal}` : (x.papel ?? ""), rota: "fin-categorias" })));
  const fornecedores = corta(forn.filter((f) => f.ativo !== false && acha(f.nome, f.documento)).map((f) => ({ tipo: "fornecedor", id: f.id, titulo: f.nome, subtitulo: "Fornecedor", busca: f.nome, rota: "fin-contas-a-pagar" })));
  const obrigacoes = corta(obrs.filter((o) => acha(o.descricao, fornNome.get(o.fornecedor_id), catNome.get(o.categoria_id))).sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)))
    .map((o) => ({ tipo: "obrigacao", id: o.id, titulo: o.descricao, subtitulo: `${fornNome.get(o.fornecedor_id) ?? "—"} · ${catNome.get(o.categoria_id) ?? "—"}`, mes: mesDe(o.competencia), valorCentavos: Number(o.valor_original_centavos), busca: o.descricao, rota: "fin-contas-a-pagar" })));
  const pagamentos = corta(pags.filter((p) => p.status !== "cancelado").map((p) => ({ p, o: obrPorId.get(p.obrigacao_id) })).filter(({ o }) => o && acha(o.descricao, fornNome.get(o.fornecedor_id), catNome.get(o.categoria_id)))
    .sort((a, b) => String(b.p.data_pagamento).localeCompare(String(a.p.data_pagamento))).map(({ p, o }) => ({ tipo: "pagamento", id: p.id, titulo: o.descricao, subtitulo: `pago em ${String(p.data_pagamento).slice(0, 10)} · ${contaNome.get(p.conta_id) ?? "—"}`, mes: mesDe(p.data_pagamento), valorCentavos: Number(p.valor_centavos), busca: o.descricao, rota: "fin-contas-a-pagar" })));
  const movimentos = corta(lancs.filter((l) => l.status !== "cancelado" && acha(l.descricao, catNome.get(l.categoria_id), contaNome.get(l.conta_id)))
    .sort((a, b) => String(b.data_movimento).localeCompare(String(a.data_movimento))).map((l) => ({ tipo: "movimento", id: l.id, titulo: l.descricao ?? "(sem descrição)", subtitulo: `${String(l.data_movimento).slice(0, 10)} · ${contaNome.get(l.conta_id) ?? "—"} · ${catNome.get(l.categoria_id) ?? "sem categoria"}`, mes: mesDe(l.data_movimento), valorCentavos: (l.sentido === "entrada" ? 1 : -1) * Number(l.valor_centavos), busca: l.descricao, rota: "fin-fluxo-de-caixa" })));
  return { termo, grupos: { categorias, fornecedores, obrigacoes, pagamentos, movimentos } };
}
