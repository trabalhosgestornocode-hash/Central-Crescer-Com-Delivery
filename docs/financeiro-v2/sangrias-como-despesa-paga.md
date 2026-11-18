# Sangrias da SAIPOS como despesa paga em dinheiro

Complementa `publicacao-sangrias-saipos.md`. **Substitui uma decisão dele**: lá a retirada era só conferência (sem despesa). O dono do negócio
esclareceu como a retirada deve ser tratada, e o sistema passa a fazer assim — mas só em uma etapa explícita, nunca ao importar.

## Regra de negócio

Cada retirada de caixa é uma despesa pequena paga com dinheiro do caixa (ex.: espátula, pilhas, taxa de entregador). No sistema:

- conta a pagar do fornecedor **Sangrias**, categoria **Outras despesas**;
- paga **em dinheiro**, saindo do **Caixa da loja** (caixa físico), **na própria data** da retirada;
- aparece no Contas a Pagar, no calendário (como **paga**) e na DRE em Outras despesas;
- reforço e transferência **não** viram despesa (reforço é dinheiro que volta ao caixa; transferência tem sentido desconhecido).

É o mesmo que a equipe já lançava à mão ("Paguei em dinheiro · Sai do caixa da loja"). O lançamento usa as mesmas operações do núcleo
(`registrarObrigacao` + `pagarContaAPagar`), sem tipo novo de proposta e **sem migration** (a tabela de propostas tem uma lista fechada de
operações no banco; criar uma nova exigiria migration).

## Como funciona

1. **Importar** o relatório (como antes): nada é lançado.
2. Na tela da importação confirmada aparece o bloco **"Lançar as retiradas como despesas pagas em dinheiro"**, com cada retirada em uma de três situações:
   - **Nova**: será lançada;
   - **Já lançada à mão**: existe conta do fornecedor Sangrias com a **mesma data e o mesmo valor**: não é repetida;
   - **Já lançada pela importação**: já foi lançada antes por esta função.
3. **Confirmar** o lançamento: cada retirada nova vira conta + pagamento, atomicamente.

## Garantias

- **Sem duplicar**: casamento 1 para 1 por data e valor (duas retiradas iguais no dia exigem duas contas). Reconferido **dentro da transação** de cada retirada.
- **Idempotente**: cada retirada tem identificador próprio derivado da linha importada; repetir a ação não lança nada.
- **Atômico por retirada**: se uma falhar (ex.: competência homologada), as outras são lançadas e a falha aparece com o motivo.
- **Permissão**: exige "registrar" (a mesma de lançar um pagamento à mão). Acesso negado recusa a ação inteira, sem lançar nada.
- **Fornecedor**: reaproveita o "Sangrias" existente (compara sem diferença de maiúsculas e acentos) e só cria se não existir.
- **Caixa**: exige exatamente um caixa físico ativo; senão a tela explica e nada é lançado.

## O que muda para quem usa

- A DRE passa a refletir as retiradas em **Outras despesas** (era o que acontecia com as lançadas à mão).
- As retiradas já lançadas à mão **não são tocadas** nem repetidas.
- A descrição das contas criadas é genérica ("Retirada de Frente de Caixa (SAIPOS) em dd/mm"): o relatório não diz para que foi o dinheiro.
  Quem quiser pode corrigir a descrição depois pela tela da conta.

## Riscos

| Risco | Nível | Mitigação |
|-------|-------|-----------|
| Coincidir data e valor com uma conta manual que **não** era a mesma retirada e deixar de lançar uma retirada real. | Baixo | A prévia mostra a conta já lançada (descrição) ao lado, para a pessoa reconhecer; dá para lançar à mão. |
| Lançar retiradas de um período já conferido e mexer no resultado. | Médio | Competência homologada recusa; a confirmação diz o valor total e que entra na DRE. |
| Descrição genérica nas contas novas. | Baixo | Editável depois. |
| Mais de um caixa físico na unidade. | Baixo | A função se recusa e explica. |

## Plano e checklist (nenhum passo executado; exige autorização)

1. Revisão do PR; push; PR; merge (deploy automático do Render).
2. Em produção, **com o usuário presente**: abrir a importação já confirmada (ou importar o relatório), conferir a prévia: as retiradas
   já lançadas à mão devem aparecer como "já lançadas à mão" e as demais como "novas".
3. Anotar a DRE (Outras despesas) antes; lançar; conferir que subiu **só** pelo total das novas.
4. Conferir o Contas a Pagar e o calendário (dia da retirada com "Sangrias · Pago") e o saldo do Caixa da loja.

Reversão: reverter o merge desfaz a função. As contas já criadas continuam como contas pagas normais (podem ser estornadas pelos
caminhos existentes de estorno/cancelamento, com justificativa).
