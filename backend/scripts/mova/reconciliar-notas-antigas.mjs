// Reconciliação das notas antigas do MOVA (ver aplicacao/reconciliacaoNotasAntigas.js).
//   node scripts/mova/reconciliar-notas-antigas.mjs --plano <arquivo.json>                              (dry-run: só mostra antes/depois)
//   node scripts/mova/reconciliar-notas-antigas.mjs --plano <arquivo.json> --executar --backup <arquivo>  (grava; backup ANTES)
// O plano contém dados reais (unidade, entregador, número da nota, semana, valor): mantenha FORA do repositório (público).
// NUNCA envia mensagem: a montagem do MOVA é feita com envio, recebimento, processamento, rotinas, escrita e IA desligados.
// Sem --executar nada é escrito. Com --executar a confirmação --confirmo-producao é exigida quando o banco é o de produção.
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { reconciliarNotasAntigas } from "../../src/modules/mova-financeiro/aplicacao/reconciliacaoNotasAntigas.js";

export function lerArgumentos(argv) {
  const a = { plano: null, executar: false, backup: null, confirmoProducao: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--plano") a.plano = argv[++i];
    else if (k === "--backup") a.backup = argv[++i];
    else if (k === "--executar") a.executar = true;
    else if (k === "--confirmo-producao") a.confirmoProducao = true;
    else throw Object.assign(new Error(`Argumento desconhecido: ${k}`), { codigo: "ARGUMENTO_DESCONHECIDO" });
  }
  if (!a.plano) throw Object.assign(new Error("Informe --plano <arquivo.json>."), { codigo: "SEM_PLANO" });
  if (a.executar && !a.backup) throw Object.assign(new Error("--executar exige --backup <arquivo>."), { codigo: "BACKUP_OBRIGATORIO" });
  if (a.executar && existsSync(a.backup)) throw Object.assign(new Error("O arquivo de backup já existe: não é sobrescrito."), { codigo: "BACKUP_JA_EXISTE" });
  return a;
}

/** Monta a conexão com o MOVA pela MESMA montagem da produção, com tudo que envia/recebe/escreve no Financeiro desligado. */
export async function adaptadorDeProducao(env) {
  const seguro = { ...env, MOVA_HABILITADO: "1", MOVA_ENVIO_HABILITADO: "0", MOVA_RECEBIMENTO_HABILITADO: "0", MOVA_PROCESSAMENTO_HABILITADO: "0", MOVA_ENTREGADORES_ROTINA: "0", MOVA_OPERACAO_ESCRITA: "0", MOVA_OPERACAO_AUTONOMIA: "0", MOVA_IA_HABILITADA: "0" };
  const { movaDaPlataforma } = await import("../../src/modules/fv2-integracao/mova.js");
  const { criarAuxiliaresDeUnidade } = await import("../../src/modules/mova-financeiro/aplicacao/unidadesDoMova.js");
  const inst = await movaDaPlataforma({ env: seguro });
  if (!inst) throw Object.assign(new Error("Não foi possível montar o MOVA (configuração/banco)."), { codigo: "MOVA_NAO_MONTADO" });
  const { escopoDe, cnpjDe } = criarAuxiliaresDeUnidade({ cfg: inst.configuracao, avisosNoGrupo: {} });
  const armazenamento = inst.mova.armazenamento;
  return {
    armazenamento, escopoDe,
    ler: async (esc, entregador, inicio) => {
      const consulta = await inst.mova.porta.ler("consultarEntregador", esc, { entregador });
      const detalhe = await inst.mova.porta.ler("detalharFechamentoDoEntregador", esc, { inicio, entregador });
      return { fechamento: consulta.fechamentos.find((f) => f.semanaInicio === inicio && f.entregador?.chave === entregador), notas: detalhe.notas ?? [] };
    },
    tomadorDe: async (u) => cnpjDe(u) ?? (await armazenamento.identidadesFiscais.tomadorDaUnidade(u))?.documento ?? null,
    encerrar: async () => {},
  };
}

export async function principal({ argv, env = process.env, adaptador = adaptadorDeProducao, saida = (t) => process.stdout.write(`${t}\n`) }) {
  const a = lerArgumentos(argv);
  const plano = JSON.parse(readFileSync(a.plano, "utf8"));
  const x = await adaptador(env);
  const r = await reconciliarNotasAntigas({
    plano, ler: x.ler, armazenamento: x.armazenamento, escopoDe: x.escopoDe, tomadorDe: x.tomadorDe, executar: a.executar,
    backup: a.executar ? async (linhas) => { writeFileSync(a.backup, JSON.stringify({ geradoEm: new Date().toISOString(), linhas }, null, 2), { flag: "wx" }); } : null,
  });
  saida(JSON.stringify({ modo: a.executar ? "EXECUCAO" : "DRY_RUN", resumo: r.resumo, resultados: r.resultados }, null, 2));
  await x.encerrar?.();
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal({ argv: process.argv.slice(2) }).then((r) => process.exit(r.resumo.paradas > 0 ? 2 : 0)).catch((e) => { console.error(`FALHA: ${e.codigo ?? ""} ${e.message}`); process.exit(1); });
}
