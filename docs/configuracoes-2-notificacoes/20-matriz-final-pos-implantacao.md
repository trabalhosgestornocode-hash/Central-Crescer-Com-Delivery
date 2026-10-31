# 20 — Matriz final pós-implantação (31/10/2026)

PR #55 em produção (`4526e8a`), migrations 132–136 aplicadas (18/18). Esta rodada: verificação por leitura, correções em branch isolada
(`fix/configuracoes-2-pos-implantacao`, commit `cf9cdaa`, **não publicada**), regressão completa.

## Regressão (código final × `main` mesclada `4526e8a`, mesmo dia)

| Suíte | Branch | `main` | Observação |
|---|---|---|---|
| Backend | 5784 / 24 falhas | 5756 / 26 falhas | **0 falhas só da branch**. Falhas comuns: testes de calendário (conciliação "só meses fechados" no fim do mês) e as 14 conhecidas. As 2 só da `main` são quedas nativas intermitentes (`whatsapp-retry-*`) |
| Frontend | 1649 / 0 falhas | — | |
| Navegador (Chrome) | 126/127 | — | a falha (`parserFoodDelivery` "dia único") é anterior a esta frente |
| PostgreSQL descartável (cadeia real da main + 132–136) | **103/103** | — | + OTP expirado, convite vencido/cancelado, limites por número e IP |

## Defeitos encontrados e corrigidos (branch isolada)

1. Aviso contraditório na Central indisponível ("indisponível" × "convites podem ser criados").
2. `NODE_ENV` ausente era tratado como desenvolvimento (simulação de OTP e links pelo `Host`) → agora **fail-closed**: só `development`/`test` explícitos. (O Render injeta `NODE_ENV=production` por padrão; a variável não aparece na lista de variáveis do painel.)
3. A origem do link era resolvida antes da checagem de alcance do gerente (503 antes de 403) → resolvida depois das validações e antes de qualquer leitura/gravação.

## D-1 e produção (leitura, 31/10 ~11:00 BRT)

Os 41 destinatários (`5c5835a8…`), funções de referência, cota e permissões iguais; D-1 equivalente nas 48 unidades; M3 ausente; 0 linhas nas tabelas novas;
`/health` 200 com `ifoodEvents` ativo. **Lote de hoje: 8 mensagens agendadas para 11:35–11:59 BRT — verificação agendada para 12:17; PENDENTE (sem PASS antecipado).**
Lote de segunda (10h/11h): verificação agendada para 02/11 11:47.

## Matriz

| Funcionalidade | Implementada | Homologada | Ativa em produção | Dependência restante | Resultado |
|---|---|---|---|---|---|
| Migrations 132–136 (histórico 30) | sim | teste remoto + local + produção 18/18 | sim | — | **PASS** |
| Configurações 2.0 — 7 categorias, salvamento, validação | sim | navegador real (9 testes, 4 perfis, 390 px, escuro) + conferência da interface publicada | sim | teste logado por perfil em produção | **PASS** (produção: só leitura como Administrador da plataforma) |
| Permissões D-3 / isolamento por unidade | sim | HTTP negativo, PG, matriz | sim | — | **PASS** |
| Dados da unidade, metas, Tabelas Comerciais | sim | testes + navegador | sim | — | **PASS** |
| Fuso e horário por unidade (campos) | sim | PG 84→103, testes (virada de dia, SP × Porto Velho, PDF/Excel) | campos sim; **regra desligada** | data de corte (decisão) | **PASS** / desligado |
| Fechamento × Dashboard 2.0 (mesmos números) | sim | 15/15 estritos, sintéticos | sim | produção só tem 1 fechamento PRELIMINAR manual | **PASS** (sintético) / dado real **BLOQUEADO** |
| Prévia WhatsApp do fechamento (simulada) | sim | mesmos dados do fechamento; cota só lida | simulação | envio real: provedor oficial | **PASS** / desligado |
| Central — consulta (destinatários, histórico, auditoria) | sim | navegador + HTTP + leitura em produção | sim (modo consulta) | — | **PASS** |
| Central — convites, suspensão, revogação registrada | sim | PG + serviços + navegador | **desligada** (sem segredo) | `NOTIFICACOES_SEGREDO_MESTRE`, `APP_URL_PUBLICA` | **PASS** / desligado |
| OTP + consentimento (simulado) | sim | PG: uso único, 5 tentativas, 60 s, 5 min, concorrência, replay, termo, expirados, limites | **desligado** | provedor oficial, termo jurídico | **PASS** (simulação) / OTP real **BLOQUEADO** |
| Revogação do titular e fila | sim | PG (cancela fila, não reativa) | — | — | **PASS** |
| Palavra de saída (SAIR) | sim | testes | desligada | inbound do WhatsApp parado | **BLOQUEADO** |
| Convite de usuário por e-mail | sim | testes (sem SMTP = 409, falha revoga) | sem SMTP | SMTP + `USUARIOS_CONVITE_EMAIL` + redirect com `#t=` | **BLOQUEADO** (não homologado) |
| Legados `LEGACY_ACTIVE` / snapshot D-16 | sim | PG (M3 em banco descartável) | M3 **desligada** | decisão de ativação | **PASS** / desligado |
| Monitoramento do D-1 | — | agendado | — | lotes de 31/10 e 02/11 | **PENDENTE** |

## A — Concluídas e operacionais
Migrations/histórico; Configurações 2.0 (7 categorias) e permissões; dados da unidade, metas e tabelas; Central em modo consulta; D-1 preservado.

## B — Concluídas tecnicamente, desligadas por decisão
M3 e snapshot; fuso por unidade (regra de corte); fechamento e prévia WhatsApp em simulação; Central de escrita; OTP simulado.

## C — Dependem de credencial, provedor ou autorização
1. **Variáveis no Render** (uma autorização consolidada, abaixo).
2. **SMTP + `USUARIOS_CONVITE_EMAIL`** para convite de usuário (conta nova hoje é recusada com 409 e criada pelo Painel SuperAdmin).
3. **Provedor oficial de WhatsApp + texto jurídico do termo** para OTP real.
4. **Inbound do WhatsApp** para a palavra SAIR.
5. **Data de corte do fuso** (decisão).

## D — Falhas reais que impedem o encerramento
Nenhuma falha de produto. Não encerrado por: (a) verificação do lote real do D-1 pendente; (b) teste logado por perfil em produção **não feito** (sem contas de teste autorizadas; foram usados o ambiente isolado com os 4 perfis e a conferência de leitura); (c) convites por e-mail e OTP real não homologáveis sem SMTP/provedor; (d) as correções desta rodada ainda não foram publicadas.

## Autorização consolidada pedida (Fase 3)
Definir no Render (serviço `crescercomdelivery`): `APP_URL_PUBLICA=https://centralcrescercomdelivery.com.br` e `NOTIFICACOES_SEGREDO_MESTRE` (≥32 caracteres aleatórios gerados no navegador, nunca exibidos; não reutiliza `IFOOD_TOKEN_SECRET`). Redeploy automático da própria variável.
**Efeito:** gestores passam a criar convites de destinatário (links) e registrar revogações; o titular abre o link, mas **não consegue verificar** (transporte de OTP desligado → "indisponível"), então nada é consentido nem enviado; D-1, M3 e envios não mudam.
**Risco:** convites ficam pendentes (72 h). **Recuperação:** remover as duas variáveis (a Central volta ao modo consulta). Guardar o segredo no gerenciador de senhas do responsável: sem ele, convites criados ficam ilegíveis.
Recomendado publicar antes as correções de `cf9cdaa` (PR próprio).
