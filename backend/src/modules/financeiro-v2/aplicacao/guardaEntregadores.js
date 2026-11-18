// Trava única do pagamento de entregadores próprios: toda baixa de conta nascida do fechamento semanal passa por aqui.
// Contas de outras origens não são afetadas.
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO } from "../dominio/catalogos.js";
import { SITUACAO_DOCUMENTAL, hashDaFonte } from "../dominio/entregadoresProprios.js";

export async function exigirPagamentoLiberado(tx, cx, obrigacao) {
  const hash = hashDaFonte(obrigacao?.fonte?.idExterno);
  if (!hash) return;
  const f = await tx.buscarPorChave(cx, TIPO.FECHAMENTO_ENTREGADOR, `es:${hash}`);
  if (f?.situacaoDocumental !== SITUACAO_DOCUMENTAL.LIBERADO_PAGAMENTO) {
    falhar(CODIGO.OPERACAO_INVALIDA, "Pagamento bloqueado: a nota fiscal e o demonstrativo deste entregador ainda não foram conferidos e liberados.", { motivo: "ENTREGADOR_SEM_LIBERACAO_DOCUMENTAL", situacaoDocumental: f?.situacaoDocumental ?? null });
  }
}
