// Download do arquivo de conciliação (downloadPath). NÃO é uma chamada à
// API do iFood — o host é outro (S3 assinado da AWS), por isso não passa
// por ifoodHttp.client.js (que monta URL sobre ifoodBaseUrl()).
//
// SEGURANÇA (Bloco N/R do pedido):
//   * a URL de download carrega uma assinatura AWS válida por até 24h na
//     própria query string — NUNCA é logada aqui, nem em erro nem em
//     sucesso. Só contagens/tamanhos.
//   * download em stream com teto de tamanho — nunca materializa um
//     arquivo arbitrariamente grande em memória de uma vez;
//   * timeout dedicado;
//   * nada é persistido em disco (nem arquivo temporário) — os bytes ficam
//     só na memória do processo pelo tempo da requisição HTTP.

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { IFOOD_RECONCILIATION_ARQUIVO } from "./ifood.constants.js";

/**
 * Baixa o arquivo de conciliação com teto de tamanho e timeout.
 * @param {{url: string, fetchImpl?: typeof fetch}} p
 * @returns {Promise<Buffer>} bytes brutos (pode ser gzip — quem decide isso
 *   é ifoodFinancial.mapper.js#parsearArquivoConciliacao, via magic bytes)
 */
export async function baixarArquivoConciliacao({ url, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function" || !url) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "fetch indisponível" } });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IFOOD_RECONCILIATION_ARQUIVO.timeoutMs);

  try {
    const resp = await doFetch(url, { signal: ctrl.signal });

    if (!resp.ok) {
      ifoodLog("warn", "reconciliation.download.falhou", { status: resp.status });
      throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, {
        mensagem: "Não foi possível baixar o arquivo de conciliação. O link pode ter expirado — gere uma nova solicitação.",
      });
    }

    const reader = resp.body?.getReader?.();
    if (!reader) {
      // fetchImpl de teste sem streaming real — cai pro caminho simples.
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > IFOOD_RECONCILIATION_ARQUIVO.maxBytesDownload) {
        throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Arquivo de conciliação maior que o permitido." });
      }
      return buf;
    }

    const pedacos = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > IFOOD_RECONCILIATION_ARQUIVO.maxBytesDownload) {
        await reader.cancel().catch(() => {});
        throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Arquivo de conciliação maior que o permitido." });
      }
      pedacos.push(Buffer.from(value));
    }
    return Buffer.concat(pedacos);
  } catch (e) {
    if (e?.codigo) throw e; // erro de domínio: sobe direto
    if (e?.name === "AbortError") {
      throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Tempo esgotado ao baixar o arquivo de conciliação." });
    }
    ifoodLog("warn", "reconciliation.download.erro_rede", { erro: e?.message });
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Falha de rede ao baixar o arquivo de conciliação." });
  } finally {
    clearTimeout(timer);
  }
}
