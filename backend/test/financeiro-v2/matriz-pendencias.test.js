// Execução 09 — a MATRIZ DAS PENDÊNCIAS (docs/financeiro-v2/22a) amarrada ao código: todo código existe no documento,
// o efeito no resultado de cada um é o esperado pela matriz e a regra de admissibilidade vale para cada código.
// Mudar a regra de um código sem atualizar a matriz faz este teste falhar (e vice-versa).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EFEITO_POR_CODIGO, avaliarPendenciasDoFechamento, efeitoNoResultado } from "../../src/modules/financeiro-v2/dominio/ressalvas.js";

const raiz = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const matriz = readFileSync(join(raiz, "docs", "financeiro-v2", "22a-matriz-pendencias.md"), "utf8");
const conferencias = readFileSync(join(raiz, "backend", "src", "modules", "financeiro-v2", "dominio", "conferencias.js"), "utf8");

/** O que a matriz (doc 22a) diz — versão de 14/11/2026, ainda NÃO aprovada pela empresa. */
const ESPERADO = Object.freeze({
  SEM_EFEITO: ["VENDA_SEM_PAGAMENTO", "PAGAMENTO_INCOMPATIVEL", "RECEBIMENTO_DIRETO_NAO_IDENTIFICADO", "RECEBIVEL_SEM_REPASSE", "RECEBIVEL_ATRASADO", "REPASSE_INFORMADO_SEM_CREDITO", "CREDITO_SEM_COMPROVACAO_BANCARIA", "CORRESPONDENCIA_A_DECIDIR", "DIFERENCA_DE_CAIXA", "VENDA_SEM_CANAL", "IMPORTACAO_COM_PENDENCIAS", "FONTE_SEM_DOCUMENTO"],
  CONHECIDO: ["OBRIGACAO_SEM_COMPROVANTE", "TOTAIS_DE_RELATORIOS_DIFERENTES", "CREDITO_NAO_IDENTIFICADO", "TRANSACAO_SEM_PEDIDO"],
  INDETERMINADO: ["DESPESA_A_CLASSIFICAR", "DESCONTO_A_CLASSIFICAR", "SAIDA_SEM_CLASSIFICACAO", "PROPOSTA_EM_ABERTO", "IMPORTACAO_A_REVISAR", "SOBREPOSICAO_AGREGADO_PEDIDOS", "SALDO_DIVERGENTE", "TAXA_OU_VALOR_DIVERGENTE"],
});
const IMPEDIMENTOS = ["DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA", "SALDO_DE_CONTA_DIVERGENTE", "RECEITA_EM_DUPLICIDADE", "CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO", "CLASSIFICACAO_PROVISORIA", "OPERACOES_IMPORTADAS_PENDENTES", "IMPORTACAO_NAO_CONCLUIDA"];

test("matriz × código: todo código da tabela de efeitos e todo impedimento estão no doc 22a, e o efeito de cada um é o da matriz", () => {
  const doCodigo = Object.keys(EFEITO_POR_CODIGO).sort();
  const daMatriz = Object.values(ESPERADO).flat().sort();
  assert.deepEqual(doCodigo, daMatriz, "código novo (ou removido) na tabela de efeitos: atualizar a matriz");
  for (const [efeito, codigos] of Object.entries(ESPERADO)) for (const c of codigos) assert.equal(EFEITO_POR_CODIGO[c], efeito, c);
  for (const c of [...doCodigo, ...IMPEDIMENTOS]) assert.ok(matriz.includes(`\`${c}\``), `${c} ausente do doc 22a`);
  for (const c of IMPEDIMENTOS) assert.ok(conferencias.includes(`"${c}"`), `${c} não é mais gerado pelo núcleo`);
  assert.equal(efeitoNoResultado("CODIGO_QUE_NAO_EXISTE"), "INDETERMINADO", "desconhecido = lado seguro");
});

test("regra por código: SEM_EFEITO/CONHECIDO(com valor) documentados viram ressalva; INDETERMINADO nunca; sem documentação, nunca; CONHECIDO sem valor bloqueia", () => {
  const doc = (chave) => ({ chave, descricao: "x", impacto: "y", decisao: "Decidido (sintético).", documentacaoFaltante: "Relatório (sintético).", evidenciaDocumentoIds: [] });
  for (const codigo of Object.keys(EFEITO_POR_CODIGO)) {
    const p = { chave: `K:${codigo}`, codigo, titulo: codigo, efeitoNoFechamento: "EXIGE_DOCUMENTACAO", valorCentavos: 1234, situacao: "ABERTA" };
    const semDoc = avaliarPendenciasDoFechamento({ pendencias: [p] }).itens[0].situacao;
    const comDoc = avaliarPendenciasDoFechamento({ pendencias: [p], documentadas: [{ ...doc(p.chave), valorCentavos: 1234 }] });
    if (EFEITO_POR_CODIGO[codigo] === "INDETERMINADO") {
      assert.deepEqual([semDoc, comDoc.itens[0].situacao, comDoc.comRessalvas], ["BLOQUEANTE", "BLOQUEANTE", false], codigo);
    } else {
      assert.deepEqual([semDoc, comDoc.itens[0].situacao, comDoc.comRessalvas, comDoc.semRessalvas], ["NAO_DOCUMENTADA", "DOCUMENTADA_ADMISSIVEL", true, false], codigo);
    }
    if (EFEITO_POR_CODIGO[codigo] === "CONHECIDO") {
      const semValor = avaliarPendenciasDoFechamento({ pendencias: [{ ...p, valorCentavos: null }], documentadas: [doc(p.chave)] });
      assert.equal(semValor.itens[0].situacao, "BLOQUEANTE", `${codigo} sem valor conhecido`);
    }
    // efeito no fechamento decide antes: BLOQUEIA bloqueia mesmo documentada; NAO_BLOQUEIA é só acompanhamento
    assert.equal(avaliarPendenciasDoFechamento({ pendencias: [{ ...p, efeitoNoFechamento: "BLOQUEIA" }], documentadas: [doc(p.chave)] }).itens[0].situacao, "BLOQUEANTE", codigo);
    assert.equal(avaliarPendenciasDoFechamento({ pendencias: [{ ...p, efeitoNoFechamento: "NAO_BLOQUEIA" }] }).itens[0].situacao, "NAO_EXIGE", codigo);
  }
});

test("09B — versão para APROVAÇÃO (23a): mesmos códigos da 22a, nenhum aprovado, campo de decisão em branco", () => {
  const aprovacao = readFileSync(join(raiz, "docs", "financeiro-v2", "23a-matriz-pendencias-aprovacao.md"), "utf8");
  for (const c of [...Object.keys(EFEITO_POR_CODIGO), ...IMPEDIMENTOS]) assert.ok(aprovacao.includes(`\`${c}\``), `${c} ausente da 23a`);
  assert.match(aprovacao, /NÃO APROVADA PELA EMPRESA/);
  assert.ok(!/\(x\) aprovo|\[x\]/i.test(aprovacao), "nenhuma decisão marcada sem aprovação explícita");
  assert.equal((aprovacao.match(/\( \) aprovo \( \) altero/g) ?? []).length, Object.keys(EFEITO_POR_CODIGO).length + IMPEDIMENTOS.length);
});

test("09C — apresentação para DECISÃO (24a): mesmos códigos, nenhuma aprovação, decisão em branco em cada linha", () => {
  const decisao = readFileSync(join(raiz, "docs", "financeiro-v2", "24a-matriz-pendencias-decisao.md"), "utf8");
  for (const c of [...Object.keys(EFEITO_POR_CODIGO), ...IMPEDIMENTOS]) assert.ok(decisao.includes(`\`${c}\``), `${c} ausente da 24a`);
  assert.match(decisao, /NÃO APROVADA/);
  assert.ok(!/\(x\) aprovo|\[x\]/i.test(decisao));
  assert.equal((decisao.match(/\( \) aprovo \( \) altero — nome\/data: ____/g) ?? []).length, Object.keys(EFEITO_POR_CODIGO).length + IMPEDIMENTOS.length);
});

test("09 — revisão da matriz: diferença de taxa/valor do processador não é mais ressalva (crédito menor superestima o resultado)", () => {
  assert.equal(EFEITO_POR_CODIGO.TAXA_OU_VALOR_DIVERGENTE, "INDETERMINADO");
  assert.match(matriz, /\| `TAXA_OU_VALOR_DIVERGENTE` \|[^\n]*\*\*Não\*\* \(corrigido na 09/);
  assert.match(matriz, /NÃO APROVADA PELA EMPRESA/);
});
