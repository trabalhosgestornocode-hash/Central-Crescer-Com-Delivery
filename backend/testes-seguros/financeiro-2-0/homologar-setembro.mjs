// HOMOLOGAÇÃO dos números de um mês contra a apresentação oficial. SOMENTE LOCAL (servidor local descartável).
// NÃO contém valor da apresentação: lê a referência de um JSON PRIVADO (FIN20_REFERENCIA) e compara com o que o SISTEMA calcula,
// consultando a mesma API que a tela usa. Nada é gravado no sistema.
//   FIN20_BASE=http://127.0.0.1:4181 FIN20_REFERENCIA=<json privado> FIN20_SAIDA=<pasta privada> node homologar-setembro.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.FIN20_BASE ?? "http://127.0.0.1:4181") + "/api/v1/gestao-financeira";
const REF = process.env.FIN20_REFERENCIA, SAIDA = process.env.FIN20_SAIDA;
if (!REF || !SAIDA) { console.error("Defina FIN20_REFERENCIA (json privado) e FIN20_SAIDA (pasta privada)."); process.exit(2); }
if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(process.env.FIN20_BASE ?? "")) { console.error("RECUSADO: só servidor local."); process.exit(2); }
const ref = JSON.parse(fs.readFileSync(REF, "utf8")), MES = ref.competencia;
const get = async (u) => { const r = await fetch(BASE + u); const j = await r.json(); if (!r.ok) throw new Error(`${u}: ${j.error}`); return j.data; };

// ------------------------------------------------------------------ dados do sistema (mesma API da tela)
const todos = async (u) => { let out = [], off = 0; for (;;) { const p = await get(`${u}&limite=200&deslocamento=${off}`); const it = p.itens ?? p; out = out.concat(it); if (it.length < 200) break; off += 200; } return out; };
const [dre, painel, canais, cp, dividas, rateios, recebiveis, plano, contasR, vendasDia, conf] = await Promise.all([
  get(`/dre-referencia?mes=${MES}`), get(`/painel?mes=${MES}`), get(`/vendas-canal?mes=${MES}`), get(`/contas-pagar?mes=${MES}`), get(`/dividas?mes=${MES}`), get(`/rateios?mes=${MES}`),
  get(`/recebiveis`), get(`/plano-contas`), get(`/contas`), get(`/vendas-diarias?mes=${MES}`), get(`/conferencias?mes=${MES}`)]);
const lanc = await todos(`/lancamentos?de=2026-08-01&ate=2026-10-31`);
const catPlano = plano.itens ?? plano, contas = contasR.itens ?? contasR;
const papel = Object.fromEntries(catPlano.map((c) => [c.id, c.papel])), nomeCat = Object.fromEntries(catPlano.map((c) => [c.id, c.nome])), nomeConta = Object.fromEntries(contas.map((c) => [c.id, c.nome]));

// ------------------------------------------------------------------ utilitários
const num = (x) => (typeof x === "number" ? x : x?.valorCentavos ?? x?.centavos ?? null);
const soma = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const achar = (arv, rotulo) => { for (const n of arv ?? []) { if (n.rotulo === rotulo || n.nome === rotulo) return n; const f = achar(n.filhos, rotulo); if (f) return f; } return null; };
const no = (rot) => num(achar(dre.arvore, rot));
const ind = dre.indicadores, pind = painel.indicadores, res = dre.resumo;
const noMes = (d) => String(d).startsWith(MES);
const lancSet = lanc.filter((l) => l.status === "realizado" && noMes(l.data_movimento));
const ehTransf = (l) => papel[l.categoria_id] === "transferencia";
const pct = (v, base) => Math.round((v / base) * 10000);
const bruto = num(ind.faturamentoBruto), cmvTotal = num(ind.cmv);
const canal = (nome) => (canais.canais ?? []).find((c) => c.canal === nome);
const obrs = cp.itens ?? [];
const pagamentosAtivos = obrs.flatMap((o) => (o.pagamentos ?? []).filter((p) => p.status === "ativo").map((p) => ({ ...p, obrigacao: o })));
const pagosSet = pagamentosAtivos.filter((p) => noMes(p.data));
const rateioParcela = (mes, descRegex) => soma(rateios.itens.filter((r) => descRegex.test(`${r.descricao ?? ""} ${r.obrigacaoDescricao ?? ""} ${(r.obrigacao ?? {}).descricao ?? ""}`)), (r) => (r.parcelas ?? []).filter((p) => p.competencia === mes).reduce((s, p) => s + p.valorCentavos, 0));
const parcelasRateio = (mes) => soma(rateios.itens, (r) => (r.parcelas ?? []).filter((p) => p.competencia === mes).reduce((s, p) => s + p.valorCentavos, 0));
const divida = (re) => dividas.itens.find((d) => re.test(d.credor));
const dMes = (d) => (d ? d.noMes.principalCentavos + d.noMes.jurosCentavos : null);
const saidaConta = (nome, { semTransferencia = false } = {}) => soma(lancSet.filter((l) => l.sentido === "saida" && nomeConta[l.conta_id] === nome && !(semTransferencia && ehTransf(l))), (l) => l.valor_centavos);
const pagoPelaConta = (nome, pred = () => true) => soma(pagosSet.filter((p) => p.conta === nome && p.origemPagamento === "conta" && pred(p)), (p) => p.valorCentavos);
const pgIfoodTaxas = pagoPelaConta("IFOOD", (p) => /TARIFA VENDAS/i.test(p.obrigacao.categoria));
const entradaIgor = soma(lanc.filter((l) => l.sentido === "entrada" && l.status === "realizado" && noMes(l.data_movimento) && /IGOR|BDC/i.test(l.descricao ?? "")), (l) => l.valor_centavos);
const saldo = (nome) => painel.saldosPorConta.find((s) => s.nome === nome)?.saldoCentavos ?? null;
const abertura = soma(painel.saldosPorConta, (s) => s.aberturaCentavos);
const pagoOut = obrs.filter((o) => String(o.vencimento).startsWith("2026-10"));
const porDesc = (arr, re) => arr.find((o) => re.test(o.descricao));
// o mesmo gasto aparece como pagamento da conta a pagar E como lançamento do extrato: conta-se uma vez (data + valor)
const naoPlan = new Set([...lancSet.filter((l) => nomeCat[l.categoria_id] === "OUTRAS DESPESAS" && l.sentido === "saida").map((l) => `${String(l.data_movimento).slice(0, 10)}|${l.valor_centavos}`), ...pagosSet.filter((p) => /OUTRAS DESPESAS/i.test(p.obrigacao.categoria)).map((p) => `${String(p.data).slice(0, 10)}|${p.valorCentavos}`)]).size;

// despesas por grupo (a apresentação separa Administrativas de Prestação de serviços)
const grupoAdm = achar(dre.arvore, "Administrativas e serviços") ?? achar(dre.arvore, "Administrativas");
const prestacao = ["PRESTADOR DE SERVIÇOS", "MARKETING"].reduce((s, r) => s + (no(r) ?? 0), 0);
const prestacaoGrupo = achar(dre.arvore, "Prestação de serviços");
const admGrupo = achar(dre.arvore, "Administrativas");

// ranking das despesas (a apresentação: 10 maiores, entregas como custo; diárias à parte; contabilidade sem a de 09/2026)
const folhas = [];
const colher = (n, dentro) => { if (!n.filhos?.length) { if (dentro) folhas.push({ rotulo: n.rotulo ?? n.nome, v: num(n) }); return; } n.filhos.forEach((f) => colher(f, dentro || /^\(−\) (Custos|Despesas fixas)/.test(n.rotulo ?? ""))); };
const top10 = (() => {
  const base = []; const add = (r, v) => v != null && base.push({ r, v });
  add("Entregas", no("Entregadores Próprios (Motoboys)") ?? no("Entregas"));
  for (const r of ["SALARIO", "FÉRIAS", "BENEFICIOS", "INSS", "FGTS", "PRESTADOR DE SERVIÇOS", "HONORARIOS ADVOCATICIOS", "ENERGIA", "ALUGUEL", "SISTEMA", "CONTABILIDADE", "MARKETING", "AGUA"]) add(r, no(r));
  return base.sort((a, b) => b.v - a.v).slice(0, 10);
})();

// ------------------------------------------------------------------ catálogo: chave → { v: valor calculado pelo sistema, regra, fonte, pendencia?, nota? }
const C = {};
const def = (k, v, regra, fonte, extra = {}) => { C[k] = { v, regra, fonte, ...extra }; };
// slide 2
def("bruto", bruto, "soma das vendas diárias registradas no mês", "Vendas Diárias (fin_referencias)");
def("ded.simples", no("SIMPLES NACIONAL"), "obrigação tributária paga (DAS), por pagamento", "Contas a Pagar");
def("ded.taxasIfood", pgIfoodTaxas || (no("TARIFA VENDAS") != null ? no("TARIFA VENDAS") - soma(lancSet.filter((l) => nomeCat[l.categoria_id] === "TARIFA VENDAS"), (l) => l.valor_centavos) : null), "taxas do iFood = contas a pagar da categoria TARIFA VENDAS pagas pela conta iFood", "Contas a Pagar");
def("ded.antecipacao", no("TAXA DE ANTECIPAÇÃO"), "taxa de antecipação do iFood, por pagamento", "Contas a Pagar");
def("ded.tarifaStone", soma(lancSet.filter((l) => nomeCat[l.categoria_id] === "TARIFA VENDAS"), (l) => l.valor_centavos), "tarifa da adquirente (Stone) sobre vendas em cartão", "Fluxo de Caixa (Stone)");
def("ded.total", num(res.deducoes), "Σ deduções (Simples + taxas sobre vendas)", "DRE");
def("liquido", num(ind.faturamentoLiquido), "bruto − deduções", "DRE");
// slide 3
for (const [id, nome] of [["balcao", "Balcão"], ["ifood", "iFood"], ["anota", "Anota Aí"]]) {
  const c = canal(nome);
  def(`canal.${id}.valor`, c?.gerencialCentavos ?? null, "faturamento por canal na base da DRE (painel + ajustes)", "Faturamento por canal", id === "ifood" ? { pendencia: "ajuste do iFood ainda ESTIMADO, a confirmar no Portal do Parceiro" } : {});
  def(`canal.${id}.vendas`, c?.vendasQtd ?? null, "quantidade de vendas informada no relatório por canal", "Faturamento por canal");
  def(`canal.${id}.ticket`, c ? Math.round(c.gerencialCentavos / c.vendasQtd) : null, "faturamento ÷ vendas", "calculado");
}
def("canal.total.vendas", soma(canais.canais ?? [], (c) => c.vendasQtd), "Σ vendas dos canais", "Faturamento por canal");
def("canal.total.ticket", Math.round(bruto / soma(canais.canais ?? [], (c) => c.vendasQtd)), "bruto ÷ total de vendas", "calculado");
def("painel.ifood", canal("iFood")?.painelCentavos ?? null, "total do iFood no painel SAIPOS (antes dos ajustes)", "Faturamento por canal");
def("painel.anota", canal("Anota Aí")?.painelCentavos ?? null, "total do Anota Aí no painel SAIPOS (antes dos ajustes)", "Faturamento por canal");
def("painel.total", soma(canais.canais ?? [], (c) => c.painelCentavos), "Σ painel SAIPOS", "Faturamento por canal");
const ajs = (canais.canais ?? []).flatMap((c) => (c.ajustes ?? []).map((a) => ({ ...a, canal: c.canal })));
def("ajuste.ifood", Math.abs(soma(ajs.filter((a) => a.canal === "iFood"), (a) => a.valorCentavos)), "ajuste painel → base gerencial (iFood)", "Ajustes de vendas", { pendencia: "ESTIMADO (apresentação, slide 3): confirmar com evidência do Portal do Parceiro" });
def("ajuste.anotaEntrega", Math.abs(soma(ajs.filter((a) => a.canal === "Anota Aí" && /entrega/i.test(a.descricao ?? a.tipo ?? "")), (a) => a.valorCentavos)), "taxas de entrega do Anota Aí", "Ajustes de vendas");
def("ajuste.anotaDesc", Math.abs(soma(ajs.filter((a) => a.canal === "Anota Aí" && /desconto/i.test(a.descricao ?? a.tipo ?? "")), (a) => a.valorCentavos)), "descontos do Anota Aí", "Ajustes de vendas");
// Vendas Diárias (tabela SAIPOS importada)
const vdi = vendasDia.indicadores;
def("vd.bruto", vdi.totalVendaBrutaCentavos, "Σ vendas diárias registradas", "Vendas Diárias"); def("vd.especie", vdi.totalEspecieCentavos, "Σ recebido em espécie", "Vendas Diárias"); def("vd.sangria", vdi.totalSangriaCentavos, "Σ sangrias informadas", "Vendas Diárias");
def("vd.dias", vdi.diasRegistrados, "dias com venda registrada", "Vendas Diárias");
def("vd.divergentes", vdi.divergentes, "dias em que o informado difere do caixa físico (dia · campo · valor na tela)", "Vendas Diárias × Fluxo de Caixa", { pendencia: "sangrias divergentes: destino/valor a decidir (caixa não ajustado)" });
// slide 4
def("dre.deducoes", num(res.deducoes), "Σ deduções", "DRE"); def("dre.custos", num(res.custos), "CMV + entregas", "DRE"); def("dre.despesas", num(res.despesas), "variáveis + fixas", "DRE"); def("dre.resultado", num(res.resultado), "margem de contribuição − despesas fixas", "DRE");
const cm = { distribuidora: "INSUMOS - DISTRIBUIDORA", frutas: "INSUMOS - FRUTAS", supermercado: "INSUMOS - SUPERMERCADO", descartaveis: "DESCARTAVEIS", brownies: "INSUMOS - BROWNIES", mix: "INSUMOS - MIX", sucos: "INSUMOS - SUCO" };
for (const [k, r] of Object.entries(cm)) { def(`cmv.${k}`, no(r), "compra recebida no mês (proporcional na virada) — CMV por categoria", "Contas a Pagar + rateios propostos", { pendencia: k === "distribuidora" || k === "frutas" ? "parte do mês depende de rateio PROPOSTO (aguarda aprovação)" : undefined }); def(`cmv9.${k}`, pct(no(r), cmvTotal), "categoria ÷ CMV total", "calculado"); }
def("cmv.total", cmvTotal, "Σ categorias do CMV", "DRE"); def("entregas", num(ind.entregas), "entregadores por produção de setembro", "Contas a Pagar + rateios propostos", { pendencia: "parcela de virada de mês depende de rateio PROPOSTO" });
def("desp.pessoal", no("Pessoal"), "pessoal por pagamento", "Contas a Pagar");
def("desp.prestacao", prestacaoGrupo ? num(prestacaoGrupo) : prestacao, "Prestação de serviços (prestador + marketing)", "Contas a Pagar");
def("desp.administrativas", admGrupo ? num(admGrupo) : (num(grupoAdm) - prestacao), "administrativas = grupo − prestação de serviços", "Contas a Pagar");
def("desp.diarias", no("DIARIA"), "diárias de extras (despesa variável)", "Fluxo de Caixa"); def("desp.naoProgramadas", no("OUTRAS DESPESAS"), "pagamentos não planejados (despesa variável)", "Contas a Pagar / Fluxo");
def("desp.financeiras", no("Financeiras e tarifas"), "tarifas e encargos", "Contas a Pagar");
// slide 5
for (const [k, r] of [["salarios", "SALARIO"], ["inss", "INSS"], ["fgts", "FGTS"], ["beneficios", "BENEFICIOS"], ["ferias", "FÉRIAS"], ["exame", "EXAME ADMISSIONAL/DEMISSIONAL"]]) def(`pessoal.${k}`, no(r), `pessoal — ${r}`, "Contas a Pagar", k === "beneficios" ? { pendencia: "inclui pagamento com ORIGEM PENDENTE (conta de saída desconhecida)" } : {});
def("pessoal.total", no("Pessoal"), "Σ itens de pessoal", "DRE"); def("pessoal.sobra", bruto - no("Pessoal"), "bruto − pessoal", "calculado"); def("pessoal.encargos", (no("INSS") ?? 0) + (no("FGTS") ?? 0), "INSS + FGTS", "calculado"); def("pessoal.diarias", no("DIARIA"), "diárias à parte", "Fluxo de Caixa");
def("pessoal.colaboradores", null, "quantidade de colaboradores", "NÃO EXISTE cadastro de colaboradores no sistema", { semDado: "o sistema não registra o quadro de colaboradores; valor informado só na apresentação" });
// slide 6
const north = recebiveis.itens?.find((r) => /north/i.test(`${r.contraparte} ${r.descricao}`));
def("prog.previsto", soma(obrs, (o) => o.valorOriginalCentavos) + (north?.valorOriginalCentavos ?? 0), "Σ valor previsto das contas a pagar + retenções do iFood (empréstimo do North), sem transferências", "Contas a Pagar + Contas a Receber");
const viradaForaDoMes = soma(rateios.itens, (r) => (r.parcelas ?? []).filter((p) => p.competencia !== MES).reduce((s, p) => s + p.valorCentavos, 0));
const virada = viradaForaDoMes;
def("prog.realizado", soma(obrs, (o) => o.pagoCentavos) + (north?.valorOriginalCentavos ?? 0) - virada, "Σ pago − partes de agosto e de outubro das contas da virada de mês (rateios)", "Contas a Pagar + rateios propostos", { pendencia: "depende dos 5 rateios PROPOSTOS (aguardam aprovação da contadora)" });
def("prog.diferenca", C["prog.previsto"].v - C["prog.realizado"].v, "previsto − realizado", "calculado", { pendencia: "depende dos rateios propostos" });
def("prog.virada", virada, "partes de agosto e de outubro das contas da virada de mês (rateios propostos)", "Rateios", { pendencia: "rateios PROPOSTOS" });
def("prog.menorQuePrevisto", null, "folha/férias/FGTS/VT pagos abaixo do previsto", "Contas a Pagar", { calcular: () => { const abaixo = soma(obrs.filter((o) => o.pagoCentavos > 0 && o.pagoCentavos < o.valorOriginalCentavos && /Pessoal|SALARIO|FÉRIAS|FGTS|BENEFICIOS/i.test(o.categoria)), (o) => o.valorOriginalCentavos - o.pagoCentavos); return abaixo; } });
const contab = (m) => obrs.find((o) => /Contabilidade/i.test(o.descricao) && o.descricao.includes(m));
def("juros.contab08", contab("08/2026") ? contab("08/2026").pagoCentavos - contab("08/2026").valorOriginalCentavos : null, "pago − previsto (Contabilidade 08/2026, paga em 02/09)", "Contas a Pagar", { pendencia: "acréscimo PRESUMIDO: classificação (juros/multa/tarifa) aguarda decisão" });
def("juros.contab09", contab("09/2026") ? contab("09/2026").pagoCentavos - contab("09/2026").valorOriginalCentavos : null, "pago − previsto (Contabilidade 09/2026, paga em 01/10)", "Contas a Pagar", { pendencia: "acréscimo PRESUMIDO: classificação aguarda decisão" });
def("juros.total", (C["juros.contab08"].v ?? 0) + (C["juros.contab09"].v ?? 0), "Σ dos dois acréscimos", "calculado");
// slide 7
def("naoPlan.total", no("OUTRAS DESPESAS"), "pagamentos não programados", "Contas a Pagar / Fluxo"); def("naoPlan.qtd", naoPlan, "quantidade de pagamentos não programados no mês", "Contas a Pagar / Fluxo");
// slide 8
def("top10.total", soma(top10, (x) => x.v), `10 maiores categorias de despesa/entregas: ${top10.map((x) => x.r).join(", ")}`, "DRE", { nota: "o ranking da apresentação usa o nível 'Conta' da planilha; o sistema ordena por categoria", pendencia: null });
// slide 10
const dv = { reforma: /Reforma/i, igor: /Igor/i, santander: /Santander/i, francisca: /Francisca/i, simples: /Federal|Simples/i };
for (const [k, re] of Object.entries(dv)) def(`div.${k}`, k === "reforma" ? (divida(re)?.noMes.principalCentavos ?? null) : dMes(divida(re)), `parcelas pagas em setembro (principal + juros), ${k}`, "Dívidas e Empréstimos");
def("div.encargos", divida(/Reforma/i)?.noMes.encargosCentavos ?? null, "seguro prestamista", "Dívidas e Empréstimos");
def("div.total", ["reforma", "igor", "santander", "francisca", "simples"].reduce((s, k) => s + (C[`div.${k}`].v ?? 0), 0) + (C["div.encargos"].v ?? 0), "Σ endividamento do mês", "calculado");
def("div.northRetido", north?.valorOriginalCentavos ?? null, "valor retido pelo iFood do Açaí (empréstimo do North) — fora do endividamento próprio", "Contas a Receber");
// slide 11 / 16 / 17
def("ind.bruto", bruto, "bruto", "DRE"); def("ind.liquido", num(ind.faturamentoLiquido), "líquido", "DRE"); def("ind.custos", num(ind.custosTotais), "custos", "DRE"); def("ind.variaveis", num(ind.despesasVariaveis), "variáveis", "DRE");
def("ind.mc", num(ind.margemContribuicao), "líquido − custos − variáveis", "DRE"); def("ind.fixas", num(ind.despesasFixas), "fixas", "DRE"); def("ind.resultado", num(ind.resultadoGerencial), "MC − fixas", "DRE");
def("ind.margemLiquida", Math.round(num(ind.resultadoGerencial) / bruto * 10000), "lucro ÷ bruto", "calculado"); def("ind.pe", num(ind.pontoEquilibrio), "fixas ÷ (MC ÷ faturamento)", "DRE");
def("ind.peFin", num(ind.pontoEquilibrioFinanceiro), "(fixas + parcelas de dívida) ÷ (MC ÷ faturamento)", "DRE");
def("meta.faturamentoDia", Math.round(bruto / 30), "faturamento ÷ 30", "calculado"); def("meta.peFinDia", Math.round(num(ind.pontoEquilibrioFinanceiro) / 30), "PE financeiro ÷ 30", "calculado");
def("meta.folga", bruto - num(ind.pontoEquilibrioFinanceiro), "faturamento − PE financeiro", "calculado"); def("meta.folgaDia", Math.round((bruto - num(ind.pontoEquilibrioFinanceiro)) / 30), "folga ÷ 30", "calculado");
def("meta.peDia", Math.round(num(ind.pontoEquilibrio) / 30), "PE ÷ 30", "calculado");
def("meta.margemSegFin", Math.round((bruto - num(ind.pontoEquilibrioFinanceiro)) / bruto * 10000), "(faturamento − PE fin.) ÷ faturamento", "calculado"); def("meta.margemSeg", Math.round((bruto - num(ind.pontoEquilibrio)) / bruto * 10000), "(faturamento − PE) ÷ faturamento", "calculado");
def("fim.cmvPct", pct(cmvTotal, bruto), "CMV ÷ bruto", "calculado"); def("fim.pessoalPct", pct(no("Pessoal"), bruto), "pessoal ÷ bruto", "calculado"); def("fim.cadaPontoCmv", Math.round(bruto / 100), "1% do faturamento", "calculado");
// slide 12
// distribuidora paga por TERCEIRO (sócia): a parte de setembro dela está no CMV mas não saiu do caixa da empresa (rateio proposto)
const obrTerceiro = new Set(pagamentosAtivos.filter((p) => p.origemPagamento === "terceiro").map((p) => p.obrigacao.id));
const parcelaDoMes = (r) => (r.parcelas ?? []).find((p) => p.competencia === MES)?.valorCentavos ?? 0;
const parte28 = soma(rateios.itens.filter((r) => obrTerceiro.has(r.obrigacaoId)), parcelaDoMes);
def("cmv9.distribParteSetembro", parte28, "parte de setembro da distribuidora de 28/08 (rateio proposto 3 ÷ 7)", "Rateios", { pendencia: "rateio PROPOSTO" });
const agoPagas = soma(pagosSet.filter((p) => p.obrigacao.competencia === "2026-08" && !/Folha|INSS|FGTS|Simples|Contabilidade|Saude|Sa[uú]de|Ferias|Férias/i.test(p.obrigacao.descricao)), (p) => p.valorCentavos);
const agoRateio = soma(rateios.itens, (r) => (r.parcelas ?? []).filter((p) => p.competencia === "2026-08").reduce((s, p) => s + p.valorCentavos, 0));
const agoLista = (re) => { const o = obrs.find((x) => re.test(x.descricao) && x.pagamentos?.some((p) => p.status === "ativo" && noMes(p.data))); return o ? soma(o.pagamentos.filter((p) => p.status === "ativo" && noMes(p.data)), (p) => p.valorCentavos) : null; };
def("ago.entregas2408", agoLista(/Entregas.*24 a 30\/08/i), "pago em setembro, competência agosto", "Contas a Pagar");
def("ago.morangos", agoLista(/Morangos.*26 a 31\/08/i), "pago em setembro, competência agosto", "Contas a Pagar");
def("ago.distrib2308", agoLista(/Distribuidora.*23\/08/i), "pago em setembro, competência agosto", "Contas a Pagar");
const entregasVirada = rateios.itens.filter((r) => /Entregas/i.test(r.obrigacao?.descricao ?? "") && (r.parcelas ?? []).some((p) => p.competencia < MES));
def("ago.entregas3108", soma(entregasVirada, (r) => (r.parcelas ?? []).filter((p) => p.competencia < MES).reduce((s, p) => s + p.valorCentavos, 0)) || null, "parte de AGOSTO das entregas da virada de mês (rateio proposto)", "Rateios", { pendencia: "rateio PROPOSTO" });
def("ago.total", [C["ago.entregas2408"].v, C["ago.morangos"].v, C["ago.distrib2308"].v, C["ago.entregas3108"].v].reduce((s, v) => s + (v ?? 0), 0), "Σ contas de agosto pagas em setembro", "calculado", { pendencia: "inclui parte de rateio PROPOSTO" });
// slide 14
const o14 = (re) => obrs.find((o) => re.test(o.descricao) && String(o.vencimento).startsWith("2026-10"));
const d24 = obrs.filter((o) => /Distribuidora/i.test(o.descricao) && String(o.vencimento).startsWith("2026-10")).map((o) => o.pagoCentavos).sort((a, b) => b - a);
def("out.distrib1", d24[0] ?? null, "pago em outubro, competência setembro", "Contas a Pagar"); def("out.distrib2", d24[1] ?? null, "pago em outubro, competência setembro", "Contas a Pagar");
for (const [k, re] of [["frutas", /Frutas/i], ["entregas", /Entregas/i], ["morangos", /Morangos/i]]) {
  const o = o14(re); def(`out.${k}`, o?.pagoCentavos ?? null, "pago em outubro, competência setembro", "Contas a Pagar");
  const rat = o ? rateios.itens.find((r) => r.obrigacaoId === o.id) : null;
  def(`out.${k}.res`, rat ? parcelaDoMes(rat) : null, "parte de setembro no resultado (rateio proposto)", "Rateios", { pendencia: "rateio PROPOSTO" });
}
def("out.total", soma(pagoOut.filter((o) => /Distribuidora|Frutas|Entregas|Morangos/i.test(o.descricao)), (o) => o.pagoCentavos), "Σ pago em outubro (competência setembro)", "Contas a Pagar");
def("out.total.res", (C["out.distrib1"].v ?? 0) + (C["out.distrib2"].v ?? 0) + (C["out.frutas.res"].v ?? 0) + (C["out.entregas.res"].v ?? 0) + (C["out.morangos.res"].v ?? 0), "parte de setembro das contas pagas em outubro", "calculado", { pendencia: "inclui rateios PROPOSTOS" });
def("out.contab09", contab("09/2026")?.pagoCentavos ?? null, "Contabilidade 09/2026 paga em 01/10 (com acréscimo)", "Contas a Pagar");
def("out.folha09", soma(obrs.filter((o) => /Folha/i.test(o.descricao) && o.competencia === "2026-09"), (o) => o.pagoCentavos) || null, "Folha de pagamento 09/2026 paga em outubro", "Contas a Pagar");
def("out.francisca2", soma((divida(/Francisca/i)?.eventos ?? []).filter((e) => e.tipo === "amortizacao" && String(e.data).startsWith("2026-10") && e.status === "ativo"), (e) => e.principalCentavos) || null, "2ª parcela do empréstimo da sócia (13/10)", "Dívidas e Empréstimos");
def("out.energia09", obrs.find((o) => /Energia/i.test(o.descricao) && o.competencia === "2026-09")?.valorOriginalCentavos ?? null, "Energia 09/2026 em aberto", "Contas a Pagar");
// slide 12 (saídas por conta) e 15 (saldos)
def("saida.unicred", saidaConta("UNICRED"), "Σ saídas realizadas da Unicred AF (inclui transferências a terceiros/MP)", "Fluxo de Caixa");
def("saida.ifood", saidaConta("IFOOD", { semTransferencia: true }) + pgIfoodTaxas, "saídas do iFood sem os Pix para a Unicred + taxas do iFood pagas pela conta", "Fluxo de Caixa + Contas a Pagar");
def("saida.caixa", saidaConta("CAIXA", { semTransferencia: true }), "saídas do caixa da loja sem os depósitos na Unicred", "Fluxo de Caixa");
def("saida.stone", saidaConta("STONE", { semTransferencia: true }), "saídas da Stone sem os Pix para a Unicred", "Fluxo de Caixa");
def("saida.santander", pagoPelaConta("SANTANDER"), "pagamentos pela conta Santander (taxa de manutenção)", "Contas a Pagar");
def("saida.saude", soma(pagamentosAtivos.filter((p) => p.origemPagamento === "origem_pendente" && noMes(p.data)), (p) => p.valorCentavos), "pagamento com origem pendente (saúde do trabalhador, 11/09)", "Contas a Pagar", { pendencia: "ORIGEM PENDENTE: de qual conta saiu?" });
def("ponte.totalPago", ["unicred", "ifood", "caixa", "stone", "santander", "saude"].reduce((s, k) => s + (C[`saida.${k}`].v ?? 0), 0), "Σ saídas por conta (sem transferências internas)", "calculado");
def("ponte.resultadoSet", num(res.deducoes) + num(res.custos) + num(res.despesas), "deduções + custos + despesas", "DRE");
def("ponte.setPagasOut", C["out.total.res"].v, "contas de setembro pagas só em outubro (parte no resultado)", "calculado", { pendencia: "inclui rateios PROPOSTOS" });
def("ponte.distribSocia", parte28, "parte de setembro da distribuidora 28/08 paga pela sócia", "Rateios", { pendencia: "rateio PROPOSTO" });
def("ponte.agoPagasSet", C["ago.total"].v, "contas de agosto pagas em setembro", "calculado", { pendencia: "inclui rateio PROPOSTO" });
def("ponte.naoCustoDespesa", null, "saídas que não são custo nem despesa (dívidas, sócia, North, MP, rescisão)", "calculado", { calcular: () => C["ponte.totalPago"].v - (C["ponte.resultadoSet"].v - C["ponte.setPagasOut"].v - C["ponte.distribSocia"].v + C["ponte.agoPagasSet"].v) });
def("saldo.unicred", saldo("UNICRED"), "abertura + entradas − saídas", "Fluxo de Caixa"); def("saldo.stone", saldo("STONE"), "abertura + entradas − saídas", "Fluxo de Caixa"); def("saldo.ifood", saldo("IFOOD"), "abertura + entradas − saídas", "Fluxo de Caixa");
def("saldo.caixa", saldo("CAIXA"), "abertura + entradas − saídas (SALDO CALCULADO; a contagem do caixa não é registrada)", "Fluxo de Caixa", { pendencia: "saldo CONTADO do caixa ainda não é registrado: a diferença fica decomposta (contagens divergentes e valor sem destino)" });
def("saldo.total", num(pind.saldoDisponivel), "Σ saldos calculados das contas", "Fluxo de Caixa", { pendencia: "mesma diferença do caixa da loja" });
def("cx.saldo3108", abertura, "Σ saldos de abertura", "Saldos de abertura");
def("cx.lucro", num(ind.resultadoGerencial), "lucro gerencial", "DRE"); def("cx.setPagasOut", C["out.total.res"].v, "contas de setembro pagas só em outubro", "calculado", { pendencia: "rateios PROPOSTOS" });
def("cx.distribSocia", parte28, "parte de setembro da distribuidora 28/08 (sócia)", "Rateios", { pendencia: "rateio PROPOSTO" }); def("cx.agoPagasSet", -C["ago.total"].v, "contas de agosto pagas em setembro", "calculado", { pendencia: "rateio PROPOSTO" });
def("cx.francisca", -(divida(/Francisca/i)?.eventos ?? []).filter((e) => e.tipo === "amortizacao" && noMes(e.data) && e.status === "ativo").reduce((s, e) => s + e.principalCentavos, 0), "1ª parcela devolvida à sócia (28/09)", "Dívidas e Empréstimos");
def("cx.parcelas", -num(ind.parcelasDivida), "parcelas de empréstimos e parcelamentos", "Dívidas e Empréstimos"); def("cx.igorEntrada", entradaIgor, "entrada de empréstimo (não é venda)", "Fluxo de Caixa");
def("cx.north", -(north?.pendenteCentavos ?? 0), "retido − devolvido (a receber do North)", "Contas a Receber");
const mpEnv = soma(lancSet.filter((l) => l.sentido === "saida" && /MP ALIMENTOS|RESCIS/i.test(l.descricao ?? "") && ehTransf(l) && nomeConta[l.conta_id] !== "CAIXA"), (l) => l.valor_centavos), depositosCaixa = new Set(lancSet.filter((l) => l.sentido === "saida" && nomeConta[l.conta_id] === "CAIXA" && ehTransf(l)).map((l) => `${String(l.data_movimento).slice(0, 10)}|${l.valor_centavos}`)),
  mpRec = soma(lancSet.filter((l) => l.sentido === "entrada" && /MP ALIMENTOS/i.test(l.descricao ?? "") && !depositosCaixa.has(`${String(l.data_movimento).slice(0, 10)}|${l.valor_centavos}`)), (l) => l.valor_centavos);   // depósito do caixa na Unicred não é transferência da MP
def("cx.mp", -(mpEnv - mpRec), "transferências para a MP: enviados − recebidos", "Fluxo de Caixa", { pendencia: "há Pix classificado como transferência para a MP no extrato e como despesa na planilha de Contas a Pagar; entrada a confirmar" });
def("cx.variacao", saldo("UNICRED") + saldo("STONE") + saldo("IFOOD") + saldo("CAIXA") - abertura, "saldo final − saldo inicial (calculados)", "Fluxo de Caixa", { pendencia: "mesma diferença do caixa da loja" });
def("cx.outras", null, "outras entradas e diferenças = resíduo da ponte", "calculado", { calcular: () => C["cx.variacao"].v - ["lucro", "setPagasOut", "distribSocia", "agoPagasSet", "francisca", "parcelas", "igorEntrada", "north", "mp"].reduce((s, k) => s + (C[`cx.${k}`].v ?? 0), 0), pendencia: "resíduo: inclui Pix do Igor a confirmar e caixa sem destino" });

for (const k of Object.keys(C)) if (C[k].calcular) C[k].v = C[k].calcular();

// motivos EXATOS das diferenças que permanecem (nada foi ajustado para fazê-las coincidir)
const MOTIVO = ref.motivos ?? {};   // texto das diferenças que permanecem: fica na referência PRIVADA (contém valores)
// ------------------------------------------------------------------ comparação
const brl = (c, u) => (c == null ? "—" : u === "n" ? String(c) : u === "b" ? (c / 100).toFixed(1).replace(".", ",") + "%" : (c < 0 ? "−" : "") + "R$ " + (Math.abs(c) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
const linhas = ref.itens.map((it) => {
  const s = C[it.k]; const sis = s?.v ?? null; const dif = sis == null ? null : sis - it.v;
  const tol = it.u === "b" ? 10 : it.u === "n" ? 0 : 1;           // % mostrado com 1 casa; centavos exatos (±1 de arredondamento)
  const confere = sis != null && Math.abs(dif) <= tol;
  const situacao = sis == null ? "SEM CÁLCULO NO SISTEMA" : confere ? "CONFERE" : "DIFERE";
  const classe = sis == null ? "D" : confere ? (s.pendencia ? "C" : "A") : "D";
  return { slide: it.s, chave: it.k, referencia: it.r, apresentacao: it.v, unidade: it.u, sistema: sis, diferenca: dif,
    difPct: it.u === "c" && it.v ? Math.round((dif / Math.abs(it.v)) * 10000) / 100 : null, situacao, classe,
    regra: s?.regra ?? "—", fonte: s?.fonte ?? "—", pendencia: s?.pendencia ?? s?.semDado ?? null, nota: s?.nota ?? null, motivo: classe === "D" ? (MOTIVO[it.k] ?? "DIFERENÇA SEM EXPLICAÇÃO REGISTRADA") : null };
});
// percentuais (apresentação: 1 casa decimal sobre o faturamento bruto): conferidos como linhas próprias
for (const it of ref.itens.filter((x) => x.pct != null && x.u === "c")) {
  const base = linhas.find((l) => l.chave === it.k); const sis = base?.sistema == null ? null : Math.round((base.sistema / bruto) * 1000) * 10;
  const confere = sis != null && sis === it.pct;
  linhas.push({ slide: it.s, chave: it.k + ".pct", referencia: it.r + " — % do bruto", apresentacao: it.pct, unidade: "b", sistema: sis, diferenca: sis == null ? null : sis - it.pct, difPct: null,
    situacao: sis == null ? "SEM CÁLCULO NO SISTEMA" : confere ? "CONFERE" : "DIFERE", classe: sis == null ? "D" : confere ? (base.classe === "C" ? "C" : base.classe === "D" ? "D" : "A") : "D",
    regra: "valor ÷ faturamento bruto, 1 casa decimal", fonte: "calculado", pendencia: base?.pendencia ?? null, nota: null, motivo: confere ? null : (base?.motivo ?? "percentual difere") });
}
linhas.sort((a, b) => a.slide - b.slide);
fs.mkdirSync(SAIDA, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(SAIDA, `matriz-homologacao-${MES}.json`), JSON.stringify({ gerada: new Date().toISOString(), competencia: MES, linhas, top10: top10 }, null, 1));
const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(SAIDA, `matriz-homologacao-${MES}.csv`), "﻿" + ["slide;referencia;apresentacao;sistema;diferenca;dif%;situacao;classe;regra;fonte;pendencia"].concat(linhas.map((l) => [l.slide, esc(l.referencia), brl(l.apresentacao, l.unidade), brl(l.sistema, l.unidade), l.diferenca == null ? "" : brl(l.diferenca, l.unidade), l.difPct ?? "", l.situacao, l.classe, esc(l.regra), esc(l.fonte), esc(l.motivo ?? l.pendencia)].join(";"))).join("\n"));
const n = (f) => linhas.filter(f).length;
const md = [`# Homologação ${MES} — sistema × apresentação oficial (PRIVADO)`, `Gerada em ${stamp} · ${linhas.length} referências dos 17 slides.`, "",
  `**A** confere e é homologável: ${n((l) => l.classe === "A")} · **C** confere numericamente mas depende de decisão/aprovação: ${n((l) => l.classe === "C")} · **D** diferença ou sem cálculo: ${n((l) => l.classe === "D")}`, "",
  "| Slide | Referência | Apresentação | Sistema | Diferença | Situação | Classe | Observação |", "|---|---|---:|---:|---:|---|:-:|---|"]
  .concat(linhas.map((l) => `| ${l.slide} | ${l.referencia} | ${brl(l.apresentacao, l.unidade)} | ${brl(l.sistema, l.unidade)} | ${l.diferenca == null ? "—" : brl(l.diferenca, l.unidade)} | ${l.situacao} | ${l.classe} | ${l.motivo ?? l.pendencia ?? ""} |`)).join("\n");
fs.writeFileSync(path.join(SAIDA, `matriz-homologacao-${MES}.md`), md);
console.log(`A=${n((l) => l.classe === "A")}  C=${n((l) => l.classe === "C")}  D=${n((l) => l.classe === "D")}  total=${linhas.length}`);
for (const l of linhas.filter((x) => x.classe === "D")) console.log(`D slide ${l.slide} ${l.referencia}: apresentação ${brl(l.apresentacao, l.unidade)} · sistema ${brl(l.sistema, l.unidade)} · dif ${l.diferenca == null ? "—" : brl(l.diferenca, l.unidade)} :: ${String(l.motivo).slice(0, 70)}`);
