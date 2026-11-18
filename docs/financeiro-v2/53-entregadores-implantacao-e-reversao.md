# Financeiro v2 — 53. Entregadores Próprios: implantação e reversão

Cada passo exige autorização própria. Valores e nomes reais ficam fora deste repositório.

## Antes de começar

- [ ] Pendências financeiras da seção "Decisões" resolvidas pelo responsável.
- [ ] Sincronização da Foody aplicou as decisões de triagem dos últimos 35 dias.
- [ ] As 28 decisões antigas de triagem seguem fora desta implantação, até reconciliação específica.
- [ ] Backup do banco confirmado.
- [ ] `origin/main` comparada de novo com a branch e testes repetidos.

## Implantação

| # | Passo | Conferência | Reversão |
|---|---|---|---|
| 1 | Abrir PR, revisar e fazer merge com as variáveis novas ausentes | Plataforma e Financeiro abrem normalmente; agendador informa "DESLIGADO" | Reverter o merge |
| 2 | Aplicar `database/financeiro-v2/producao/atualizar.sql` (0026) | 26 migrações registradas; duas tabelas novas com RLS forçada | Código anterior ignora as tabelas; não apagar dados |
| 3 | Conferir o catálogo Foody `2026-11-18.2` em uma sincronização | Sem novos pedidos Subway em revisão | Reverter o commit do catálogo |
| 4 | Criar o bucket com `preparar-bucket-notas.sql` | `public = false`, 10 MiB, PDF/PNG/JPEG | Remover `FV2_ENTREGADORES_COFRE_ACEITO`; manter arquivos |
| 5 | Definir `FV2_ENTREGADORES_BUCKET` e `FV2_ENTREGADORES_COFRE_ACEITO=1` | Envio e download de uma nota de teste autorizada | Remover as variáveis |
| 6 | Registrar no parser as correções de taxa aprovadas e fechar 26/10, 02/11 e 09/11 por reconciliação manual, conferindo a prévia | Contas iguais à relação aprovada, sem saída nova no banco | Cancelar a conta pelo fluxo auditado, nunca apagar |
| 7 | Reconhecer e vincular os PIX já pagos | Pago, parcial e aberto iguais ao relatório | Estornar a liquidação pelo fluxo existente |
| 8 | Gerar a concessão com `sqlConcessaoDeAutomacao` (ver + registrar, só Açaí Saci) | Identidade sem nenhuma outra ação | Revogar a concessão |
| 9 | Definir `FV2_ENTREGADORES_INICIO=2026-11-23` e `FV2_ENTREGADORES_UNIDADES` | Variáveis conferidas | Remover as variáveis |
| 10 | Ligar `FV2_ENTREGADORES_AGENDADOR_HABILITADO=1` | Primeiro fechamento em 30/11, a partir das 06h | Desligar a variável |

## Decisões financeiras pendentes

1. Taxas de três pedidos manuais que estavam na planilha do Subway: confirmar se já foram pagas.
2. Beneficiário dos pagamentos feitos por PIX a outra pessoa.
3. Notas das 16 contas já pagas: dispensar ou cobrar.

## Regras que não mudam

- Criar conta não paga nada e não movimenta banco.
- Semana anterior a `FV2_ENTREGADORES_INICIO` nunca fecha sozinha.
- A identidade técnica não movimenta dinheiro, não dá baixa e não altera permissões.
- Sem antivírus, o arquivo enviado fica retido até conferência humana e só sai como download autorizado.
