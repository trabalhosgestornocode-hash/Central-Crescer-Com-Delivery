// MOVA (29/11/2026): HOMOLOGAÇÃO dos avisos de nota fiscal — individual (entregador) e consolidado no grupo financeiro — em todos os
// desfechos: conferida+anexada, aguardando anexo, divergente, duplicada, aguardando revisão e falha. Financeiro v2 real em memória,
// banco do MOVA isolado, Gateway simulado, dados sintéticos. O texto do sucesso é o modelo EXATO do proprietário.
import assert from "node:assert/strict";
import { AUTOMACAO } from "../../src/modules/mova-financeiro/index.js";
import { SITUACOES_DA_NOTA, avisoDeNotaNoGrupo, mensagemNotaConferida } from "../../src/modules/mova-financeiro/dominio/entregadores.js";
import { ALFA, ORG, t } from "./helpers/operacao.js";
import { GRUPO_ALFA, MAURICIO } from "./helpers/cenarioEntregadores.js";
import { PREST_MAURICIO, TOM_ALFA, TOM_BETA, arquivoPdf, base, enviar, xmlNota } from "./helpers/notasSinteticas.js";

const ligarGrupo = (s) => s.mova.armazenamento.automacoes.definir({ nome: AUTOMACAO.AVISO_GRUPO, organizacaoId: ORG, unidadeId: ALFA, ativa: true, horario: "00:00" });
const ok = { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 600 };
const noPrivado = async (s) => (await s.saida(MAURICIO)).map((x) => x.texto);
const noGrupo = async (s) => (await s.saida(GRUPO_ALFA)).map((x) => x.texto);

t("AN-1 nota recebida + conferida + anexada na MESMA operação: UMA só mensagem ao entregador, no modelo exato; o grupo recebe a confirmação final", async () => {
  const s = await base();
  await ligarGrupo(s);
  await enviar(s, MAURICIO, arquivoPdf(ok));
  const msgs = await noPrivado(s);
  assert.equal(msgs.length, 1, "recebimento, conferência e anexo consolidados numa só mensagem");
  const linhas = msgs[0].split("\n");
  assert.equal(linhas[0], "Olá, Mauricio! 👋");
  assert.equal(linhas[1], "✅ Sua nota fiscal foi recebida e conferida com sucesso!");
  assert.equal(linhas[2], "🏢 Empresa: Acai Alfa Sintetico");
  assert.equal(linhas[3], "📅 Período: 09/11/2026 a 15/11/2026");
  assert.equal(linhas[4], "🛵 Quantidade de entregas: 1");
  assert.equal(linhas[5], "💰 Valor: R$ 6,00");
  assert.equal(linhas[6], "📄 Nota fiscal: Conferida e anexada");
  assert.match(linhas[7], /^🗓️ Previsão de pagamento: \d{2}\/\d{2}\/\d{4}$/);
  assert.deepEqual(linhas.slice(8), ["As informações estão de acordo com o fechamento. Agora, basta aguardar o pagamento.", "Assim que ele for registrado, você receberá uma notificação por aqui.", "MOVA | Crescer com Delivery"]);
  const grupo = await noGrupo(s);
  assert.equal(grupo.length, 1);
  assert.match(grupo[0], /Nota fiscal recebida de Mauricio, semana 09\/11\/2026 a 15\/11\/2026/);
  assert.match(grupo[0], /🛵 Entregas: 1 · 💰 Valor: R\$ 6,00/);
  assert.match(grupo[0], /Situação da nota: Conferida e anexada ao Financeiro\./);
  assert.ok(!msgs[0].includes(PREST_MAURICIO) && !grupo[0].includes(PREST_MAURICIO), "documento completo nunca vai em mensagem");
});

t("AN-2 sem a identidade operacional (anexo ainda não existe): NUNCA diz 'anexada'; o grupo vê 'aguardando o anexo'", async () => {
  const s = await base({ operacional: false });
  await ligarGrupo(s);
  await enviar(s, MAURICIO, arquivoPdf(ok));
  const priv = (await noPrivado(s)).join("\n");
  assert.ok(!/anexei|anexada/i.test(priv), priv);
  const grupo = (await noGrupo(s)).join("\n");
  assert.match(grupo, /Situação da nota: Conferida; aguardando o anexo ao Financeiro\./);
  assert.ok(!/Conferida e anexada/.test(grupo));
});

t("AN-3 nota DIVERGENTE (valor diferente do fechamento): o entregador é informado do que divergiu e o grupo recebe 'divergência... revisão'", async () => {
  const s = await base();
  await ligarGrupo(s);
  await enviar(s, MAURICIO, arquivoPdf({ ...ok, valor: 650 }));
  const priv = (await noPrivado(s)).join("\n");
  assert.match(priv, /divergência/i);
  assert.ok(!/Conferida e anexada/.test(priv));
  assert.match((await noGrupo(s)).join("\n"), /Situação da nota: (Divergência encontrada|Anexada ao Financeiro com divergência); pendente de revisão do financeiro\./);
});

t("AN-4 nota DUPLICADA (mesmo arquivo; e a mesma nota em XML): resposta de duplicada, nenhum aviso novo ao grupo, nenhum anexo novo", async () => {
  const s = await base();
  await ligarGrupo(s);
  await enviar(s, MAURICIO, arquivoPdf(ok));
  const avisos = (await noGrupo(s)).length;
  await enviar(s, MAURICIO, arquivoPdf(ok));
  await enviar(s, MAURICIO, xmlNota(ok), { mime: "text/xml", nomeArquivo: "nota.xml" });
  const msgs = await noPrivado(s);
  assert.equal(msgs.length, 3);
  assert.match(msgs[1], /já tinha sido recebida/);
  assert.match(msgs[2], /já tinha sido recebida/);
  assert.equal((await noGrupo(s)).length, avisos, "o grupo não é avisado de novo");
});

t("AN-5 nota ilegível (aguardando revisão): resposta 'em análise' e o grupo vê 'aguardando revisão'", async () => {
  const s = await base();
  await ligarGrupo(s);
  await enviar(s, MAURICIO, Buffer.from("%PDF-1.4\n% arquivo sem texto de nota fiscal\n%%EOF\n"), { texto: "nota da loja alfa" });
  const priv = (await noPrivado(s)).join("\n");
  assert.match(priv, /em conferência|análise|divergência/i);
  assert.ok(!/Conferida e anexada/.test(priv));
  assert.match((await noGrupo(s)).join("\n"), /Situação da nota: (Recebida; aguardando revisão|Anexada ao Financeiro; aguardando revisão|Divergência encontrada|Anexada ao Financeiro com divergência)/);
});

t("AN-6 todos os desfechos têm texto próprio no grupo (inclusive falha e duplicada) e a ordem das linhas é fixa", () => {
  const f = { entregador: { nome: "Mauricio Sintetico" }, semanaInicio: "2026-11-09", semanaFim: "2026-11-15", entregas: 3, valorCentavos: 12345 };
  const vistos = new Set();
  for (const sit of SITUACOES_DA_NOTA) {
    const txt = avisoDeNotaNoGrupo(f, sit, { empresa: "Acai Alfa Sintetico" });
    const l = txt.split("\n");
    assert.match(l[0], /^📄 Acai Alfa Sintetico — Nota fiscal recebida de Mauricio, semana 09\/11\/2026 a 15\/11\/2026\.$/);
    assert.equal(l[1], "🛵 Entregas: 3 · 💰 Valor: R$ 123,45");
    assert.match(l[2], /^Situação da nota: /);
    vistos.add(l[2]);
  }
  assert.equal(vistos.size, SITUACOES_DA_NOTA.length, "cada desfecho tem texto distinto");
  assert.ok(SITUACOES_DA_NOTA.includes("FALHA") && SITUACOES_DA_NOTA.includes("DUPLICADA"));
});

t("AN-7 pagamento da semana JÁ registrado: a mensagem não manda 'aguardar o pagamento'", () => {
  const f = { entregador: { nome: "Mauricio Sintetico" }, semanaInicio: "2026-11-09", semanaFim: "2026-11-15", entregas: 1, valorCentavos: 600, vencimento: "2026-11-18", situacaoPagamento: "PAGO" };
  const txt = mensagemNotaConferida(f, { empresa: "Acai Alfa Sintetico" });
  assert.ok(!/aguardar o pagamento|Previsão de pagamento/.test(txt), txt);
  assert.match(txt, /pagamento desta semana já está registrado/);
  assert.match(mensagemNotaConferida({ ...f, situacaoPagamento: "ABERTO" }, { empresa: "X" }), /basta aguardar o pagamento/);
});

t("AN-8 nota da OUTRA empresa (tomador da Subway enviada para o Açaí) nunca é conferida nem anexada ao Açaí", async () => {
  const s = await base();
  await ligarGrupo(s);
  await enviar(s, MAURICIO, arquivoPdf({ ...ok, tomador: TOM_BETA }));
  const priv = (await noPrivado(s)).join("\n");
  assert.ok(!/Conferida e anexada/.test(priv));
  assert.ok(!(await noGrupo(s)).some((x) => /Conferida e anexada ao Financeiro/.test(x)));
});
