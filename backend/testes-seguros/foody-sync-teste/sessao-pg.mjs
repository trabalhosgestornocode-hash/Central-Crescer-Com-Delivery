// UMA sessão `psql` persistente, dentro de UMA transação que SEMPRE termina em ROLLBACK. Cada comando roda num SAVEPOINT: erro
// esperado (teste negativo) desfaz só aquele comando e a transação continua. Nada do que acontece aqui é gravado no banco.
//
// Por que assim: no Supabase o usuário postgres não é superusuário (não dá para usar session_replication_role nem PGOPTIONS), e
// as tabelas foody_* são somente inclusão por trigger. Apagar o cenário sintético exigiria contornar essas travas — com ROLLBACK
// não há nada a apagar e nenhuma trava é desligada.
import { spawn } from "node:child_process";

const MARCA = "__FOODY_HOMOLOG_FIM__";

/** @returns {{ executar(sql:string): Promise<{data:any, error:any}>, consultar(sql:string): Promise<string>, encerrar(): Promise<void> }} */
export function abrirSessaoTransacional(conn, { psql = process.env.EXIBICAO_PSQL || process.env.PSQL || "psql", ocultar = [] } = {}) {
  const proc = spawn(psql, [conn, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0", "-v", "VERBOSITY=verbose"],
    { env: { ...process.env, PGCLIENTENCODING: "UTF8" }, stdio: ["pipe", "pipe", "pipe"] });
  const limpar = (s) => [conn, ...ocultar].filter(Boolean).reduce((t, x) => t.split(x).join("<oculto>"), String(s));
  let saida = "", erro = "", fila = Promise.resolve(), encerrada = false;
  const esperando = [];
  proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    saida += d;
    let i;
    while ((i = saida.indexOf(`${MARCA}\n`)) >= 0 || (i = saida.indexOf(`${MARCA}\r\n`)) >= 0) {
      const bloco = saida.slice(0, i); saida = saida.slice(saida.indexOf("\n", i) + 1);
      esperando.shift()?.(bloco);
    }
  });
  proc.stderr.on("data", (d) => { erro += d; });

  function enviar(texto) {
    if (encerrada) return Promise.reject(new Error("sessão encerrada"));
    return new Promise((resolve) => { esperando.push(resolve); proc.stdin.write(texto); });
  }
  // Primeiro: transação + constraints imediatas (as diferidas não chegariam a rodar, porque nunca há COMMIT).
  fila = enviar(`begin;\nset constraints all immediate;\nset statement_timeout = '120s';\n\\echo ${MARCA}\n`);

  function executar(sql) {
    const passo = fila.then(async () => {
      erro = "";
      const bloco = await enviar(`savepoint passo;\n${sql}\n\\if :ERROR\n\\echo __ERRO__ :SQLSTATE\nrollback to savepoint passo;\n\\else\nrelease savepoint passo;\n\\endif\n\\echo ${MARCA}\n`);
      const linhas = bloco.split(/\r?\n/).filter((l) => l.trim() !== "");
      const e = linhas.find((l) => l.startsWith("__ERRO__"));
      if (e) {
        const code = e.split(/\s+/)[1] ?? "XX000";
        const m = /ERROR:\s+(?:[0-9A-Z]{5}:\s*)?([^\n]*)/.exec(erro);
        return { data: null, error: { code, message: limpar(m?.[1] ?? erro).slice(0, 300) } };
      }
      const ultima = linhas.pop() ?? "null";
      try { return { data: JSON.parse(ultima), error: null }; } catch { return { data: ultima, error: null }; }
    });
    fila = passo.catch(() => {});
    return passo;
  }
  async function consultar(sql) {
    const r = await executar(sql);
    if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
    return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  }
  async function encerrar() {
    if (encerrada) return;
    await fila;
    await enviar(`rollback;\n\\echo ${MARCA}\n`);
    encerrada = true;
    proc.stdin.end();
    await new Promise((r) => proc.once("close", r));
  }
  return { executar, consultar, encerrar };
}
