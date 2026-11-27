// Arquivo de teste que FALHA depois de criar bancos (helper do FV2 e helper do MOVA): o `after` do helper precisa apagá-los
// mesmo assim. Usado por limpeza-bancos.test.js (rodado com `node --test`). Imprime os nomes dos bancos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarBancoDeTeste } from "../helpers/postgres.js";
import { criarBancoMova } from "../../mova-financeiro/helpers/banco.js";

test("cria bancos e falha de propósito", async () => {
  const { banco } = await criarBancoDeTeste([]);
  const mova = await criarBancoMova();
  process.stdout.write(`BANCO=${banco}\nBANCO=${mova.banco}\n`);
  assert.equal(1, 2, "falha proposital");
});
