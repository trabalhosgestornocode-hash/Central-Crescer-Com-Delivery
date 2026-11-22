// CONFERÊNCIA DE CONTAS A PAGAR (Agente 2) — consultas determinísticas de custo zero, só leitura.
//
// Fonte única: os títulos OFICIAIS do Financeiro v2 (consultarContasAPagar, via porta.contasAPagarTodas) e as saídas do extrato
// ainda sem vínculo (previaDoVinculoDoExtrato, a mesma prévia da tela de baixa). Nada aqui grava, baixa, cancela ou estima.
//
// O que cada marca significa (nunca misturar):
//   - "vencida"                  = o Financeiro registra vencimento passado e saldo em aberto (não diz que não foi paga no banco);
//   - "possível pagamento no extrato, NÃO confirmado" = existe saída do extrato SEM vínculo, com valor IGUAL e favorecido de nome
//                                  compatível com o fornecedor. Valor igual sozinho NÃO conta (o diagnóstico de 22/11 mostrou 8
//                                  falsos positivos assim). Sem comprovante ou conciliação confirmada, NÃO é pagamento;
//   - "parcial"                  = há pagamento registrado menor que o valor da conta;
//   - "sem documento"            = o Financeiro aponta SEM_DOCUMENTO (nenhum documento anexado à conta);
//   - "possível duplicidade"     = outra conta viva do MESMO fornecedor identificado, mesmo valor, vencimento a até 7 dias;
//   - "revisar"                  = fornecedor não identificado no cadastro ou ajuste manual registrado no saldo (fato, não juízo).
// Detalhe por conta/fornecedor só chega aqui quando o motor libera (todos os leitores FINANCEIRO na unidade).
import { reais, dataBr } from "./respostas.js";

export const SITUACOES_ABERTAS = Object.freeze(["EM_ABERTO", "PARCIALMENTE_PAGO", "VENCIDO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA"]);
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const LIMITE_LISTA_CARACTERES = 2600; // a mensagem inteira fica abaixo do limite do Gateway (4096), com cabeçalho e avisos
export const JANELA_EXTRATO = Object.freeze({ antesDoVencimento: 20, depoisDoVencimento: 60 });
const FORNECEDOR_GENERICO = /^(fornecedor\s+a\s+identificar|a\s+identificar|nao\s+identificado|desconhecido|diversos)$/;
const PALAVRAS_NEUTRAS = new Set(["ltda", "eireli", "me", "epp", "sa", "comercio", "servicos", "industria", "distribuidora", "acai", "grau", "saci",
  "pagamento", "pix", "enviado", "transferencia", "debito", "credito", "boleto", "doc", "deb", "conta", "entre", "contas", "produtos"]);

export const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const centavos = (v) => (Number.isSafeInteger(v) ? v : null);
export const abertaComSaldo = (t) => SITUACOES_ABERTAS.includes(t.situacao) && Number.isSafeInteger(t.saldoCentavos) && t.saldoCentavos > 0;
export const fornecedorIdentificado = (t) => Boolean(t.fornecedor?.nome) && !FORNECEDOR_GENERICO.test(normalizar(t.fornecedor.nome).replace(/\s+/g, " ").trim());
const curto = (s, n = 40) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const dias = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const somaSaldo = (l) => l.reduce((s, t) => s + t.saldoCentavos, 0);
export const nomeDoFornecedor = (t) => (fornecedorIdentificado(t) ? curto(t.fornecedor.nome) : "fornecedor não identificado");

/** Palavras que identificam um nome (para comparar fornecedor × favorecido do extrato). */
export function palavrasDoNome(s) {
  return new Set(normalizar(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !PALAVRAS_NEUTRAS.has(w)));
}

/** A descrição sem o nome do fornecedor; vazia ⇒ null. */
export function descricaoSemFornecedor(descricao, fornecedor) {
  let d = String(descricao ?? "").replace(/\s+/g, " ").trim();
  const f = String(fornecedor ?? "").replace(/\s+/g, " ").trim();
  if (f) {
    const i = d.toLowerCase().indexOf(f.toLowerCase());
    if (i >= 0) d = (d.slice(0, i) + d.slice(i + f.length)).replace(/\(\s*\)|\[\s*\]/g, "").replace(/(\s*[-–—·:|]\s*){2,}/g, " — ").replace(/\s*[-–—·:|]\s*$/, "").replace(/^\s*[-–—·:|]\s*/, "").replace(/\s+/g, " ").trim();
  }
  return d || null;
}

/** Situação curta da conta (só a do Financeiro; parcial mostra quanto foi registrado como pago). */
export function situacaoDaConta(t) {
  const pago = centavos(t.pagoCentavos) > 0 ? t.pagoCentavos : 0;
  const parcial = pago > 0 && Number.isSafeInteger(t.valorOriginalCentavos) ? `parcial, pago ${reais(pago)} de ${reais(t.valorOriginalCentavos)}` : null;
  if (t.situacao === "PAGO") return "paga";
  if (t.situacao === "CANCELADO") return "cancelada";
  if (t.situacao === "VENCIDO" || t.vencido) return parcial ? `vencida, ${parcial}` : "vencida";
  if (t.situacao === "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA") return parcial ? `${parcial}, aguardando classificação` : "aberta, aguardando classificação";
  return parcial ?? "aberta";
}

/**
 * Saídas do extrato com valor IGUAL e favorecido de nome compatível (nunca só pelo valor). Só para conta aberta de fornecedor
 * identificado. Devolve as saídas candidatas (pode haver mais de uma: aí é ambíguo e a resposta diz isso).
 */
export function saidasCompativeis(t, saidas) {
  if (!abertaComSaldo(t) || !fornecedorIdentificado(t) || !t.vencimento || !Array.isArray(saidas)) return [];
  const nome = palavrasDoNome(t.fornecedor.nome);
  if (nome.size === 0) return [];
  const alvos = new Set([t.saldoCentavos, t.valorOriginalCentavos].filter((v) => Number.isSafeInteger(v) && v > 0));
  return saidas.filter((s) => {
    const livre = (s.valorCentavos ?? 0) - (s.alocadoCentavos ?? 0);
    if (livre <= 0 || !(alvos.has(s.valorCentavos) || alvos.has(livre))) return false;
    const d = dias(t.vencimento, s.data);
    if (d < -JANELA_EXTRATO.antesDoVencimento || d > JANELA_EXTRATO.depoisDoVencimento) return false;
    return [...palavrasDoNome(s.descricao)].some((w) => nome.has(w));
  });
}

/** Outras contas vivas do MESMO fornecedor identificado, com o mesmo valor e vencimento a até 7 dias. */
export function possiveisDuplicidades(t, todas) {
  if (!fornecedorIdentificado(t) || !t.vencimento) return [];
  const f = normalizar(t.fornecedor.nome).trim();
  return todas.filter((x) => x.id !== t.id && x.situacao !== "CANCELADO" && fornecedorIdentificado(x) && normalizar(x.fornecedor.nome).trim() === f
    && x.valorOriginalCentavos === t.valorOriginalCentavos && x.vencimento && Math.abs(dias(t.vencimento, x.vencimento)) <= 7);
}

/**
 * Conta SEM fornecedor identificado cuja descrição cita um fornecedor cadastrado: outras contas desse fornecedor com o MESMO
 * valor e vencimento a até 90 dias (ex.: "Contabilidade 09/2026 – Escritório X" × "Escritório X · Contador/Setembro/26").
 * É só um aviso para conferir; nada é cancelado ou baixado.
 */
export function contasParecidas(t, todas) {
  if (fornecedorIdentificado(t) || !t.vencimento || !Number.isSafeInteger(t.valorOriginalCentavos)) return [];
  const desc = palavrasDoNome(t.descricao);
  if (desc.size === 0) return [];
  const mesT = mesCitado(t.descricao);
  // Só a conta JÁ PAGA conta como "gêmea" (a aberta sem fornecedor pode ser o registro duplicado dela); mês citado nas duas deve bater.
  return todas.filter((x) => x.id !== t.id && x.situacao === "PAGO" && fornecedorIdentificado(x) && x.valorOriginalCentavos === t.valorOriginalCentavos
    && x.vencimento && Math.abs(dias(t.vencimento, x.vencimento)) <= 90 && [...palavrasDoNome(x.fornecedor.nome)].some((w) => desc.has(w))
    && (!mesT || !mesCitado(x.descricao) || mesT === mesCitado(x.descricao)));
}

/** Mês citado na descrição ("09/2026", "Setembro/26", "setembro") ⇒ "09"; nenhum ⇒ null. */
export function mesCitado(descricao) {
  const d = normalizar(descricao);
  const num = d.match(/(?:^|[^0-9])(0[1-9]|1[0-2])\/(20\d{2}|\d{2})(?:[^0-9]|$)/);
  if (num) return num[1];
  const i = MESES.findIndex((m) => new RegExp(`(^|[^a-z])${m}([^a-z]|$)`).test(d));
  return i >= 0 ? String(i + 1).padStart(2, "0") : null;
}

/** Marcas de conferência de UMA conta aberta (rótulos fixos, na ordem da prioridade de leitura). */
export function marcasDaConta(t, { todas = [], saidas = null } = {}) {
  const m = [];
  if (saidas && saidasCompativeis(t, saidas).length) m.push("possível pagamento no extrato, NÃO confirmado");
  if ((t.pendencias ?? []).includes("SEM_DOCUMENTO")) m.push("sem documento");
  if (possiveisDuplicidades(t, todas).length || contasParecidas(t, todas).length) m.push("possível duplicidade");
  if (centavos(t.ajustesCentavos) && t.ajustesCentavos !== 0) m.push(`revisar: ajuste de ${t.ajustesCentavos > 0 ? "+" : "−"}${reais(Math.abs(t.ajustesCentavos))}`);
  return m;
}

/** Linha de uma conta: "dd/mm · fornecedor · descrição — R$ saldo (situação; marcas)". */
export function linhaDaConta(t, { marcas = [], valor = t.saldoCentavos, data = true } = {}) {
  const resto = descricaoSemFornecedor(t.descricao, fornecedorIdentificado(t) ? t.fornecedor.nome : null);
  const descricao = resto ? ` · ${curto(resto, 34)}` : "";
  const quando = data && t.vencimento ? `${dataBr(t.vencimento).slice(0, 5)} · ` : "";
  return `${quando}${nomeDoFornecedor(t)}${descricao} — ${reais(valor)} (${[situacaoDaConta(t), ...marcas].join("; ")})`;
}

/** Lista limitada pelo tamanho da mensagem; o que não cabe vira "… e mais N, R$ X" (nunca some calado). */
export function listarComLimite(itens, formatar, { limite = LIMITE_LISTA_CARACTERES, valor = (t) => t.saldoCentavos, nome = ["conta", "contas"] } = {}) {
  const linhas = []; let usados = 0; let mostradas = 0;
  for (const t of itens) {
    const l = formatar(t);
    if (usados + l.length > limite) break;
    linhas.push(l); usados += l.length; mostradas += 1;
  }
  if (mostradas < itens.length) {
    const resto = itens.slice(mostradas);
    linhas.push(`… e mais ${plural(resto.length, nome[0], nome[1])}, ${reais(resto.reduce((s, t) => s + valor(t), 0))} (lista completa no Centro Financeiro)`);
  }
  return linhas;
}

/** Resumo das marcas de um conjunto (só as que existem). */
function resumoDasMarcas(lista, ctx) {
  const conta = (f) => lista.filter(f);
  const r = [];
  const extrato = ctx.saidas ? conta((t) => saidasCompativeis(t, ctx.saidas).length > 0) : [];
  const parcial = conta((t) => centavos(t.pagoCentavos) > 0);
  const semDoc = conta((t) => (t.pendencias ?? []).includes("SEM_DOCUMENTO"));
  const dup = conta((t) => possiveisDuplicidades(t, ctx.todas).length > 0 || contasParecidas(t, ctx.todas).length > 0);
  const semForn = conta((t) => !fornecedorIdentificado(t));
  if (extrato.length) r.push(`${extrato.length} com possível pagamento no extrato, NÃO confirmado (${reais(somaSaldo(extrato))})`);
  if (parcial.length) r.push(`${parcial.length} com pagamento parcial registrado`);
  if (semDoc.length) r.push(`${semDoc.length} sem documento`);
  if (dup.length) r.push(`${dup.length} com possível duplicidade`);
  if (semForn.length) r.push(`${semForn.length} sem fornecedor identificado (${reais(somaSaldo(semForn))})`);
  return r.length ? [`conferência: ${r.join("; ")}`] : [];
}

const extratoIndisponivel = "conferência com o extrato indisponível agora (sem marca de possível pagamento)";
const coberturaDoExtrato = (saidas) => {
  const d = (saidas ?? []).map((s) => s.data).filter(Boolean).sort();
  return d.length ? `extrato importado com saídas de ${dataBr(d[0])} a ${dataBr(d.at(-1))}` : "nenhuma saída do extrato pendente de vínculo";
};

// ---------------------------------------------------------------------------------------------------------- consultas

/** Contas registradas como vencidas (vencimento antes de hoje, saldo em aberto), da mais antiga para a mais nova. */
export function contasVencidas({ todas, hoje, saidas = null, extratoFalhou = false }) {
  const v = todas.filter((t) => abertaComSaldo(t) && t.vencimento && t.vencimento < hoje).sort((a, b) => b.saldoCentavos - a.saldoCentavos || a.vencimento.localeCompare(b.vencimento));
  if (!v.length) return [`nenhuma conta a pagar registrada como vencida até ${dataBr(hoje)}`];
  const ctx = { todas, saidas };
  const antiga = v.reduce((x, t) => (t.vencimento < x ? t.vencimento : x), v[0].vencimento);
  return [
    `registradas como vencidas (vencimento passou e há saldo no Financeiro): ${plural(v.length, "conta", "contas")}, ${reais(somaSaldo(v))}; a mais antiga venceu em ${dataBr(antiga)}; maiores primeiro:`,
    ...listarComLimite(v, (t) => linhaDaConta(t, { marcas: marcasDaConta(t, ctx).filter((m) => m !== "sem documento") })),
    ...resumoDasMarcas(v, ctx),
    ...(extratoFalhou ? [extratoIndisponivel] : []),
    "vencida = sem pagamento registrado no Financeiro; não prova que não houve pagamento no banco",
  ];
}

/** Contas sem documento: em aberto sem documento anexado e pagas sem nenhum comprovante (nem na conta, nem no pagamento). */
export function contasSemComprovante({ todas, detalhe }) {
  const abertas = todas.filter((t) => abertaComSaldo(t) && (t.pendencias ?? []).includes("SEM_DOCUMENTO")).sort((a, b) => b.saldoCentavos - a.saldoCentavos);
  const pagasSemComprovante = todas.filter((t) => t.situacao === "PAGO" && centavos(t.pagoCentavos) > 0 && (t.documentos ?? []).length === 0
    && (t.pagamentos ?? []).every((p) => (p.documentos ?? []).length === 0));
  const valorPago = (t) => (centavos(t.pagoCentavos) ?? 0);
  const linhas = [
    abertas.length ? `em aberto sem documento anexado: ${plural(abertas.length, "conta", "contas")}, ${reais(somaSaldo(abertas))}` : "nenhuma conta em aberto sem documento",
    pagasSemComprovante.length ? `pagas sem comprovante anexado: ${plural(pagasSemComprovante.length, "conta", "contas")}, ${reais(pagasSemComprovante.reduce((s, t) => s + valorPago(t), 0))} (pagamento registrado sem documento)` : "nenhuma conta paga sem comprovante",
  ];
  if (!detalhe) return linhas;
  if (abertas.length) linhas.push("em aberto, maiores primeiro:", ...listarComLimite(abertas, (t) => linhaDaConta(t), { limite: 1300 }));
  if (pagasSemComprovante.length) {
    const recentes = [...pagasSemComprovante].sort((a, b) => String(b.vencimento).localeCompare(String(a.vencimento)));
    linhas.push("pagas sem comprovante, mais recentes primeiro:", ...listarComLimite(recentes, (t) => linhaDaConta(t, { valor: valorPago(t) }), { limite: 900, valor: valorPago }));
  }
  linhas.push("documento anexado não confirma pagamento; comprovante não é conciliação");
  return linhas;
}

/** Pagamentos que pedem conciliação: saídas do extrato sem vínculo e contas abertas com possível pagamento (NÃO confirmado). */
export function pagamentosAConciliar({ todas, saidas, detalhe }) {
  const livres = (saidas ?? []).filter((s) => (s.valorCentavos ?? 0) - (s.alocadoCentavos ?? 0) > 0);
  const livre = (s) => s.valorCentavos - (s.alocadoCentavos ?? 0);
  const candidatas = todas.filter(abertaComSaldo).map((t) => ({ t, s: saidasCompativeis(t, livres) })).filter((x) => x.s.length);
  const linhas = [
    livres.length ? `saídas do extrato ainda sem vínculo com conta a pagar: ${livres.length}, ${reais(livres.reduce((s, x) => s + livre(x), 0))} (${coberturaDoExtrato(livres)})` : "nenhuma saída do extrato pendente de vínculo",
    candidatas.length ? `contas em aberto com possível pagamento no extrato (valor igual e favorecido de nome compatível): ${candidatas.length}, ${reais(candidatas.reduce((s, x) => s + x.t.saldoCentavos, 0))} — NÃO confirmado` : "nenhuma conta em aberto com saída do extrato de valor igual e favorecido compatível",
  ];
  if (detalhe && candidatas.length) {
    linhas.push(...listarComLimite(candidatas.map((x) => x.t), (t) => {
      const s = candidatas.find((x) => x.t === t).s;
      const ref = s.length === 1 ? `saída de ${reais(s[0].valorCentavos)} em ${dataBr(s[0].data).slice(0, 5)}` : `${s.length} saídas compatíveis (ambíguo)`;
      return `${linhaDaConta(t)} ↔ ${ref}`;
    }, { limite: 1800 }));
  }
  linhas.push("conciliar = confirmar no Centro Financeiro com comprovante ou conciliação; o MOVA não dá baixa");
  return linhas;
}

/** As maiores contas em aberto (por saldo). */
export function maioresContas({ todas, detalhe, saidas = null, quantidade = 10 }) {
  const a = todas.filter(abertaComSaldo).sort((x, y) => y.saldoCentavos - x.saldoCentavos);
  if (!a.length) return ["nenhuma conta a pagar em aberto"];
  const top = a.slice(0, quantidade);
  const total = somaSaldo(a);
  const linhas = [`a pagar em aberto: ${plural(a.length, "conta", "contas")}, ${reais(total)}; as ${top.length} maiores somam ${reais(somaSaldo(top))} (${Math.round((somaSaldo(top) * 100) / total)}% do total)`];
  if (detalhe) linhas.push(...listarComLimite(top, (t) => linhaDaConta(t, { marcas: marcasDaConta(t, { todas, saidas }) })));
  return linhas;
}

/** Contas com pagamento parcial registrado e saldo ainda em aberto. */
export function contasParciais({ todas, detalhe }) {
  const p = todas.filter((t) => abertaComSaldo(t) && centavos(t.pagoCentavos) > 0).sort((a, b) => b.saldoCentavos - a.saldoCentavos);
  if (!p.length) return ["nenhuma conta com pagamento parcial em aberto"];
  const linhas = [`com pagamento parcial registrado: ${plural(p.length, "conta", "contas")}, faltam ${reais(somaSaldo(p))} (pago registrado ${reais(p.reduce((s, t) => s + t.pagoCentavos, 0))})`];
  if (detalhe) linhas.push(...listarComLimite(p, (t) => `${linhaDaConta(t)} — falta ${reais(t.saldoCentavos)}`));
  return linhas;
}

/** Fornecedores com mais contas em aberto (contagem, depois saldo). Sem fornecedor identificado = um grupo à parte. */
export function fornecedoresComPendencias({ todas, hoje, detalhe, quantidade = 8 }) {
  const a = todas.filter(abertaComSaldo);
  if (!a.length) return ["nenhuma conta a pagar em aberto"];
  const grupos = new Map();
  for (const t of a.filter(fornecedorIdentificado)) {
    const k = normalizar(t.fornecedor.nome).trim();
    const g = grupos.get(k) ?? { nome: curto(t.fornecedor.nome), contas: 0, saldo: 0, vencidas: 0 };
    g.contas += 1; g.saldo += t.saldoCentavos; if (t.vencimento && t.vencimento < hoje) g.vencidas += 1;
    grupos.set(k, g);
  }
  const semForn = a.filter((t) => !fornecedorIdentificado(t));
  const ordem = [...grupos.values()].sort((x, y) => y.contas - x.contas || y.saldo - x.saldo);
  const linhas = [`${plural(ordem.length, "fornecedor identificado", "fornecedores identificados")} com contas em aberto${semForn.length ? `; ${plural(semForn.length, "conta", "contas")} sem fornecedor identificado (${reais(somaSaldo(semForn))})` : ""}`];
  if (!detalhe) return linhas;
  linhas.push(...listarComLimite(ordem.slice(0, quantidade), (g) => `${g.nome} — ${plural(g.contas, "conta", "contas")}, ${reais(g.saldo)}${g.vencidas ? ` (${g.vencidas} vencida${g.vencidas === 1 ? "" : "s"})` : ""}`, { valor: (g) => g.saldo, nome: ["fornecedor", "fornecedores"] }));
  if (ordem.length > quantidade) linhas.push(`outros ${ordem.length - quantidade} fornecedores no Centro Financeiro`);
  return linhas;
}

// ----------------------------------------------------------------------------------------- explicação de UMA conta

/** Contas que casam com a busca: TODAS as palavras no fornecedor/descrição/categoria; valor (original, saldo ou pago); mês. */
export function buscarContas(todas, { termos = [], valorCentavos = null, competencia = null }) {
  const mesNum = competencia ? competencia.slice(5, 7) : null;
  const mesNome = mesNum ? MESES[Number(mesNum) - 1] : null;
  return todas.filter((t) => {
    if (t.situacao === "CANCELADO") return false;
    const texto = ` ${normalizar([t.fornecedor?.nome, t.descricao, t.categoria?.nome].filter(Boolean).join(" ")).replace(/[^a-z0-9/]+/g, " ")} `;
    if (!termos.every((w) => texto.includes(` ${w}`))) return false;
    if (valorCentavos && ![t.valorOriginalCentavos, t.saldoCentavos, t.pagoCentavos].includes(valorCentavos)) return false;
    if (competencia) {
      // O mês escrito na descrição ("Contabilidade 08/2026") é o da conta; só sem ele valem competência, vencimento ou o nome do mês.
      const citado = normalizar(t.descricao).match(/(?:^|[^0-9])(0[1-9]|1[0-2])\/(20\d{2}|\d{2})(?:[^0-9]|$)/);
      const noMes = citado ? citado[1] === mesNum && (citado[2].length === 2 ? `20${citado[2]}` : citado[2]) === competencia.slice(0, 4)
        : t.competencia === competencia || (t.vencimento ?? "").startsWith(competencia) || texto.includes(` ${mesNome}`);
      if (!noMes) return false;
    }
    return true;
  });
}

const ROTULO_ORIGEM = { MANUAL: "lançamento manual" };
/** Explicação de UMA conta (fatos do Financeiro e limites); várias ⇒ alternativas, sem escolher nenhuma. */
export function explicarConta({ todas, busca, hoje, saidas = null, extratoFalhou = false, pergunta = "" }) {
  const achadas = buscarContas(todas, busca);
  const procurado = [busca.termos?.join(" "), busca.valorCentavos ? reais(busca.valorCentavos) : null, busca.competencia ? `mês ${busca.competencia.slice(5, 7)}/${busca.competencia.slice(0, 4)}` : null].filter(Boolean).join(", ");
  if (!achadas.length) return [`não encontrei conta a pagar com ${procurado || "esses dados"}; confira o nome do fornecedor ou informe o valor`];
  if (achadas.length > 1) {
    const ordem = [...achadas].sort((a, b) => String(b.vencimento).localeCompare(String(a.vencimento)));
    return [`encontrei ${achadas.length} contas com ${procurado}; diga qual (valor e mês) para eu explicar:`,
      ...listarComLimite(ordem.slice(0, 8), (t) => `${t.vencimento ? dataBr(t.vencimento) : "sem vencimento"} · ${nomeDoFornecedor(t)}${descricaoSemFornecedor(t.descricao, fornecedorIdentificado(t) ? t.fornecedor.nome : null) ? ` · ${curto(descricaoSemFornecedor(t.descricao, fornecedorIdentificado(t) ? t.fornecedor.nome : null), 34)}` : ""} — ${reais(t.valorOriginalCentavos)} (${situacaoDaConta(t)})`, { valor: (t) => t.valorOriginalCentavos }),
      ...(achadas.length > 8 ? [`e mais ${achadas.length - 8} no Centro Financeiro`] : [])];
  }
  const t = achadas[0];
  const q = normalizar(pergunta);
  const pago = centavos(t.pagoCentavos) ?? 0;
  const pagamentos = t.pagamentos ?? [];
  const l = [];
  const resto = descricaoSemFornecedor(t.descricao, fornecedorIdentificado(t) ? t.fornecedor.nome : null);
  l.push(`${nomeDoFornecedor(t)}${resto ? ` · ${curto(resto, 60)}` : ""}`);
  if (/(foi|esta|ta|ja) (paga|quitada|pago)|pagou/.test(q)) {
    l.push(t.situacao === "PAGO" ? `sim: o Financeiro registra a conta como paga (${reais(pago)})`
      : pago > 0 ? `em parte: o Financeiro registra ${reais(pago)} pago e ${reais(t.saldoCentavos)} em aberto`
        : "não há pagamento registrado no Financeiro para esta conta");
  }
  l.push(`vencimento ${t.vencimento ? dataBr(t.vencimento) : "não cadastrado"}; competência ${t.competencia ? `${t.competencia.slice(5, 7)}/${t.competencia.slice(0, 4)}` : "-"}; valor ${reais(t.valorOriginalCentavos)}; pago registrado ${reais(pago)}; saldo ${reais(t.saldoCentavos)}`);
  if (abertaComSaldo(t) && t.vencimento && t.vencimento < hoje) l.push(`registrada como vencida há ${dias(t.vencimento, hoje)} dias: o vencimento passou e o saldo continua em aberto no Financeiro`);
  else l.push(`situação: ${situacaoDaConta(t)}`);
  if (pagamentos.length) l.push(`pagamentos registrados: ${pagamentos.map((p) => `${dataBr(p.data).slice(0, 5)} ${reais(p.valorCentavos)}${p.conta ? ` (${curto(p.conta, 24)})` : ""}${(p.documentos ?? []).length ? ", com comprovante" : ", sem comprovante"}`).join("; ")}`);
  l.push((t.documentos ?? []).length ? `documentos anexados: ${t.documentos.length}` : "nenhum documento anexado à conta");
  if (centavos(t.ajustesCentavos) && t.ajustesCentavos !== 0) l.push(`ajuste registrado no saldo: ${t.ajustesCentavos > 0 ? "+" : "−"}${reais(Math.abs(t.ajustesCentavos))} (revisar o motivo no Centro Financeiro)`);
  const classif = t.classificacaoEconomica === "PATRIMONIAL" ? "patrimonial (fora do resultado)" : t.classificacaoEconomica === "PENDENTE_DE_CLASSIFICACAO" ? "provisória, aguardando classificação" : "confirmada";
  l.push(`categoria ${t.categoria?.nome ?? "-"}; classificação ${classif}; origem ${ROTULO_ORIGEM[t.origem] ?? String(t.origem ?? "-").toLowerCase()}`);
  if (!fornecedorIdentificado(t)) l.push("fornecedor não identificado no cadastro: não dá para conferir o favorecido no extrato");
  const dup = possiveisDuplicidades(t, todas);
  if (dup.length) l.push(`possível duplicidade: ${dup.map((x) => `${dataBr(x.vencimento)} ${reais(x.valorOriginalCentavos)} (${situacaoDaConta(x)})`).join("; ")} — conferir antes de pagar`);
  const parecidas = contasParecidas(t, todas);
  if (parecidas.length) l.push(`conta parecida já registrada: ${parecidas.slice(0, 3).map((x) => `${curto(x.fornecedor.nome, 30)} · ${curto(descricaoSemFornecedor(x.descricao, x.fornecedor.nome) ?? "-", 30)} · ${reais(x.valorOriginalCentavos)}, venc. ${dataBr(x.vencimento)} (${situacaoDaConta(x)})`).join("; ")} — possível duplicidade, conferir antes de pagar ou cancelar`);
  if (abertaComSaldo(t)) {
    if (extratoFalhou) l.push(extratoIndisponivel);
    else if (saidas) {
      const s = saidasCompativeis(t, saidas);
      if (s.length === 1) l.push(`possível pagamento no extrato: saída de ${reais(s[0].valorCentavos)} em ${dataBr(s[0].data)} com favorecido de nome compatível — NÃO confirmado (falta comprovante ou conciliação)`);
      else if (s.length > 1) l.push(`${s.length} saídas do extrato com valor igual e favorecido compatível — ambíguo, NÃO confirmado`);
      else if (fornecedorIdentificado(t)) l.push(`nenhuma saída do extrato sem vínculo com o mesmo valor e favorecido compatível (${coberturaDoExtrato(saidas)})`);
    }
  }
  return l;
}
