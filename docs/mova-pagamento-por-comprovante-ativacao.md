# MOVA — pagamento por comprovante: política aprovada e roteiro de ativação

**Política aprovada pelo proprietário (22/11/2026).** Ativar depende de homologação técnica, permissões específicas e
validação dos controles. A aprovação, sozinha, não ativa nada.

| Item | Valor |
|---|---|
| Unidade | Açaí no Grau Saci (somente ela; política por unidade, nunca por empresa) |
| Operação | `BAIXA_DOCUMENTAL`: pagamento registrado por comprovante, conciliação bancária pendente |
| Nível | `APLICAR_AUTOMATICO` |
| Limite | R$ 1.000,00 por pagamento (`limiteCentavos` 100000) |
| Acima do limite | aprovação humana na Central |

## Controles no código
- **Quem pode ser baixado automaticamente:** só um Pix ou transferência **concluído**, com leitura de confiança ALTA, sem incertezas e com **identificador da transação**. Sem o identificador, o pagamento vai para confirmação humana.
- **Casos sem baixa automática (`SOMENTE_PROPOR`):** comprovante ambíguo, duplicado, agendado, pendente, cancelado, ilegível, inconsistente ou suspeito.
- **Anti-fracionamento:** somam para o limite os pagamentos que o MOVA já baixou na **mesma conta**, ou ao **mesmo favorecido** com até 3 dias de diferença. Passou de R$ 1.000,00, o pagamento vai para confirmação humana (`POSSIVEL_FRACIONAMENTO`).
- **Baixa sem movimento bancário:**
  - o pagamento por comprovante não cria movimentação bancária;
  - a saída do extrato que chega depois é **ligada à mesma baixa**: nunca é segunda baixa, segunda saída ou segunda despesa;
  - a DRE continua reconhecendo a despesa uma única vez, pela conta.
- **Idempotência:**
  - chave por documento;
  - identificador da transação com janela de 90 dias;
  - reserva da operação no MOVA.
- **Reversão:** só pelo responsável, com estorno oficial (`cancelar`). A reversão devolve o saldo e libera a saída do extrato.
- **Auditoria:** proposta, operação executada, histórico do Financeiro e conciliação.

## Chaves e permissões (estado depois do merge: TUDO desligado)
- `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE=1` liga o caminho. Sem essa chave, nada é pago por comprovante, nem pela política, nem pela Central.
- `MOVA_OPERACAO_AUTONOMIA=1`, `MOVA_OPERACAO_ESCRITA=1` e `MOVA_IDENTIDADE_OPERACIONAL=<uuid>` montam a escrita automática. O provedor está em `fv2-integracao/operacionalMova.js`.
- **Concessão da identidade operacional, só no Açaí** (perfil `REGISTRAR_PAGAMENTO_COMPROVANTE`): `ver`, `enviar_documento` e `baixar_por_comprovante`.
  - `vincular_pagamento` (perfil `VINCULAR_EXTRATO`) só entra se a conciliação automática também for aprovada.
  - Uma concessão com qualquer ação ampla é tratada como **ausente**.
- O MOVA **não** recebe `registrar`, `cancelar`, `configurar`, `conceder` nem nenhuma outra ação ampla. Criar obrigação nova e reverter continuam humanos.

## Ordem de ativação (cada passo com conferência)
1. Aplicar 0029 (Financeiro) e 0009 (MOVA) pelos `atualizar.sql`. Recuperação: `database/*/recuperacao/reverter-*.sql`, com a volta ensaiada.
2. Criar a identidade operacional (uma pessoa técnica sem login humano) e a concessão acima, só no Açaí.
3. Cadastrar a política BAIXA_DOCUMENTAL do Açaí pela Central (permissão configurar), com limite de R$ 1.000,00.
4. Ligar a IA de leitura documental dentro do orçamento aprovado: US$ 1,00 e 20 chamadas, com `MOVA_IA_SOMENTE_DOCUMENTOS` no padrão (ligado).
5. Ligar `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE`, depois `MOVA_OPERACAO_AUTONOMIA` e `MOVA_OPERACAO_ESCRITA`.
6. Fazer o primeiro comprovante real com acompanhamento. Conferir no Financeiro: baixa sem saída, conciliação pendente e nenhuma duplicidade.

## Piloto de leitura documental por IA (23/11/2026)

- Modelo único: `claude-haiku-5-5` (outro modelo é recusado na configuração e na resposta).
- Orçamento persistente (`mova.orcamento_ia`): 20 chamadas, US$ 1,00 acumulado, reserva de US$ 0,02 por chamada **antes** de cada chamada (trava consultiva no banco; 40 chamadas simultâneas → exatamente 20 chegam à API).
- Sem nova tentativa oculta do SDK (`maxRetries: 0`); tentativa sem resposta da API (tempo esgotado, conexão) é contada pelo valor da reserva — possivelmente faturada. Erro com resposta (4xx/5xx) custa 0, mas conta como tentativa.
- Teto por chamada: entrada 20.000 tokens (contados de graça antes, inclusive imagem/PDF), saída 600, esforço baixo.
- `MOVA_IA_SOMENTE_DOCUMENTOS` (padrão ligado): texto solto nunca gasta orçamento; o redator de respostas naturais fica desligado.
- Sem chave `ANTHROPIC_API_KEY`, a IA fica desligada e o resto do MOVA segue (falha segura).
- Desligamento imediato: `mova.controle.ia = false` (sem reinício). Histórico não é reprocessado (fila 100% CONCLUIDO em 23/11).
- Duplicidade: o mesmo arquivo (sha256) não é lido duas vezes.

## Despesa SEM conta prévia (DESPESA_DOCUMENTAL) — preparada, NÃO concedida

- Ação nova e estreita `financeiro_v2.registrar_obrigacao` (migração 0030): quem só tem esta ação grava UM lançamento de DESPESA + UMA conta a pagar de uma parcela, criados na mesma transação; nada de movimentação, receita, alteração ou recorrência (conferido pelo banco).
- Perfil `CRIAR_OBRIGACOES` = [ver, enviar_documento, registrar_obrigacao] — **não concedido a ninguém**.
- Operação MOVA `DESPESA_DOCUMENTAL` (migração 0010): política própria, limite, antifracionamento somado com BAIXA_DOCUMENTAL.
- Chave `MOVA_OPERACAO_CRIAR_DESPESAS` (padrão desligada; exige `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE`).
- Fluxo: conta nova (fonte `MOVA:<proposta>`, idempotente) → comprovante anexado → pagamento por comprovante (sem saída bancária; conciliação pendente) → resposta. Falha no meio: proposta volta para revisão; nova tentativa reaproveita a conta.
- Recuperação: `database/financeiro-v2/recuperacao/reverter-0030.sql` e `database/mova-financeiro/recuperacao/reverter-0010.sql` (ensaiadas: voltam ao retrato idêntico de 0029/0009).
