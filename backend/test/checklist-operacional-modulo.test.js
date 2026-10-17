// Checklist Operacional — módulo PRÓPRIO `checklist_operacional` (migration 123): catálogo, migration e rollback.
//
// Sem banco e sem rede. Prova que: o catálogo do código e o da migration dizem a mesma coisa; a migration só dá o
// módulo a quem JÁ tem `ifood` (nunca "a todas"); o rollback desfaz tudo; e o acesso efetivo continua sendo
// a interseção empresa ∩ unidade (uma unidade nunca tem o módulo que a empresa não tem).
//
// Rodar: node --experimental-vm-modules --test test/checklist-operacional-modulo.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { MODULOS, CATALOGO_MODULOS, validarModulos, interseccaoModulos, rotuloModulo } = await import("../src/shared/modulos.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// O número da migration (123) só é definitivo se continuar livre no merge (a trilha financeira ocupa 120–122; ver docs/checklist-universal-e-tempos.md). O teste descobre o par
// pelo nome, então a renumeração não quebra nada: arquivo `<n>_checklist_operacional_modulo.sql` + `<n>_rollback.sql`.
const MIGRATIONS = path.join(AQUI, "../../database/migrations");
const NOME = readdirSync(MIGRATIONS).filter((f) => /^\d+_checklist_operacional_modulo\.sql$/.test(f));
assert.equal(NOME.length, 1, "exatamente UMA migration do módulo checklist_operacional");
const NUMERO = NOME[0].split("_")[0];
const MIGRATION = readFileSync(path.join(MIGRATIONS, NOME[0]), "utf8");
const ROLLBACK = readFileSync(path.join(MIGRATIONS, `${NUMERO}_rollback.sql`), "utf8");
const semComentarios = (sql) => sql.replace(/--.*$/gm, "");

describe("catálogo do módulo", () => {
  test("o id é estável e está no catálogo, com nome, categoria e ordem únicos", () => {
    assert.equal(MODULOS.CHECKLIST_OPERACIONAL, "checklist_operacional");
    const m = CATALOGO_MODULOS.find((x) => x.id === "checklist_operacional");
    assert.ok(m, "módulo no catálogo");
    assert.equal(m.nome, "Checklist Operacional");
    assert.equal(m.categoria, "operacao");
    // Ordem 18: a 17 é da trilha financeira (`gestao_financeira`), que ainda não foi integrada. O Checklist não a usa para não alterar a migration dela.
    assert.equal(m.ordem, 18);
    assert.deepEqual(CATALOGO_MODULOS.map((x) => x.ordem).sort((a, b) => a - b), [...new Set(CATALOGO_MODULOS.map((x) => x.ordem))].sort((a, b) => a - b), "nenhuma ordem repetida no catálogo");
    assert.equal(CATALOGO_MODULOS.filter((x) => x.ordem === m.ordem).length, 1, "ordem não repete");
    assert.equal(new Set(CATALOGO_MODULOS.map((x) => x.id)).size, CATALOGO_MODULOS.length, "ids únicos");
  });

  test("o módulo iFood continua existindo e separado (o Checklist não o substitui)", () => {
    assert.ok(CATALOGO_MODULOS.some((x) => x.id === MODULOS.IFOOD));
    assert.notEqual(MODULOS.IFOOD, MODULOS.CHECKLIST_OPERACIONAL);
  });

  test("o SuperAdmin pode liberar o módulo novo (validarModulos aceita) e id inventado continua recusado", () => {
    assert.deepEqual(validarModulos(["checklist_operacional"]), ["checklist_operacional"]);
    assert.throws(() => validarModulos(["checklist_operacional_x"]));
    assert.equal(rotuloModulo("checklist_operacional"), "Checklist Operacional");
  });

  test("acesso efetivo = empresa ∩ unidade: a unidade nunca tem o módulo que a empresa não tem", () => {
    assert.deepEqual(interseccaoModulos(["dashboard"], ["dashboard", "checklist_operacional"]), ["dashboard"]);
    assert.deepEqual(interseccaoModulos(["checklist_operacional", "dashboard"], ["checklist_operacional"]), ["checklist_operacional"]);
  });
});

describe("migration 123", () => {
  const sql = semComentarios(MIGRATION);

  test("insere o MESMO módulo do catálogo do código (id, nome, categoria, ordem)", () => {
    const m = CATALOGO_MODULOS.find((x) => x.id === "checklist_operacional");
    assert.match(sql, new RegExp(`\\('${m.id}',\\s*'${m.nome}',\\s*'${m.categoria}',\\s*${m.ordem}\\)`));
    assert.match(sql, /on conflict \(id\) do update/i, "idempotente");
  });

  test("backfill SÓ de quem já tem o módulo ifood, nos DOIS níveis (empresa e unidade)", () => {
    assert.match(sql, /insert into organizacao_modulos[\s\S]*?where om\.modulo_id = 'ifood'/i);
    assert.match(sql, /insert into unidade_modulos[\s\S]*?where um\.modulo_id = 'ifood'/i);
    assert.equal((sql.match(/on conflict do nothing/gi) ?? []).length, 2, "backfill idempotente");
  });

  test("NÃO habilita em massa: nenhum cross join com empresas/unidades, nenhum insert sem filtro de ifood", () => {
    assert.doesNotMatch(sql, /cross\s+join/i);
    assert.doesNotMatch(sql, /from\s+(organizacoes|unidades)\b/i);
  });

  test("é uma transação e não toca em ifood_*, credenciais, tokens nem pedidos", () => {
    assert.match(sql, /\bbegin;[\s\S]*\bcommit;/i);
    assert.doesNotMatch(sql, /ifood_(conexoes|credenciais|pedidos|eventos|loja_credenciais|oauth)/i);
    assert.doesNotMatch(sql, /\b(drop|truncate|alter)\b/i);
  });
});

describe("rollback 123", () => {
  const sql = semComentarios(ROLLBACK);

  test("remove vínculos de unidade, de empresa e o item do catálogo — só deste módulo", () => {
    assert.match(sql, /delete from unidade_modulos where modulo_id = 'checklist_operacional'/i);
    assert.match(sql, /delete from organizacao_modulos where modulo_id = 'checklist_operacional'/i);
    assert.match(sql, /delete from modulos where id = 'checklist_operacional'/i);
    for (const d of sql.match(/delete from[^;]+;/gi)) assert.match(d, /checklist_operacional/, `delete sem filtro: ${d}`);
  });

  test("ordem segura: vínculos antes do catálogo; não mexe no módulo ifood", () => {
    assert.ok(sql.indexOf("delete from unidade_modulos") < sql.indexOf("delete from modulos"));
    assert.ok(sql.indexOf("delete from organizacao_modulos") < sql.indexOf("delete from modulos"));
    assert.doesNotMatch(sql, /'ifood'/);
  });
});
