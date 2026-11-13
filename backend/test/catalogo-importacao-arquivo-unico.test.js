// Importação de catálogo a partir de UM arquivo do modelo "Ficha Técnica 3.2" (outra empresa, ex.: açaiteria).
// Fixture 100% sintética que reproduz os SITUAÇÕES encontradas na auditoria — nenhum dado real do cliente.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const { planejarCatalogo, validarPayload, BLOQUEANTES } = await import("../src/modules/catalogo-importacao/catalogo.planejar.js");
const { extrairFichas } = await import("../src/modules/catalogo-importacao/fichasPlanilha.parser.js");
const XLSX = createRequire(import.meta.url)("xlsx");
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- workbook sintético no layout do modelo ------------------------------------------------------
function workbook() {
  const wb = XLSX.utils.book_new();
  const aba = (nome, cel) => {
    const ws = {};
    for (const [ref, v] of Object.entries(cel)) ws[ref] = typeof v === "object" ? v : { t: typeof v === "number" ? "n" : "s", v };
    ws["!ref"] = "A1:Q60"; XLSX.utils.book_append_sheet(wb, ws, nome);
  };
  const NA = { t: "e", v: 42, w: "#N/A" };
  aba("Ingredientes", {
    A2: "POLPA", B2: "GR", C2: 1000, D2: 20,
    A3: "ADOÇANTE", B3: "GR", C3: 500, D3: 50,
    A4: "AGUA", B4: "GR", C4: 1000, D4: 0,
    A5: "FRUTA", B5: "GR", C5: 1000, D5: 10,
  });
  aba("Embalagem", { A2: "COPO", B2: "UM", C2: 1, D2: 0.5, A3: "GUARDANAPO", B3: "UM", C3: 1, D3: 0.05 });
  aba("MOD", {});
  const rotFicha = { B31: "Desperdício de Material", B45: "Desperdício de Embalagem", B57: "CUSTO TOTAL DO PRODUTO" };
  const rotBase = { B26: "Desperdício de Material", B34: "Desperdício de Embalagem", B46: "CUSTO TOTAL DO PRODUTO" };
  // B1: preparação com erro de digitação ("ADOÇANTE]") => #N/A na planilha
  aba("B1", { ...rotBase, D3: "MIX ADOÇADO", M6: NA, M7: 600, K11: "Gramas", M8: NA,
    B6: "POLPA", F6: 500, B7: "ADOÇANTE]", F7: 100, G7: NA, I7: NA });
  // B2: preparação válida (massa) com 1000 g de polpa, rende 1000 g
  aba("B2", { ...rotBase, D3: "MASSA BASE", M6: 20, M7: 1000, K11: "Gramas", M8: 0.02, B6: "POLPA", F6: 1000 });
  // P1: massa vendida a granel (mesma receita da B2), rende 4,5 sem unidade, preço 59,90
  aba("P1", { ...rotFicha, D3: "MASSA A GRANEL", M6: 20, M7: 4.5, M8: 20 / 4.5, M18: 59.9, B6: "POLPA", F6: 1000 });
  // P2: copo completo — embalagem com guardanapo repetido (somado), preço zerado na planilha
  aba("P2", { ...rotFicha, D3: "COPO 300", M6: 6.1, M7: 1, M8: 6.1, M18: 0,
    B6: "POLPA", F6: 250, B7: "FRUTA", F7: 50, B35: "COPO", F35: 1, B36: "GUARDANAPO", F36: 1, B37: "GUARDANAPO", F37: 1 });
  // P3: embalagem listada sem quantidade (custo da planilha ignora a linha)
  aba("P3", { ...rotFicha, D3: "COPO SEM TAMPA", M6: 5, M7: 1, M8: 5, M18: 20, B6: "POLPA", F6: 250, B35: "COPO" });
  // P4: usa a preparação inválida
  aba("P4", { ...rotFicha, D3: "COPO ZERO", M6: NA, M7: 1, M8: NA, M18: 25, B6: "FRUTA", F6: 50, B26: "MIX ADOÇADO", F26: 200, G26: NA, I26: NA });
  // P5 e P6: mesmo nome (duplicata)
  aba("P5", { ...rotFicha, D3: "COPO DUPLO", M6: 5, M7: 1, M8: 5, M18: 18, B6: "POLPA", F6: 250 });
  aba("P6", { ...rotFicha, D3: "COPO DUPLO", M6: 5, M7: 1, M8: 5, M18: 18, B6: "POLPA", F6: 250 });
  // P7: aba-modelo vazia (sem nome) e com resto de fórmula — NÃO pode virar produto
  aba("P7", { ...rotFicha, M6: 0, M7: 1, M18: 0 });
  // P8: usa água (preço 0 explícito)
  aba("P8", { ...rotFicha, D3: "BATIDO", M6: 5, M7: 1, M8: 5, M18: 15, B6: "POLPA", F6: 250, B7: "AGUA", F7: 300 });
  return wb;
}

const extraido = extrairFichas(workbook(), "ACAI", { arquivo: "fichas.xlsx" });
const { payload, relatorio } = planejarCatalogo([extraido], { fonte: "teste-arquivo-unico" });
const P = (nome, n = 0) => payload.produtos.filter((p) => p.nome === nome)[n];
const cods = (p) => p.pendencias.map((x) => x.codigo);
const bloqueada = (p) => p.pendencias.some((x) => BLOQUEANTES.has(x.codigo));

test("aba-modelo vazia não é importada; todas as fichas preenchidas são preservadas", () => {
  assert.equal(extraido.fichas.length, 7);
  assert.equal(extraido.bases.length, 2);
  assert.equal(payload.produtos.length, 9);
  assert.deepEqual(validarPayload(payload), []);
  assert.ok(relatorio.conferencia.todos_os_registros_mapeados);
  assert.ok(relatorio.conferencia.linhas.fecha && relatorio.conferencia.linhas.fecha_processadas);
});

test("erro de digitação: linha NÃO importada, pendência bloqueante e sugestão do nome correto (sem aplicar)", () => {
  const mix = P("MIX ADOÇADO");
  assert.ok(cods(mix).includes("componente_nao_encontrado"));
  assert.ok(cods(mix).includes("custo_planilha_invalido"));
  assert.match(mix.pendencias.find((x) => x.codigo === "componente_nao_encontrado").detalhe, /possível erro de digitação de "ADOCANTE"/);
  assert.equal(mix.linhas.length, 1, "só a polpa foi importada");
  assert.ok(bloqueada(mix));
});

test("produto que usa preparação inválida fica incompleto (nunca homologável)", () => {
  const z = P("COPO ZERO");
  assert.ok(cods(z).includes("preparacao_incompleta"));
  assert.ok(bloqueada(z));
  assert.equal(z.homologacao, "pendente");
});

test("preparação intermediária válida: produto final usa o custo por grama com rendimento", () => {
  const massa = P("MASSA BASE");
  assert.equal(massa.vendavel, false); assert.equal(massa.rendimento, 1000); assert.equal(massa.unidade_rendimento, "g");
  const custo = relatorio.custos_planejados.find((c) => c.chave === massa.chave).custo_unit_ingredientes_embalagens;
  assert.equal(custo, 0.02);
});

test("rendimento de ficha final sem unidade e receita igual à de uma preparação: avisos, não bloqueios", () => {
  const g = P("MASSA A GRANEL");
  assert.ok(cods(g).includes("rendimento_sem_unidade"));
  assert.ok(cods(g).includes("mesma_receita_de_preparacao"));
  assert.ok(!bloqueada(g));
  assert.equal(relatorio.custos_planejados.find((c) => c.chave === g.chave).custo_unit_ingredientes_embalagens, Math.round((20 / 4.5) * 1e4) / 1e4);
});

test("preço de venda zerado: preservado como veio, sinalizado, sem bloquear o custo", () => {
  const c = P("COPO 300");
  assert.equal(c.referencia.preco_venda_planilha, 0);
  assert.ok(cods(c).includes("preco_venda_planilha_ausente"));
  assert.ok(!bloqueada(c));
  assert.equal(P("MASSA A GRANEL").referencia.preco_venda_planilha, 59.9);
  assert.ok(!cods(P("MASSA A GRANEL")).includes("preco_venda_planilha_ausente"));
});

test("embalagem repetida é somada; embalagem sem quantidade bloqueia", () => {
  const c = P("COPO 300");
  assert.ok(cods(c).includes("linha_duplicada_somada"));
  const guard = c.linhas.find((l) => l.chave === "emb:GUARDANAPO");
  assert.equal(guard.quantidade, 2);
  const s = P("COPO SEM TAMPA");
  assert.ok(cods(s).includes("linha_sem_quantidade"));
  assert.ok(bloqueada(s));
});

test("nomes duplicados: as duas fichas são preservadas com chaves distintas", () => {
  assert.ok(P("COPO DUPLO", 0) && P("COPO DUPLO", 1));
  assert.notEqual(P("COPO DUPLO", 0).chave, P("COPO DUPLO", 1).chave);
  assert.ok(cods(P("COPO DUPLO", 1)).includes("nome_repetido_na_categoria"));
});

test("custo zero (água) NÃO é tratado como custo válido: insumo sem custo e ficha bloqueada", () => {
  const agua = payload.insumos.find((i) => i.chave === "ing:AGUA");
  assert.equal(agua.preco_caixa, null);
  assert.ok(cods(P("BATIDO")).includes("insumo_sem_custo"));
});

test("custo recalculado confere com a planilha nas fichas completas comparáveis", () => {
  assert.equal(relatorio.conciliacao_fidelidade.divergem, 0);
  assert.ok(relatorio.conciliacao_fidelidade.conferem >= 3);
});

// ---- CLI ---------------------------------------------------------------------------------------
function cli(args) {
  return spawnSync(process.execPath, [join(RAIZ, "scripts/catalogo-importar-planilhas.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
}
test("CLI --planilha exige --categoria e --fonte (nunca herda a fonte padrão)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-cli-"));
  try {
    const arq = join(dir, "f.xlsx"); XLSX.writeFile(workbook(), arq);
    assert.equal(cli(["--planilha", arq, "--categoria", "ACAI"]).status, 2);
    assert.equal(cli(["--planilha", arq, "--fonte", "x-v1"]).status, 2);
    assert.equal(cli(["--planilha", arq, "--categoria", "ACAI", "--fonte", "x-v1", "--doces", arq]).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("CLI --planilha simula sem banco e grava relatório com a categoria informada", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-cli-"));
  try {
    const arq = join(dir, "f.xlsx"); XLSX.writeFile(workbook(), arq);
    const r = cli(["--planilha", arq, "--categoria", "acai", "--fonte", "teste-v1", "--saida", join(dir, "out")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Modo SIMULAÇÃO/);
    const rel = JSON.parse(readFileSync(join(dir, "out", "relatorio.json"), "utf8"));
    assert.deepEqual(Object.keys(rel.por_categoria), ["ACAI"]);
    assert.equal(rel.fonte, "teste-v1");
    assert.ok(existsSync(join(dir, "out", "payload.json")));
    // escrita sem as travas é recusada
    const w = cli(["--planilha", arq, "--categoria", "ACAI", "--fonte", "teste-v1", "--saida", join(dir, "out2"), "--aplicar"]);
    assert.equal(w.status, 3); assert.match(w.stderr, /ESCRITA RECUSADA/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
