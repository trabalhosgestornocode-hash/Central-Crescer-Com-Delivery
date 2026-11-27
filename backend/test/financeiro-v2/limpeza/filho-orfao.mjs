// Processo de teste que MORRE sem limpar (como um teste derrubado à força): cria um banco pelo helper e sai na hora,
// sem rodar o `after`. Usado por limpeza-bancos.test.js. Imprime o nome do banco.
import { criarBancoDeTeste } from "../helpers/postgres.js";

const { banco } = await criarBancoDeTeste([]);
process.stdout.write(`${banco}\n`);
process.exit(0);
