# 29 — Roteiro da abertura financeira do Açaí no Grau Saci

Situação de partida (15/11): Financeiro v2 em produção só para consulta no Açaí no Grau Saci. Há 1 administrador (bootstrap
de infraestrutura) e 0 lançamentos. Este roteiro **não contém valores**: os números vêm dos documentos, na hora da abertura.

## 1. Pré-condições (todas obrigatórias antes de ligar a escrita)

| # | Condição | Situação |
|---|---|---|
| P1 | Rotas de **criar conta financeira**, **registrar recebível** e **abrir caixa** (o núcleo já tem as três) | ❌ falta a rota + formulário |
| P2 | Formulário de **implantar plano de contas** (a rota já existe) | ❌ falta o formulário |
| P3 | Obrigação com fornecedor novo numa única transação, com reenvio idempotente | ✅ corrigido localmente (sem publicar) |
| P4 | Teste de escrita no modo co-localizado (o modo de produção) | ✅ local, 1 teste com 13 verificações |
| P5 | Decisão do proprietário sobre o risco da autoridade co-localizada (§ 6) | ⏳ |
| P6 | Documentos de origem: o cofre continua **desligado** (envio responde 503). Os saldos registram a referência em texto, sem anexo | ⏳ decisão: aceitar a abertura sem anexo ou esperar o cofre |

## 2. Decisões do proprietário

1. **Competência de início.** Recomendação: 1º dia de um mês sem fechamento pendente (ex.: 2026-12-01 ou 2026-11-01).
   Os meses anteriores não são apurados no v2.
2. **Contas financeiras.** Unicred (bancária), caixa físico, e outras somente se tiverem extrato (ex.: conta de recebíveis).
3. **Títulos anteriores ao início.** O plano não tem uma categoria de "saldo de abertura". Há duas opções:
   - **A:** cada título entra na **competência original**, com a categoria real. A DRE dos meses anteriores fica parcial e
     não é considerada.
   - **B:** criar a categoria patrimonial "Títulos anteriores à abertura", fora do resultado. É uma alteração no plano e
     depende de autorização.
4. **CMV.** Não é lançado sem os relatórios de compras e estoque. Fica "a classificar" (fora da DRE) até haver evidência.
5. **Quem valida os valores.** Uma pessoa diferente de quem digita, por exemplo o contador ou a sócia. A conferência
   fica registrada no fechamento.

## 3. Documentos necessários (o proprietário reúne; não vão para o Git nem para o chat)

- Extrato Unicred do dia anterior ao início, com o **saldo final do dia**, e do primeiro dia.
- Contagem física do caixa no fechamento do dia anterior, assinada por quem contou.
- Lista de contas a pagar em aberto: fornecedor, documento, emissão, vencimento, valor e categoria.
- Lista de valores a receber em aberto: iFood, Stone e outros repasses, com o demonstrativo de cada operadora.
- Plano de contas: modelo ACAITERIA, com os ajustes desejados (nome e ativação de categorias).

## 4. Execução (quando autorizada; tudo pela tela, com o login da Crescer)

1. Ligar `FV2_ESCRITA_HABILITADA=1`. A homologação, o provisionamento e o envio de arquivos continuam desligados.
2. Implantar o plano (ACAITERIA). A operação é idempotente.
3. Criar as contas Unicred e Caixa físico. Depende de P1.
4. Registrar os saldos de abertura: Unicred com o saldo de **FIM_DO_DIA** do dia anterior ao início, e o caixa com a
   contagem. Na observação, informar a referência do extrato ou da contagem.
5. Registrar as contas a pagar em aberto, uma por documento. O reenvio do mesmo formulário não duplica.
6. Registrar os recebíveis em aberto, com a operadora e o demonstrativo. Depende de P1.
7. Conferências **depois**: o saldo de cada conta na data é igual ao extrato ou à contagem; o total a pagar em aberto
   é igual à lista; o total a receber é igual aos demonstrativos; a DRE do mês de início está vazia ou só com o que de
   fato é do mês.
8. Validador (§ 2.5): confere e registra a pendência ou a aceitação no fechamento.
9. Decidir se mantém `FV2_ESCRITA_HABILITADA=1` para a operação diária ou volta para 0.

## 5. Auditoria e reversão

- Toda gravação gera histórico com a **pessoa individual**. As concessões vão para `fv2_auditoria_concessao`, e as
  liberações para o histórico próprio, com o horário do 2º fator.
- Errou um valor: **estornar ou corrigir** pela tela (nada é apagado; cada correção gera nova versão e histórico).
- Desligamento imediato, sem deploy:
  - "Desligar esta unidade" na página de ativação, com o TOTP do administrador da empresa;
  - ou `FV2_ESCRITA_HABILITADA=0` (volta a ser só consulta).
- Conferências **antes**: confirmar 0 lançamentos no v2 e que os extratos e listas estão completos.

## 6. Riscos residuais (registrados; nenhuma variável os elimina)

- **A autoridade fica no mesmo processo do backend.** Quem comprometer esse processo obtém as duas credenciais: pode
  abrir sessão em nome de quem tem concessão e contornar, no código, o 2º fator das ações sensíveis. A trilha no banco
  continua, mas a autoria pode ser forjada. `FV2_AUTORIDADE_COLOCALIZADA_ACEITA=1` é o registro do aceite, **não uma
  proteção**.
- `postgres`, `supabase_admin` e o editor SQL leem e alteram o v2 (aceito em 14/11).
- Sem cofre documental, os saldos e títulos não têm anexo verificável; a evidência fica fora do sistema.
- As senhas das credenciais do v2 passaram pelo histórico da sessão de 15/11. Trocar as duas antes da escrita reduz o
  risco.
- O administrador inicial foi criado por bootstrap, sem segundo atestador (decisão do proprietário, auditada).
