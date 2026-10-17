// Plano de contas, contas financeiras e saldos de abertura.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, enumerado, data, bad, papel as validarPapel } from "./validacao.js";
import { paraCentavos } from "../../../financeiro-calculos/dinheiro.js";
import { PAPEL } from "../../../financeiro-calculos/planoContas.js";

const padrao = { repo: repositorio, db: undefined };
const canalDe = (v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase().slice(0, 40) : null);
const TIPOS_CONTA = ["banco", "adquirente", "caixa_fisico", "carteira_plataforma", "outra"];

export async function listarPlanoContas(ctx, deps = padrao) {
  return deps.repo.listarPlanoContas(exigirContexto(ctx), deps.db);
}
export async function criarCategoria(ctx, b, deps = padrao) {
  const papel = validarPapel(b?.papel);
  if (papel === PAPEL.SALDO_ANTERIOR) throw bad("Saldo anterior é tratado como saldo de abertura, não como categoria de lançamento.");
  return deps.repo.inserirCategoria(exigirContexto(ctx), {
    tipo: texto(b?.tipo, "tipo", { max: 60 }).toUpperCase(), natureza: texto(b?.natureza, "natureza", { max: 60 }).toUpperCase(),
    nome: texto(b?.nome, "nome", { max: 80 }).toUpperCase(), papel,
  }, deps.db);
}
/** Renomear/ativar/desativar. Mudar o papel é recusado pelo banco se a categoria já tem lançamentos (reclassificação é explícita). */
export async function atualizarCategoria(ctx, id, b, deps = padrao) {
  const campos = {};
  if (b?.nome !== undefined) campos.nome = texto(b.nome, "nome", { max: 80 }).toUpperCase();
  if (b?.ativo !== undefined) { if (typeof b.ativo !== "boolean") throw bad("ativo inválido."); campos.ativo = b.ativo; }
  if (b?.papel !== undefined) campos.papel = validarPapel(b.papel);
  if (!Object.keys(campos).length) throw bad("Nada para atualizar.");
  return deps.repo.atualizarCategoria(exigirContexto(ctx), uuid(id, "id"), campos, deps.db);
}

export async function listarContas(ctx, deps = padrao) {
  return deps.repo.listarContas(exigirContexto(ctx), deps.db);
}
export async function criarConta(ctx, b, deps = padrao) {
  return deps.repo.inserirConta(exigirContexto(ctx), {
    nome: texto(b?.nome, "nome", { max: 80 }).toUpperCase(), tipo_conta: enumerado(b?.tipoConta ?? "outra", "tipoConta", TIPOS_CONTA), canal_referencia: canalDe(b?.canalReferencia),
  }, deps.db);
}
export async function atualizarConta(ctx, id, b, deps = padrao) {
  const campos = {};
  if (b?.nome !== undefined) campos.nome = texto(b.nome, "nome", { max: 80 }).toUpperCase();
  if (b?.tipoConta !== undefined) campos.tipo_conta = enumerado(b.tipoConta, "tipoConta", TIPOS_CONTA);
  if (b?.canalReferencia !== undefined) campos.canal_referencia = canalDe(b.canalReferencia);
  if (b?.ativo !== undefined) { if (typeof b.ativo !== "boolean") throw bad("ativo inválido."); campos.ativo = b.ativo; }
  if (!Object.keys(campos).length) throw bad("Nada para atualizar.");
  return deps.repo.atualizarConta(exigirContexto(ctx), uuid(id, "id"), campos, deps.db);
}

export async function listarAberturas(ctx, deps = padrao) {
  return deps.repo.listarAberturas(exigirContexto(ctx), deps.db);
}
/** Saldo de abertura CONHECIDO. Ausência de linha = desconhecido (nunca zero). Pode ser negativo (cheque especial). */
export async function definirAbertura(ctx, b, deps = padrao) {
  let valor;
  try { valor = paraCentavos(b?.valor); } catch { throw bad("valor inválido."); }
  if (valor == null) throw bad("valor é obrigatório (para marcar como desconhecido, não informe abertura).");
  return deps.repo.gravarAbertura(exigirContexto(ctx), {
    conta_id: uuid(b?.contaId, "contaId"), data_referencia: data(b?.dataReferencia, "dataReferencia"), valor_centavos: valor, nota: texto(b?.nota, "nota", { max: 500, obrigatorio: false }),
  }, deps.db);
}
