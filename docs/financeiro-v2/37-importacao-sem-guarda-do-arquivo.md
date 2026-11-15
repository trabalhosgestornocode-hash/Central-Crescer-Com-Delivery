# 37 — Importação pela plataforma sem guarda do arquivo

> Decisão do proprietário (15/11/2026): liberar a importação de relatórios **sem guardar o arquivo**. O cofre documental
> continua desligado, porque ainda não há verificação antimalware.

## Como funciona

- **Envio:** `/importacao/receber` aceita o arquivo em base64 estrito, de até 5 MiB, numa lista **fechada** de relatórios
  conferidos com arquivo real:
  - SAIPOS canais (desempenho por atendente);
  - SAIPOS formas de pagamento;
  - SAIPOS faturamento por dia;
  - Stone vendas;
  - extrato Unicred.

  A fonte vem do tipo de relatório, e o corpo maior (até 8 MB em JSON) vale **só** para esta ação; as outras continuam
  com 64 KB.
- **Guarda:** o arquivo vive num **cofre temporário em memória do processo** (`fv2-integracao/cofreTemporario.js`).
  - Fica só pelo tempo de revisar a prévia e confirmar (30 min).
  - Tem limite total de 40 MB, e o mais antigo sai primeiro.
  - Nunca vai a disco, banco ou rede.
  - Não tem inventário.
- **O que fica registrado:** só a **impressão digital (SHA-256)**, o tamanho, o documento (com a descrição "arquivo não
  guardado"), a importação e as linhas extraídas. Leitor próprio, sem bibliotecas externas.
- **Reenvio:** depois da validade, ou de um reinício do serviço, a confirmação pede o reenvio. O **mesmo** arquivo cai na
  **mesma** importação (idempotente).
- **Continua indisponível:** documento avulso, verificação de arquivo e leitura do original (`/documentos/enviar`,
  `/documentos/verificar`), que exigem o cofre documental.

## Tela

Conferências → Importar: escolher o relatório e o período, enviar o arquivo, conferir a prévia e confirmar. O aviso diz que o
arquivo é lido e descartado.

## Testes

- `importacao-sem-guarda.test.js`:
  - cofre temporário: escopo, validade, limites, sem inventário;
  - rota: lista fechada, base64 estrito, expiração, reenvio na mesma importação, confirmação.
- `integracao-http.test.js` (co-localizado, PostgreSQL):
  - arquivo maior que 64 KB pela rota real;
  - prévia e confirmação no mesmo processo;
  - documento avulso segue 503.
